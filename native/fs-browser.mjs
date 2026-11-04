/** 服务器文件浏览器（设计见 pi-web-design.md §28）。
 *
 *  只读、只给本机浏览器用。安全模型是三件事：
 *    ① **Host 白名单**：只接受 127.0.0.1 / localhost / [::1]（带端口也行）——挡 DNS rebinding；
 *    ② **每次启动随机的 FS_TOKEN**：页面 HTML 里注入，所有 /fs/* 请求必须带 `x-pi-web-fs-token`，
 *       跨站网页读不到页面内容 → 拿不到 token（本模块与桥接侧信道用的 TOKEN 分开，缩小泄露面）；
 *    ③ **内容类型降级**：文本一律 text/plain + nosniff，只有位图/PDF 才给可内联的类型 ——
 *       否则磁盘上的 .html/.svg 会在同源下执行，进而读到 token 再读全盘。
 *
 *  访问范围：整个文件系统（用户 2026-11-03 决定），但**只读**，且拒绝设备/管道等非普通文件。
 */
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

/** 文本预览上限：超过只回前 2 MB（页面提示可下载）。 */
const TEXT_LIMIT = 2 * 1024 * 1024;
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
            `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'`,
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
        sendJson(res, 200, {
          path: target,
          size,
          truncated: size > length,
          binary,
          text: binary ? "" : slice.toString("utf8"),
        });
      } catch (err) {
        sendJson(res, 404, { error: err.code === "ENOENT" ? "not found" : err.message, path: target });
      }
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
