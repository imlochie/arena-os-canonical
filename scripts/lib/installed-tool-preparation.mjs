/** Offline-only repair after npm ci --ignore-scripts. Never downloads binaries,
 * invokes npm lifecycle hooks generally, or imports Electron/ONNX installers. */
import { existsSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function prepareInstalledNativeTools(root, { platform = process.platform, arch = process.arch } = {}) {
  const results = [];
  const pgPlatform = platform === "win32" ? "windows" : platform;
  const pg = path.join(root, "node_modules", "@embedded-postgres", `${pgPlatform}-${arch}`);
  if (existsSync(path.join(pg, "scripts", "hydrate-symlinks.js"))) {
    execFileSync(process.execPath, ["scripts/hydrate-symlinks.js"], { cwd: pg, stdio: "pipe" });
    results.push(`@embedded-postgres/${pgPlatform}-${arch}: symlinks hydrated`);
  }
  if (platform !== "win32") for (const tool of ["ffmpeg", "ffprobe"]) {
    const binary = path.join(root, "node_modules", `@${tool}-installer`, `${platform}-${arch}`, tool);
    if (!existsSync(binary)) continue;
    // Preserve the rest of the mode; chmod +x must not remove read/group bits.
    const { mode } = statSync(binary);
    chmodSync(binary, mode | 0o100);
    results.push(`${tool}: executable permission prepared`);
  }
  return results;
}
