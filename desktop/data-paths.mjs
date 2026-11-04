import path from "node:path";

export const ARENA_WAVEYARD_BACKUP_PARTS = [
  {
    id: "storage",
    label: "Waveyard library audio and stems",
    description: "Original library audio and separated stem files.",
    relativePath: "waveyard/storage",
  },
  {
    id: "capture",
    label: "Waveyard capture recordings",
    description: "Audio files created by Waveyard's capture tool.",
    relativePath: "waveyard/capture",
  },
];

export const ARENA_BACKUP_SCOPES = [
  {
    id: "waveyard-storage",
    label: "Waveyard audio, stems, and capture recordings",
    relativePath: "waveyard/storage",
  },
  {
    id: "waveyard-models",
    label: "Downloaded Waveyard models",
    relativePath: "waveyard/models",
  },
  {
    id: "workspace-files",
    label: "Workspace files",
    relativePath: "data/space-workspaces",
  },
  {
    id: "browser-profiles",
    label: "Browser profiles",
    relativePath: "data/space-workspaces",
  },
];

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
