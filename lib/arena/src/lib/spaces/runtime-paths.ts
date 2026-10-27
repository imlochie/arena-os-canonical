import path from "node:path";

/** Desktop state must never be written beside an installed executable or in app.asar. */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  cwd = process.cwd(),
): string {
  const ops = platform === "win32" ? path.win32 : path.posix;
  const root = env.ARENA_DATA_DIR
    || (platform === "win32" && env.LOCALAPPDATA ? ops.join(env.LOCALAPPDATA, "Arena") : undefined);
  if (root) {
    if (!ops.isAbsolute(root)) throw new Error("ARENA_DATA_DIR must be absolute");
    return ops.join(root, "data", "space-workspaces");
  }
  if (platform === "win32") throw new Error("No writable desktop data directory: set ARENA_DATA_DIR or LOCALAPPDATA");
  return ops.resolve(cwd, ".data", "space-workspaces");
}

export function configuredChromiumPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | undefined {
  const ops = platform === "win32" ? path.win32 : path.posix;
  const file = env.CHROMIUM_PATH || (env.ARENA_RESOURCES_DIR
    ? ops.join(env.ARENA_RESOURCES_DIR, "chromium", platform === "win32" ? "chrome.exe" : "chrome")
    : undefined);
  if (file && !ops.isAbsolute(file)) throw new Error("CHROMIUM_PATH must be absolute");
  return file;
}
