/**
 * Repo-root resolution that is correct on Windows.
 *
 * `new URL(import.meta.url).pathname` is the classic Windows trap: it yields
 * `/C:/Projects/...` (leading slash before the drive letter) and keeps
 * percent-encoding (`%20` for spaces), which then produces paths like
 * `C:\C:\Projects\...` or broken spaced paths. fileURLToPath exists for
 * exactly this.
 *
 * For scripts that live directly in scripts/, the repo root is one level up.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export function repoRootFromMeta(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}
