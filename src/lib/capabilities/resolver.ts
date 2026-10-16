/**
 * Capability resolver - the single place external executables are located.
 *
 * Order for every tool:
 *   1. explicit env override (ARENA_<TOOL>_PATH style) - owner decision
 *   2. bundled: ARENA_APP_BIN_DIR (the packaged app's bin/) plus any extra
 *      bundled dirs the caller names
 *   3. system PATH - secondary, always labelled "system" so diagnostics can
 *      say the tool is NOT part of the install
 *
 * Results are absolute paths. A bare command name is never returned, so a
 * packaged app cannot silently depend on whatever happens to be first on PATH
 * at spawn time.
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type CapabilitySource = "env" | "bundled" | "system";

export interface ResolvedExecutable {
  name: string;
  path: string;
  source: CapabilitySource;
  /** Human label for diagnostics. */
  label: string;
}

export interface ResolveOptions {
  /** Env var holding an explicit absolute path (tier 1). */
  envVar?: string;
  /** Extra bundled directories searched after ARENA_APP_BIN_DIR. */
  bundledDirs?: string[];
  /** Set false to forbid the system PATH tier (bundled-only tools). */
  allowSystem?: boolean;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
}

const LABELS: Record<CapabilitySource, string> = {
  env: "explicit override",
  bundled: "bundled with Arena",
  system: "system fallback (not bundled)",
};

function defaultIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  return /\.(exe|com)$/i.test(name) ? [name] : [`${name}.exe`, `${name}.com`];
}

/** Search PATH and return the absolute path of the first match, or null. */
export function findOnPath(name: string, options: Pick<ResolveOptions, "env" | "platform" | "isFile"> = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const raw = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  for (const dir of raw.split(sep)) {
    const cleaned = dir.trim().replace(/^"|"$/g, "");
    // Relative PATH entries (including "") would resolve against the CWD.
    if (cleaned === "" || !isAbsolute(cleaned)) continue;
    for (const file of fileNames(name, platform)) {
      const candidate = join(cleaned, file);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveExecutable(name: string, options: ResolveOptions = {}): ResolvedExecutable | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const make = (path: string, source: CapabilitySource): ResolvedExecutable => ({ name, path, source, label: LABELS[source] });

  const override = options.envVar ? env[options.envVar]?.trim() : undefined;
  if (override && isAbsolute(override) && isFile(override)) return make(override, "env");

  const dirs = [env.ARENA_APP_BIN_DIR?.trim(), ...(options.bundledDirs ?? [])].filter((d): d is string => !!d && isAbsolute(d));
  for (const dir of dirs) {
    for (const file of fileNames(name, platform)) {
      const candidate = join(dir, file);
      if (isFile(candidate)) return make(candidate, "bundled");
    }
  }

  if (options.allowSystem === false) return null;
  const onPath = findOnPath(name, { env, platform, isFile });
  return onPath === null ? null : make(onPath, "system");
}
