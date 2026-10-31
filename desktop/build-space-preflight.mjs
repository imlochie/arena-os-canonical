import { statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_SPACE_WARNING_GIB = 20;

export function inspectBuildSpace(
  locations,
  { statfs = statfsSync, warningThresholdGiB = BUILD_SPACE_WARNING_GIB } = {},
) {
  const thresholdBytes = warningThresholdGiB * 1024 ** 3;
  return locations.map(({ label, path: locationPath }) => {
    try {
      const stats = statfs(locationPath);
      const freeBlocks = Number.isFinite(stats.bavail) ? stats.bavail : stats.bfree;
      const availableBytes = freeBlocks * stats.bsize;
      return {
        label,
        path: locationPath,
        availableGiB: Math.round((availableBytes / 1024 ** 3) * 10) / 10,
        belowWarningThreshold: availableBytes < thresholdBytes,
        inspectionError: null,
      };
    } catch (error) {
      return {
        label,
        path: locationPath,
        availableGiB: null,
        belowWarningThreshold: true,
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
    console.log(JSON.stringify({
      warningThresholdGiB: BUILD_SPACE_WARNING_GIB,
      locations: inspectBuildSpace(locations),
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
