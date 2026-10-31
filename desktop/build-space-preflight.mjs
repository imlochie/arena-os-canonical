import { existsSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BUILD_MIN_FREE_GIB = 20;
export const BUILD_SPACE_HEADROOM_MULTIPLIER = 1.25;

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

function existingAncestor(locationPath) {
  let candidate = path.resolve(locationPath);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`No existing parent directory for ${locationPath}`);
    candidate = parent;
  }
  return candidate;
}

export function inspectBuildSpace(
  locations,
  { statfs = statfsSync, minimumFreeGiB = DEFAULT_BUILD_MIN_FREE_GIB } = {},
) {
  if (!Number.isFinite(minimumFreeGiB) || minimumFreeGiB <= 0) {
    throw new Error("The minimum free-space threshold must be a positive number.");
  }
  const thresholdBytes = minimumFreeGiB * 1024 ** 3;
  return locations.map(({ label, path: locationPath }) => {
    try {
      const checkedPath = existingAncestor(locationPath);
      const stats = statfs(checkedPath);
      const freeBlocks = Number.isFinite(stats.bavail) ? stats.bavail : stats.bfree;
      if (!Number.isFinite(freeBlocks) || !Number.isFinite(stats.bsize) || stats.bsize <= 0) {
        throw new Error("The filesystem returned an invalid free-space measurement.");
      }
      const availableBytes = freeBlocks * stats.bsize;
      if (!Number.isFinite(availableBytes) || availableBytes < 0) {
        throw new Error("The filesystem returned an invalid free-space measurement.");
      }
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
    const locations = process.argv.slice(2).map(parseLocation);
    if (locations.length === 0) throw new Error("Supply at least one label=path location.");
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
