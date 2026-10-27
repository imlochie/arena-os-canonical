import path from "node:path";

// Retains the original desktop's data directory and portable opt-in convention.
export function dataRoot({ env = process.env, exeDir, exists, platform = process.platform }) {
  const ops = platform === "win32" ? path.win32 : path;
  if (env.ARENA_DATA_DIR) {
    if (!ops.isAbsolute(env.ARENA_DATA_DIR)) throw new Error("ARENA_DATA_DIR must be absolute");
    return ops.resolve(env.ARENA_DATA_DIR);
  }
  if (exeDir && exists?.(ops.join(exeDir, "arena.portable"))) return ops.join(exeDir, "arena-data");
  if (platform === "win32" && env.LOCALAPPDATA) return ops.join(env.LOCALAPPDATA, "Arena");
  throw new Error("Cannot find desktop app data; set ARENA_DATA_DIR to an absolute writable directory");
}
