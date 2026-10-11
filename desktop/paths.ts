/**
 * Arena data-directory resolution — pure, platform-correct, no Electron.
 *
 * Resolution order:
 *   1. ARENA_DATA_DIR env override (must be absolute — validated)
 *   2. Portable mode: an `arena.portable` marker beside the executable
 *      keeps data beside the app (opt-in only, never accidental)
 *   3. Platform default (Windows: %LOCALAPPDATA%\Arena)
 *
 * The waveyard storage containment bug (forward-slash checks on backslash
 * paths) is the canonical reason this module exists: every path decision
 * here is unit-tested with real win32 semantics on any host.
 */

import path from "node:path";

export interface PathOps {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  isAbsolute: (p: string) => boolean;
}

export const nativePathOps: PathOps = {
  join: path.join,
  resolve: path.resolve,
  isAbsolute: path.isAbsolute,
};

export const PORTABLE_MARKER = "arena.portable";

export interface DataDirInputs {
  platform: string;
  env: Record<string, string | undefined>;
  /** Windows: %LOCALAPPDATA% (also read from env). */
  localAppData?: string;
  /** macOS: ~/Library/Application Support. */
  appDataHome?: string;
  /** Linux: $XDG_DATA_HOME (also read from env). */
  xdgDataHome?: string;
  homeDir?: string;
  /** Directory of the running executable — for portable marker detection. */
  exeDir?: string;
  fileExists?: (p: string) => boolean;
}

export type DataDirSource = "env" | "portable" | "platform";

export interface ArenaDataDirs {
  root: string;
  data: string;
  projects: string;
  waveyard: string;
  cache: string;
  logs: string;
  models: string;
  runtime: string;
  settings: string;
  portable: boolean;
  source: DataDirSource;
}

function withSubdirs(
  ops: PathOps,
  root: string,
  portable: boolean,
  source: DataDirSource,
): ArenaDataDirs {
  return {
    root,
    data: ops.join(root, "data"),
    projects: ops.join(root, "projects"),
    waveyard: ops.join(root, "waveyard"),
    cache: ops.join(root, "cache"),
    logs: ops.join(root, "logs"),
    models: ops.join(root, "models"),
    runtime: ops.join(root, "runtime"),
    settings: ops.join(root, "settings"),
    portable,
    source,
  };
}

export function resolveArenaDataDirs(
  inputs: DataDirInputs,
  ops: PathOps = nativePathOps,
): ArenaDataDirs {
  // 1. Explicit override wins — but never a relative path.
  const envDir = inputs.env.ARENA_DATA_DIR;
  if (envDir !== undefined && envDir !== "") {
    if (!ops.isAbsolute(envDir))
      throw new Error(
        `ARENA_DATA_DIR must be an absolute path (got: ${envDir})`,
      );
    return withSubdirs(ops, ops.resolve(envDir), false, "env");
  }

  // 2. Portable mode: marker file beside the executable, opt-in only.
  if (
    inputs.exeDir !== undefined &&
    inputs.fileExists?.(ops.join(inputs.exeDir, PORTABLE_MARKER)) === true
  ) {
    return withSubdirs(ops, ops.join(inputs.exeDir, "arena-data"), true, "portable");
  }

  // 3. Platform default.
  let base: string | undefined;
  if (inputs.platform === "win32") {
    base = inputs.env.LOCALAPPDATA ?? inputs.localAppData;
    if (base === undefined && inputs.homeDir !== undefined)
      base = ops.join(inputs.homeDir, "AppData", "Local");
    if (base !== undefined) return withSubdirs(ops, ops.join(base, "Arena"), false, "platform");
  } else if (inputs.platform === "darwin") {
    base = inputs.appDataHome;
    if (base === undefined && inputs.homeDir !== undefined)
      base = ops.join(inputs.homeDir, "Library", "Application Support");
    if (base !== undefined) return withSubdirs(ops, ops.join(base, "Arena"), false, "platform");
  } else {
    base = inputs.env.XDG_DATA_HOME ?? inputs.xdgDataHome;
    if (base === undefined && inputs.homeDir !== undefined)
      base = ops.join(inputs.homeDir, ".local", "share");
    if (base !== undefined) return withSubdirs(ops, ops.join(base, "arena"), false, "platform");
  }

  throw new Error(
    "Could not determine an Arena data directory: no ARENA_DATA_DIR, no portable marker, and no platform home/localappdata location.",
  );
}
