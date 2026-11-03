import { existsSync, lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BUILD_MIN_FREE_GIB = 20;
export const BUILD_SPACE_HEADROOM_MULTIPLIER = 1.25;
export const BUILD_PNPM_VERSION = "10.26.1";

// npm resolves its own project/user configuration and environment overrides.
// `config get` uses the installed npm, not npx, and never installs packages.
export function resolveNpmCachePath({
  run = spawnSync,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const windows = platform === "win32";
  const result = run(windows ? "npm.cmd" : "npm", ["--offline", "config", "get", "cache"], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    shell: windows,
    env: {
      ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_offline")),
      npm_config_offline: "true",
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not resolve the npm cache offline. Check npm's configuration and cache drive. No dependency download has started.");
  }
  const cachePath = result.stdout?.replace(/^\uFEFF/, "").trim();
  const pathApi = windows ? path.win32 : path;
  if (!cachePath || /[\r\n]/.test(cachePath) || !pathApi.isAbsolute(cachePath)) {
    throw new Error("npm did not return one absolute cache path. No dependency download has started.");
  }
  return cachePath;
}

// Ask pnpm itself so project/user configuration and environment overrides keep
// their normal precedence. Never bootstrap a manager over the network here.
export function resolvePnpmStorePath({
  run = spawnSync,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const windows = platform === "win32";
  const forcedEnv = {
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    npm_config_offline: "true",
    npm_config_manage_package_manager_versions: "false",
  };
  const forcedKeys = new Set(Object.keys(forcedEnv).map((key) => key.toLowerCase()));
  const options = {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    shell: windows,
    env: {
      // Windows treats environment keys case-insensitively. Do not let an
      // inherited uppercase variant defeat the offline safety settings.
      ...Object.fromEntries(Object.entries(env).filter(([key]) => !forcedKeys.has(key.toLowerCase()))),
      ...forcedEnv,
    },
  };
  const pnpm = "pnpm"; // cmd.exe resolves either pnpm.cmd or the standalone pnpm.exe.
  const noSelfDownload = "--config.manage-package-manager-versions=false";
  const version = run(pnpm, [noSelfDownload, "--version"], options);
  const installed = version.status === 0 && version.stdout?.trim() === BUILD_PNPM_VERSION;
  const result = installed
    ? run(pnpm, [noSelfDownload, "store", "path"], options)
    : run(windows ? "npx.cmd" : "npx", [
      "--offline", "--yes", `pnpm@${BUILD_PNPM_VERSION}`,
      noSelfDownload, "store", "path",
    ], options);
  if (result.error || result.status !== 0) {
    const guidance = installed
      ? "Check pnpm's configured store path and that its drive is available."
      : `Install pnpm ${BUILD_PNPM_VERSION} locally or cache that version, then rerun.`;
    throw new Error(
      `Could not resolve the pnpm dependency store offline. ${guidance} No dependency download has started.`,
    );
  }
  const storePath = result.stdout?.replace(/^\uFEFF/, "").trim();
  const pathApi = windows ? path.win32 : path;
  if (!storePath || /[\r\n]/.test(storePath) || !pathApi.isAbsolute(storePath)) {
    throw new Error("pnpm did not return one absolute store path. No dependency download has started.");
  }
  return storePath;
}

export function parseMinimumFreeGiB(value) {
  if (value === undefined || value === "") return DEFAULT_BUILD_MIN_FREE_GIB;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("ARENA_BUILD_MIN_FREE_GIB must be a positive number.");
  }
  return parsed;
}

export function minimumFreeGiBForPreviousBuild(
  previousPeakGiB,
  configuredMinimumGiB = DEFAULT_BUILD_MIN_FREE_GIB,
) {
  if (!Number.isFinite(configuredMinimumGiB) || configuredMinimumGiB <= 0) {
    throw new Error("The configured minimum free space must be a positive number.");
  }
  if (!Number.isFinite(previousPeakGiB) || previousPeakGiB < 0) {
    return configuredMinimumGiB;
  }
  return Math.max(
    configuredMinimumGiB,
    Math.ceil(previousPeakGiB * BUILD_SPACE_HEADROOM_MULTIPLIER),
  );
}

function pathEntryExists(candidate) {
  try {
    // Unlike existsSync, lstat sees dangling links. Never walk past one and
    // accidentally inspect its containing drive instead of its missing target.
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function existingAncestor(locationPath, exists, pathApi) {
  let candidate = pathApi.resolve(locationPath);
  while (!exists(candidate)) {
    const parent = pathApi.dirname(candidate);
    if (parent === candidate) throw new Error(`No existing parent directory for ${locationPath}`);
    candidate = parent;
  }
  return candidate;
}

export function availableBuildSpaceBytes(checkedPath, statfs = statfsSync) {
  const stats = statfs(checkedPath);
  const freeBlocks = Number.isFinite(stats.bavail) ? stats.bavail : stats.bfree;
  if (!Number.isFinite(freeBlocks) || !Number.isFinite(stats.bsize) || stats.bsize <= 0) {
    throw new Error("The filesystem returned an invalid free-space measurement.");
  }
  const availableBytes = freeBlocks * stats.bsize;
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new Error("The filesystem returned an invalid free-space measurement.");
  }
  return availableBytes;
}

export function inspectBuildSpace(
  locations,
  {
    statfs = statfsSync,
    minimumFreeGiB = DEFAULT_BUILD_MIN_FREE_GIB,
    exists = pathEntryExists,
    realpath = realpathSync.native,
    pathApi = path,
  } = {},
) {
  if (!Number.isFinite(minimumFreeGiB) || minimumFreeGiB <= 0) {
    throw new Error("The minimum free-space threshold must be a positive number.");
  }
  const thresholdBytes = minimumFreeGiB * 1024 ** 3;
  return locations.map(({ label, path: locationPath }) => {
    try {
      const checkedPath = realpath(existingAncestor(locationPath, exists, pathApi));
      const availableBytes = availableBuildSpaceBytes(checkedPath, statfs);
      return {
        label,
        path: locationPath,
        checkedPath,
        availableBytes,
        availableGiB: Math.round((availableBytes / 1024 ** 3) * 10) / 10,
        belowMinimumFreeSpace: availableBytes < thresholdBytes,
        inspectionError: null,
      };
    } catch (error) {
      return {
        label,
        path: locationPath,
        checkedPath: null,
        availableBytes: null,
        availableGiB: null,
        belowMinimumFreeSpace: true,
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function parseLocation(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`Expected location as label=path; received ${value}`);
  }
  return { label: value.slice(0, separator), path: value.slice(separator + 1) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const locations = args
      .filter((arg) => !["--include-pnpm-store", "--include-npm-cache"].includes(arg))
      .map(parseLocation);
    if (locations.length === 0) throw new Error("Supply at least one label=path location.");
    if (args.includes("--include-npm-cache")) {
      locations.push({ label: "npm cache", path: resolveNpmCachePath() });
    }
    if (args.includes("--include-pnpm-store")) {
      locations.push({ label: "pnpm dependency store", path: resolvePnpmStorePath() });
    }
    const configuredMinimumGiB = parseMinimumFreeGiB(process.env.ARENA_BUILD_MIN_FREE_GIB);
    let previousPeakGiB = null;
    const measurementPath = path.join(process.cwd(), "generated-artifacts", "windows-build-space.json");
    if (existsSync(measurementPath)) {
      try {
        const previousMeasurement = JSON.parse(
          readFileSync(measurementPath, "utf8").replace(/^\uFEFF/, ""),
        );
        previousPeakGiB = previousMeasurement.measuredPeakConsumptionGiB;
      } catch {
        // A missing or malformed prior report uses the documented bootstrap floor.
      }
    }
    const minimumFreeGiB = minimumFreeGiBForPreviousBuild(previousPeakGiB, configuredMinimumGiB);
    const inspected = inspectBuildSpace(locations, { minimumFreeGiB });
    console.log(JSON.stringify({
      minimumFreeGiB,
      configuredMinimumGiB,
      previousPeakConsumptionGiB: Number.isFinite(previousPeakGiB) ? previousPeakGiB : null,
      insufficientSpace: inspected.some(({ belowMinimumFreeSpace }) => belowMinimumFreeSpace),
      locations: inspected,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
