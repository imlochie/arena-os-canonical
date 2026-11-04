export type BenchmarkMode = "nativeTempo" | "tempoMatched";

export type ImportedDeviceReport = {
  schemaVersion: 1 | 2;
  measuredAt: string;
  environment: {
    browser: string;
    operatingSystem: string;
    deviceClass: "Phone" | "Tablet";
    deviceModel: string;
  };
  observations: Array<{
    mode: BenchmarkMode;
    fixtureDurationSeconds: number | null;
    observedSelectionToAudibleMs: number;
  }>;
};

export type LoadedDeviceReport = {
  id: string;
  filename: string;
  report: ImportedDeviceReport;
};

export type DeviceComparisonGroup = {
  browser: string;
  operatingSystem: string;
  deviceClass: "Phone" | "Tablet";
  durationSeconds: number | null;
  reports: LoadedDeviceReport[];
  nativeTempoMedianMs: number;
  tempoMatchedMedianMs: number;
  tempoMatchedMinusNativeMedianMs: number;
  nativeSampleCount: number;
  tempoMatchedSampleCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDeviceReport(value: unknown): ImportedDeviceReport {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error("This is not a supported Waveyard device benchmark report (schema version 1 or 2).");
  }
  const schemaVersion = value.schemaVersion;

  const environment = value.environment;
  if (!isRecord(environment)) {
    throw new Error("The report is missing its device details.");
  }
  const { browser, operatingSystem, deviceClass, deviceModel } = environment;
  if (typeof browser !== "string" || !browser.trim() ||
      typeof operatingSystem !== "string" || !operatingSystem.trim() ||
      (deviceClass !== "Phone" && deviceClass !== "Tablet") ||
      typeof deviceModel !== "string") {
    throw new Error("The report has incomplete browser, operating system, or device-class details.");
  }

  if (typeof value.measuredAt !== "string" || !Number.isFinite(Date.parse(value.measuredAt))) {
    throw new Error("The report is missing a valid measurement date.");
  }

  const fixtureDurations = new Set<number>();
  if (schemaVersion === 2) {
    if (!Array.isArray(value.fixtures) || value.fixtures.length === 0) {
      throw new Error("The report does not identify its donor fixtures.");
    }
    for (const fixture of value.fixtures) {
      if (!isRecord(fixture) || typeof fixture.durationSeconds !== "number" ||
          !Number.isFinite(fixture.durationSeconds) || fixture.durationSeconds <= 0 ||
          fixtureDurations.has(fixture.durationSeconds)) {
        throw new Error("The report contains an invalid or duplicate donor duration.");
      }
      fixtureDurations.add(fixture.durationSeconds);
    }
  } else if (isRecord(value.fixture) &&
      typeof value.fixture.durationSeconds === "number" &&
      Number.isFinite(value.fixture.durationSeconds) &&
      value.fixture.durationSeconds > 0) {
    fixtureDurations.add(value.fixture.durationSeconds);
  }

  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    throw new Error("The report does not include individual swap measurements.");
  }
  const observations: ImportedDeviceReport["observations"] = [];
  for (const observation of value.observations) {
    const fixtureDurationSeconds = schemaVersion === 1
      ? [...fixtureDurations][0] ?? null
      : isRecord(observation) ? observation.fixtureDurationSeconds : undefined;
    const invalidFixtureDuration = schemaVersion === 2
      ? typeof fixtureDurationSeconds !== "number" ||
        !Number.isFinite(fixtureDurationSeconds) ||
        !fixtureDurations.has(fixtureDurationSeconds)
      : fixtureDurationSeconds !== null &&
        (typeof fixtureDurationSeconds !== "number" ||
         !Number.isFinite(fixtureDurationSeconds) ||
         !fixtureDurations.has(fixtureDurationSeconds));
    if (!isRecord(observation) ||
        (observation.mode !== "nativeTempo" && observation.mode !== "tempoMatched") ||
        invalidFixtureDuration ||
        typeof observation.observedSelectionToAudibleMs !== "number" ||
        !Number.isFinite(observation.observedSelectionToAudibleMs) ||
        observation.observedSelectionToAudibleMs < 0) {
      throw new Error("The report contains an invalid swap measurement.");
    }
    observations.push({
      mode: observation.mode,
      fixtureDurationSeconds: fixtureDurationSeconds as number | null,
      observedSelectionToAudibleMs: observation.observedSelectionToAudibleMs,
    });
  }

  const durations = new Set(observations.map(({ fixtureDurationSeconds }) => fixtureDurationSeconds));
  if (schemaVersion === 2 &&
      (durations.size !== fixtureDurations.size ||
       [...fixtureDurations].some(duration => !durations.has(duration)))) {
    throw new Error("The report is missing swap measurements for one or more donor durations.");
  }
  if ([...durations].some(duration => {
    const durationObservations = observations.filter(item => item.fixtureDurationSeconds === duration);
    return !durationObservations.some(({ mode }) => mode === "nativeTempo") ||
      !durationObservations.some(({ mode }) => mode === "tempoMatched");
  })) {
    throw new Error("Each report must include both native-tempo and tempo-matched measurements.");
  }

  return {
    schemaVersion,
    measuredAt: value.measuredAt,
    environment: {
      browser: browser.trim(),
      operatingSystem: operatingSystem.trim(),
      deviceClass,
      deviceModel: deviceModel.trim(),
    },
    observations,
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function groupDeviceReports(reports: LoadedDeviceReport[]): DeviceComparisonGroup[] {
  const groups = new Map<string, { durationSeconds: number | null; reports: LoadedDeviceReport[] }>();
  for (const loaded of reports) {
    const { browser, operatingSystem, deviceClass } = loaded.report.environment;
    const durations = new Set(loaded.report.observations.map(item => item.fixtureDurationSeconds));
    for (const durationSeconds of durations) {
      const key = JSON.stringify([browser, operatingSystem, deviceClass, durationSeconds]);
      const group = groups.get(key) ?? { durationSeconds, reports: [] };
      group.reports.push(loaded);
      groups.set(key, group);
    }
  }

  return [...groups.values()].map(({ durationSeconds, reports: groupReports }) => {
    const nativeValues = groupReports.flatMap(({ report }) =>
      report.observations
        .filter(({ mode, fixtureDurationSeconds }) =>
          mode === "nativeTempo" && fixtureDurationSeconds === durationSeconds)
        .map(({ observedSelectionToAudibleMs }) => observedSelectionToAudibleMs));
    const matchedValues = groupReports.flatMap(({ report }) =>
      report.observations
        .filter(({ mode, fixtureDurationSeconds }) =>
          mode === "tempoMatched" && fixtureDurationSeconds === durationSeconds)
        .map(({ observedSelectionToAudibleMs }) => observedSelectionToAudibleMs));
    const nativeTempoMedianMs = median(nativeValues);
    const tempoMatchedMedianMs = median(matchedValues);
    const { browser, operatingSystem, deviceClass } = groupReports[0].report.environment;

    return {
      browser,
      operatingSystem,
      deviceClass,
      durationSeconds,
      reports: groupReports,
      nativeTempoMedianMs,
      tempoMatchedMedianMs,
      tempoMatchedMinusNativeMedianMs: tempoMatchedMedianMs - nativeTempoMedianMs,
      nativeSampleCount: nativeValues.length,
      tempoMatchedSampleCount: matchedValues.length,
    };
  });
}
