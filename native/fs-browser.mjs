/** 服务器文件浏览器（设计见 pi-web-design.md §28）。
 *
 *  只读、只给本机浏览器用。安全模型是三件事：
 *    ① **Host 白名单**：只接受 127.0.0.1 / localhost / [::1]（带端口也行）——挡 DNS rebinding；
 *    ② **每次启动随机的 FS_TOKEN**：页面 HTML 里注入，所有 /fs/* 请求必须带 `x-pi-web-fs-token`，
 *       跨站网页读不到页面内容 → 拿不到 token（本模块与桥接侧信道用的 TOKEN 分开，缩小泄露面）；
 *    ③ **内容类型降级**：文本一律 text/plain + nosniff，只有位图/PDF 才给可内联的类型 ——
 *       否则磁盘上的 .html/.svg 会在同源下执行，进而读到 token 再读全盘。
 *
 *  访问范围：整个文件系统（用户 2026-11-03 决定），且拒绝设备/管道等非普通文件。
 *
 *  写能力（设计 §31）：`POST /fs/save` 只改**已存在的文本文件**，`.git/` 下禁止写，
 *  冲突靠 baseSha1 检测（不一致 → 409），写盘走同目录临时文件 + rename 的原子写。
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

/** 文本预览上限：超过只回前 2 MB（页面提示可下载）。 */
const TEXT_LIMIT = 2 * 1024 * 1024;
/** 保存请求体上限（utf8 文本 2 MB → JSON 转义后可能翻倍，留 4 MB）。 */
const BODY_LIMIT = 4 * 1024 * 1024;

/** 单目录产物上限：超过就截断，避免一次渲染几万个条目。 */
const DIR_LIMIT = 2000;

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

/** Host 头必须是本机名（挡 DNS rebinding）。 */
function hostAllowed(req) {
  const host = String(req.headers.host ?? "").toLowerCase();
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

const sha1Of = (buf) => createHash("sha1").update(buf).digest("hex");

/** 路径是否落在 `.git` 目录里（任一段为 .git）——写操作一律拒绝。 */
function inGitDir(target) {
  return target.split(sep).includes(".git");
}

/** 读请求体并解析 JSON（超限抛 code=too-large）。 */
function readJsonBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("request body too large");
        err.code = "too-large";
        req.destroy();
        rejectPromise(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        rejectPromise(new Error("invalid JSON body"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** 相对路径按会话 cwd 解析；返回规范化后的绝对路径。 */
function resolveTarget(rawPath, cwd) {
  const text = String(rawPath ?? "").trim();
  if (!text) return resolve(cwd);
  return resolve(text.startsWith("/") ? text : resolve(cwd, text));
}

/** 读目录（目录在前，名称排序；符号链接单独标注，避免 dangling 报错）。 */
async function listDir(target) {
  const dirents = await fsp.readdir(target, { withFileTypes: true });
  const entries = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= DIR_LIMIT) {
      truncated = true;
      break;
    }
    const full = resolve(target, dirent.name);
    let size = null;
    let mtime = null;
    let isDir = dirent.isDirectory();
    let link = dirent.isSymbolicLink();
    try {
      const st = await fsp.stat(full); // 跟随符号链接（想看链接指向的真实类型）
      size = st.size;
      mtime = st.mtimeMs;
      isDir = st.isDirectory();
    } catch {
      /* dangling 符号链接：保留名字，不显示大小 */
    }
    entries.push({ name: dirent.name, dir: isDir, size, mtime, link });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "en") : a.dir ? -1 : 1));
  return { entries, truncated };
}

/**
 * 创建路由处理函数：命中本模块的路由返回 true，其余交回调用方。
 * @param {{ token: string, getCwd: () => string }} options
 */
export function createFsBrowser({ token, getCwd }) {
  return async function handleFsRequest(req, res, url) {
    const route = url.pathname;
    const isFilesPage = route === "/files" || route === "/files/";
    if (!isFilesPage && !route.startsWith("/fs/")) return false;

    if (!hostAllowed(req)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden: bad host");
      return true;
    }

    if (isFilesPage) {
      // 页面本身不需要 token（token 在页面里），但同样受 Host 白名单保护
      try {
        const staticsDir = resolve(dirname(new URL(import.meta.url).pathname), "..", "static");
        const html = await fsp.readFile(resolve(staticsDir, "files.html"), "utf8");
        // 页内只有一行内联脚本（注入 token）→ 用 nonce 放行，不开 'unsafe-inline'
        const nonce = randomBytes(12).toString("base64");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            // img-src 必须含 blob:：图片是 fetch（带 token）→ createObjectURL 再给 <img> 的（§29.3）
            `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'`,
        });
        res.end(html.replaceAll("__PI_WEB_FS_TOKEN_VALUE__", token).replaceAll("__PI_WEB_FS_NONCE__", nonce));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`files.html missing: ${err.message}`);
      }
      return true;
    }

    // 其余 /fs/* 一律要 token
    if (req.headers["x-pi-web-fs-token"] !== token) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }

    const target = resolveTarget(url.searchParams.get("path"), getCwd());

    if (route === "/fs/list") {
      try {
        const st = await fsp.stat(target);
        if (!st.isDirectory()) {
          sendJson(res, 400, { error: "not a directory", path: target });
          return true;
        }
        const { entries, truncated } = await listDir(target);
        sendJson(res, 200, {
          path: target,
          parent: target === sep ? null : dirname(target),
          entries,
          truncated,
        });
      } catch (err) {
        sendJson(res, 404, { error: err.code === "ENOENT" ? "not found" : err.message, path: target });
      }
      return true;
    }

    if (route === "/fs/text") {
      try {
        const st = await fsp.stat(target);
        if (st.isDirectory()) {
          sendJson(res, 400, { error: "is a directory", path: target });
          return true;
        }
        if (!st.isFile()) {
          sendJson(res, 400, { error: "not a regular file", path: target });
          return true;
        }
        const size = st.size;
        const length = Math.min(size, TEXT_LIMIT);
        const buf = Buffer.allocUnsafe(length);
        const handle = await fsp.open(target, "r");
        let filled = 0;
        try {
          while (filled < length) {
            const { bytesRead } = await handle.read(buf, filled, length - filled, filled);
            if (bytesRead <= 0) break;
            filled += bytesRead;
          }
        } finally {
          await handle.close();
        }
        const slice = buf.subarray(0, filled);
        const binary = slice.subarray(0, 8192).includes(0);
        const truncated = size > length;
        // 可编辑判定（§31）：仅普通文本文件、未被截断、不在 .git 下
        const editReason = binary
          ? "二进制文件"
          : truncated
            ? `文件超过 ${Math.round(TEXT_LIMIT / 1024 / 1024)} MB`
            : inGitDir(target)
              ? ".git 目录下不允许写"
              : null;
        sendJson(res, 200, {
          path: target,
          size,
          truncated,
          binary,
          text: binary ? "" : slice.toString("utf8"),
          sha1: sha1Of(slice),
          mtimeMs: st.mtimeMs,
          editable: editReason === null,
          editReason,
        });
      } catch (err) {
        sendJson(res, 404, { error: err.code === "ENOENT" ? "not found" : err.message, path: target });
      }
      return true;
    }

    if (route === "/fs/save") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req, BODY_LIMIT);
      } catch (err) {
        sendJson(res, err.code === "too-large" ? 413 : 400, { error: err.message });
        return true;
      }
      const rawPath = body?.path;
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        sendJson(res, 400, { error: "missing path" });
        return true;
      }
      const target = resolveTarget(rawPath, getCwd());
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        sendJson(res, 404, { error: err.code === "ENOENT" ? "not found" : err.message, path: target });
        return true;
      }
      if (!st.isFile()) {
        sendJson(res, 400, { error: "not a regular file", path: target });
        return true;
      }
      if (st.size > TEXT_LIMIT) {
        sendJson(res, 400, { error: "file too large to edit", path: target });
        return true;
      }
      // 写符号链接要写到**目标文件**，否则 rename 会把这个链接本身替换掉
      let real = target;
      try {
        real = await fsp.realpath(target);
      } catch {
        /* 用原路径 */
      }
      if (inGitDir(real)) {
        sendJson(res, 403, { error: "refusing to write inside .git", path: real });
        return true;
      }
      const current = await fsp.readFile(real);
      const currentSha1 = sha1Of(current);
      const baseSha1 = typeof body.baseSha1 === "string" ? body.baseSha1 : null;
      const force = body.force === true;
      if (!force && baseSha1 && baseSha1 !== currentSha1) {
        const currentBinary = current.subarray(0, 8192).includes(0);
        sendJson(res, 409, {
          error: "conflict",
          path: real,
          sha1: currentSha1,
          size: st.size,
          mtimeMs: st.mtimeMs,
          text: currentBinary ? "" : current.toString("utf8"),
          binary: currentBinary,
        });
        return true;
      }
      let text = body?.text;
      if (typeof text !== "string") {
        sendJson(res, 400, { error: "missing text" });
        return true;
      }
      if (Buffer.byteLength(text, "utf8") > TEXT_LIMIT) {
        sendJson(res, 413, { error: "text too large" });
        return true;
      }
      const origText = current.toString("utf8");
      // 行尾沿用：原文 CRLF 而提交内容全为 LF（<textarea> 会归一化）→ 转回 CRLF，否则整文件 diff 被污染
      if (origText.includes("\r\n") && !text.includes("\r")) text = text.replace(/\n/g, "\r\n");
      // BOM 沿用
      if (origText.charCodeAt(0) === 0xfeff && text.charCodeAt(0) !== 0xfeff) text = "\ufeff" + text;
      const buf = Buffer.from(text, "utf8");
      // 原子写：同目录临时文件 → fsync → rename
      const tmp = `${real}.pi-web-${randomBytes(6).toString("hex")}.tmp`;
      try {
        const handle = await fsp.open(tmp, "w", st.mode & 0o7777);
        try {
          await handle.writeFile(buf);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fsp.rename(tmp, real);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});
        sendJson(res, 500, { error: `save failed: ${err.message}`, path: real });
        return true;
      }
      const after = await fsp.stat(real);
      sendJson(res, 200, {
        ok: true,
        path: real,
        sha1: sha1Of(buf),
        size: after.size,
        mtimeMs: after.mtimeMs,
      });
      return true;
    }

    if (route === "/fs/raw") {
      let st;
      try {
        st = await fsp.stat(target);
      } catch (err) {
        sendJson(res, 404, { error: err.code === "ENOENT" ? "not found" : err.message, path: target });
        return true;
      }
      if (!st.isFile()) {
        sendJson(res, 400, { error: "not a regular file", path: target });
        return true;
      }
      const ext = extname(target).toLowerCase();
      const download = url.searchParams.get("download") === "1";
      const inlineType = IMAGE_MIME[ext] ?? (ext === ".pdf" ? "application/pdf" : null);
      // 关键：非图片/PDF 一律 octet-stream + attachment，绝不把 .html/.svg 当页面执行
      const type = inlineType && !download ? inlineType : "application/octet-stream";
      const disposition = inlineType && !download ? "inline" : "attachment";
      const encodedName = encodeURIComponent(target.split("/").pop() ?? "file");
      res.writeHead(200, {
        "content-type": type,
        "content-length": st.size,
        "content-disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      createReadStream(target).pipe(res);
      return true;
    }

    sendJson(res, 404, { error: "unknown fs route" });
    return true;
  };
}
