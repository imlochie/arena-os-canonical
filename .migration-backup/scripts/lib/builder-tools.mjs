/**
 * electron-builder toolset cache seeding (offline Windows packaging).
 *
 * electron-builder downloads its build toolchains (NSIS, winCodeSign) from
 * github.com at BUILD time. On networks where those transfers die
 * mid-flight ("socket hang up"), the build cannot produce an installer —
 * even though everything else (Electron dist, signing) is already local.
 *
 * app-builder-lib (verified against the installed 26.15.3 source,
 * out/util/electronGet.js `downloadAndExtract`) checks a PREDICTABLE
 * archive cache before touching the network:
 *
 *   <cacheRoot>/<releaseName>/<filename>     e.g.
 *   %LOCALAPPDATA%\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1.7z
 *
 * If the archive is present AND its SHA-256 matches the checksum
 * app-builder-lib enforces, the download is skipped entirely and
 * electron-builder unpacks + validates it with its own machinery. Seeding
 * that file is therefore exactly as trustworthy as the normal download —
 * same checksums, same extraction, same cache-state bookkeeping. Nothing
 * is bypassed or disabled.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Toolchain archives app-builder-lib 26.15.3 requests for a Windows NSIS
 *  build (checksums from out/toolsets/windows.js — cross-checked at runtime
 *  by assertTableMatchesInstalledLib). */
export const KNOWN_TOOLS = {
  "nsis-3.0.4.1.7z": {
    releaseName: "nsis-3.0.4.1",
    sha256: "9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa",
    purpose: "NSIS compiler toolchain (the installer itself)",
  },
  "nsis-resources-3.4.1.7z": {
    releaseName: "nsis-resources-3.4.1",
    sha256: "593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103",
    purpose: "NSIS resources (dialogs, localization)",
  },
  "winCodeSign-2.6.0.7z": {
    releaseName: "winCodeSign-2.6.0",
    sha256: "cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4",
    purpose: "Windows code-signing tools (rcedit/signing helpers)",
  },
};

/** Where to obtain each archive (browser download usually succeeds where
 *  Node's fetch is cut off mid-transfer). */
export const TOOL_SOURCE_URLS = {
  "nsis-3.0.4.1.7z": "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z",
  "nsis-resources-3.4.1.7z": "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z",
  "winCodeSign-2.6.0.7z": "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z",
};

export class ToolSeedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolSeedError";
  }
}

/** Mirrors app-builder-lib's getCacheDirectory (out/util/electronGet.js).
 *  Path semantics follow the TARGET platform (not the host), so Windows
 *  behavior is correct even when computed from Linux (tests, WSL). */
export function builderCacheRoot({ platform = process.platform, env = process.env } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = env.ELECTRON_BUILDER_CACHE?.trim();
  if (override !== undefined && override !== "" && paths.parse(override).root) return override;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData === undefined || localAppData === "") {
      return paths.join(os.tmpdir(), "electron-builder-cache");
    }
    return paths.join(localAppData, "electron-builder", "Cache");
  }
  if (platform === "darwin") {
    return paths.join(env.HOME ?? os.homedir(), "Library", "Caches", "electron-builder");
  }
  const xdg = env.XDG_CACHE_HOME;
  return xdg !== undefined && xdg !== "" && paths.parse(xdg).root
    ? paths.join(xdg, "electron-builder")
    : paths.join(env.HOME ?? os.homedir(), ".cache", "electron-builder");
}

export async function sha256File(file) {
  const h = createHash("sha256");
  h.update(await readFile(file));
  return h.digest("hex");
}

/**
 * Verify + place one toolchain archive into electron-builder's archive
 * cache. Throws ToolSeedError for unknown names and checksum mismatches
 * (a mid-flight-cut download produces a truncated file — fail loudly
 * instead of letting electron-builder silently delete it and retry the
 * network).
 */
export async function seedArchive(file, { cacheRoot = builderCacheRoot(), table = KNOWN_TOOLS } = {}) {
  const name = path.basename(file);
  const tool = table[name];
  if (tool === undefined) {
    throw new ToolSeedError(
      `unknown tool archive "${name}" — expected one of: ${Object.keys(table).join(", ")}`,
    );
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ToolSeedError(`not a file: ${file}`);
  }
  const actual = await sha256File(file);
  if (actual !== tool.sha256) {
    throw new ToolSeedError(
      `checksum mismatch for ${name}\n  expected ${tool.sha256}\n  actual   ${actual}\n` +
        "The archive is truncated or altered — re-download it (see the printed source URLs).",
    );
  }
  const archiveCachePath = path.join(cacheRoot, tool.releaseName, name);
  mkdirSync(path.dirname(archiveCachePath), { recursive: true });
  copyFileSync(file, archiveCachePath);
  return { name, releaseName: tool.releaseName, archiveCachePath };
}

/** Which expected tools are seeded (archive cached) / extracted (unpacked
 *  dir present), for humans and the acceptance report. */
export function toolStatus(cacheRoot = builderCacheRoot(), table = KNOWN_TOOLS) {
  return Object.entries(table).map(([name, tool]) => {
    const releaseDir = path.join(cacheRoot, tool.releaseName);
    const archiveSeeded = existsSync(path.join(releaseDir, name));
    const extracted =
      existsSync(releaseDir) &&
      readdirSync(releaseDir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && entry.name !== `${name}.tmp`,
      );
    return { name, releaseName: tool.releaseName, purpose: tool.purpose, archiveSeeded, extracted };
  });
}

/** Guard against drift: every checksum in our table must literally appear
 *  in the installed app-builder-lib source that requests these archives.
 *  If app-builder-lib is upgraded and its tool versions change, seeding a
 *  stale archive would be deleted by electron-builder at build time — this
 *  check makes the mismatch impossible to miss. */
export async function assertTableMatchesInstalledLib(root, table = KNOWN_TOOLS) {
  const libFile = path.join(root, "node_modules", "app-builder-lib", "out", "toolsets", "windows.js");
  if (!existsSync(libFile)) {
    throw new ToolSeedError(`app-builder-lib not found at ${libFile} — run npm install`);
  }
  const source = await readFile(libFile, "utf8");
  const drifted = Object.entries(table).filter(([, tool]) => !source.includes(tool.sha256));
  if (drifted.length > 0) {
    throw new ToolSeedError(
      "checksum table is out of sync with the installed app-builder-lib (it was probably upgraded):\n" +
        drifted.map(([name, tool]) => `  ${name}: ${tool.sha256} no longer present in ${path.relative(root, libFile)}`).join("\n") +
        "\nUpdate scripts/lib/builder-tools.mjs from the new source.",
    );
  }
}
