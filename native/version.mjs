/**
 * 读取本包版本号（`package.json` 的 version）。
 *
 * 两种布局都要能命中：
 *   发布布局：HERE=<dist>/native → <dist>/package.json
 *   仓库布局：HERE=<repo>/native → <repo>/pi-sdk-web/package.json
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function piWebVersion() {
  const candidates = [
    join(HERE, "..", "..", "package.json"),
    join(HERE, "..", "pi-sdk-web", "package.json"),
    join(HERE, "..", "package.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const version = JSON.parse(readFileSync(file, "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch {
      /* 试下一个候选 */
    }
  }
  return "dev";
}
