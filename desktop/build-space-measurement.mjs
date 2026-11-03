import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableBuildSpaceBytes } from "./build-space-preflight.mjs";

const GIB = 1024 ** 3;

function roundedGiB(bytes) {
  return Math.round((bytes / GIB) * 100) / 100;
}

export function sampleBuildSpace(initialLocations, { statfs } = {}) {
  return initialLocations.map(({ label, checkedPath }) => {
    try {
      if (typeof checkedPath !== "string" || !checkedPath) {
        throw new Error("Preflight did not supply a resolved storage path.");
      }
      // Use precisely the path checked by preflight, including mounted folders.
      // Do not fall back to a drive root or an ancestor if it becomes unavailable.
      return { label, freeBytes: availableBuildSpaceBytes(checkedPath, statfs) };
    } catch (error) {
      return {
        label,
        freeBytes: null,
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Build a local report from disk samples without copying filesystem paths or
 * inspection error text, either of which can contain private machine details.
 */
export function summarizeBuildSpaceMeasurement({
  initialLocations,
  samples,
  previousReport = null,
  measuredAtUtc = new Date().toISOString(),
  minimumFreeGiB,
  configuredMinimumGiB,
  sampleIntervalSeconds = 2,
}) {
  const locations = initialLocations
    .filter(({ label, availableBytes }) => label && Number.isFinite(availableBytes))
    .map(({ label, availableBytes }) => {
      const locationSamples = samples.flatMap((sample) =>
        (sample.locations ?? [])
          .filter((entry) => entry.label === label && Number.isFinite(entry.freeBytes))
          .map((entry) => ({ freeBytes: entry.freeBytes, phase: sample.phase ?? null })),
      );
      const lowestFreeBytes = locationSamples.reduce(
        (lowest, entry) => Math.min(lowest, entry.freeBytes),
        availableBytes,
      );
      const peakSample = locationSamples.reduce(
        (peak, entry) =>
          availableBytes - entry.freeBytes > availableBytes - peak.freeBytes ? entry : peak,
        { freeBytes: availableBytes, phase: "before-build" },
      );
      return {
        label,
        initialFreeGiB: roundedGiB(availableBytes),
        minimumObservedFreeGiB: roundedGiB(lowestFreeBytes),
        peakConsumptionGiB: locationSamples.length
          ? roundedGiB(Math.max(0, availableBytes - lowestFreeBytes))
          : null,
        peakPhase: locationSamples.length ? peakSample.phase : null,
        failedSampleCount: samples.filter((sample) =>
          (sample.locations ?? []).some((entry) =>
            entry.label === label && !Number.isFinite(entry.freeBytes),
          ),
        ).length,
      };
    });

  const phases = samples
    .filter((sample) => sample.checkpoint === true && typeof sample.phase === "string")
    .map((sample) => ({
      name: sample.phase,
      atUtc: sample.atUtc,
      freeGiB: (sample.locations ?? [])
        .filter(({ label, freeBytes }) =>
          locations.some((location) => location.label === label) && Number.isFinite(freeBytes),
        )
        .map(({ label, freeBytes }) => ({ label, freeGiB: roundedGiB(freeBytes) })),
    }));

  const previousCleanup = previousReport?.phases
    ?.findLast((phase) => phase.name === "interrupted-build-cleanup-complete");
  const measuredPeakConsumptionGiB = locations.some((location) => location.peakConsumptionGiB !== null)
    ? locations.reduce(
      (peak, location) => Math.max(peak, location.peakConsumptionGiB ?? 0),
      0,
    )
    : null;
  const retryComparison = previousCleanup
    ? {
      previousRunPeakConsumptionGiB: previousReport.measuredPeakConsumptionGiB ?? null,
      currentRunPeakConsumptionGiB: measuredPeakConsumptionGiB,
      peakChangeGiB: Number.isFinite(previousReport.measuredPeakConsumptionGiB) &&
        Number.isFinite(measuredPeakConsumptionGiB)
        ? Math.round((measuredPeakConsumptionGiB - previousReport.measuredPeakConsumptionGiB) * 100) / 100
        : null,
      freeSpace: initialLocations.flatMap((location) => {
        const afterCleanup = previousCleanup.freeGiB
          ?.find((entry) => entry.label === location.label)?.freeGiB;
        if (!Number.isFinite(location.availableBytes) || !Number.isFinite(afterCleanup)) return [];
        const beforeRetryGiB = roundedGiB(location.availableBytes);
        return [{
          label: location.label,
          afterCleanupGiB: afterCleanup,
          beforeRetryGiB,
          changeGiB: Math.round((beforeRetryGiB - afterCleanup) * 100) / 100,
        }];
      }),
    }
    : null;

  return {
    schemaVersion: 1,
    measuredAtUtc,
    minimumFreeGiB,
    configuredMinimumGiB,
    sampleIntervalSeconds,
    sampleCount: samples.filter((sample) => sample.checkpoint !== true).length,
    measuredPeakConsumptionGiB,
    unavailableLocations: initialLocations
      .filter(({ availableBytes }) => !Number.isFinite(availableBytes))
      .map(({ label }) => label),
    retryComparison,
    locations,
    phases,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--sample") {
      const initialLocations = JSON.parse(
        readFileSync(process.argv[3], "utf8").replace(/^\uFEFF/, ""),
      );
      console.log(JSON.stringify(sampleBuildSpace(initialLocations)));
    } else {
      const [initialPath, samplesPath, reportPath, minimumFree, configuredMinimum] = process.argv.slice(2);
      if (!initialPath || !samplesPath || !reportPath) {
        throw new Error("Supply initial, samples, and report file paths.");
      }
      const initialLocations = JSON.parse(readFileSync(initialPath, "utf8").replace(/^\uFEFF/, ""));
      const samples = readFileSync(samplesPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      let previousReport = null;
      try {
        previousReport = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        // The first measurement has no previous run to compare.
      }
      const report = summarizeBuildSpaceMeasurement({
        initialLocations,
        samples,
        previousReport,
        minimumFreeGiB: Number(minimumFree),
        configuredMinimumGiB: Number(configuredMinimum),
      });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({
        measuredPeakConsumptionGiB: report.measuredPeakConsumptionGiB,
        sampleCount: report.sampleCount,
        phaseCount: report.phases.length,
      }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
