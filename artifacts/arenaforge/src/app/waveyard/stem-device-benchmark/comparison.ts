export type BenchmarkMode = "nativeTempo" | "tempoMatched";

export type ImportedDeviceReport = {
  schemaVersion: 1;
  measuredAt: string;
  environment: {
    browser: string;
    operatingSystem: string;
    deviceClass: "Phone" | "Tablet";
    deviceModel: string;
  };
  observations: Array<{
    mode: BenchmarkMode;
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
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("This is not a supported Waveyard device benchmark report (schema version 1).");
  }

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

  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    throw new Error("The report does not include individual swap measurements.");
  }
  const observations: ImportedDeviceReport["observations"] = [];
  for (const observation of value.observations) {
    if (!isRecord(observation) ||
        (observation.mode !== "nativeTempo" && observation.mode !== "tempoMatched") ||
        typeof observation.observedSelectionToAudibleMs !== "number" ||
        !Number.isFinite(observation.observedSelectionToAudibleMs) ||
        observation.observedSelectionToAudibleMs < 0) {
      throw new Error("The report contains an invalid swap measurement.");
    }
    observations.push({
      mode: observation.mode,
      observedSelectionToAudibleMs: observation.observedSelectionToAudibleMs,
    });
  }

  if (!observations.some(({ mode }) => mode === "nativeTempo") ||
      !observations.some(({ mode }) => mode === "tempoMatched")) {
    throw new Error("Each report must include both native-tempo and tempo-matched measurements.");
  }

  return {
    schemaVersion: 1,
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
  const groups = new Map<string, LoadedDeviceReport[]>();
  for (const loaded of reports) {
    const { browser, operatingSystem, deviceClass } = loaded.report.environment;
    const key = JSON.stringify([browser, operatingSystem, deviceClass]);
    groups.set(key, [...(groups.get(key) ?? []), loaded]);
  }

  return [...groups.values()].map((groupReports) => {
    const nativeValues = groupReports.flatMap(({ report }) =>
      report.observations
        .filter(({ mode }) => mode === "nativeTempo")
        .map(({ observedSelectionToAudibleMs }) => observedSelectionToAudibleMs));
    const matchedValues = groupReports.flatMap(({ report }) =>
      report.observations
        .filter(({ mode }) => mode === "tempoMatched")
        .map(({ observedSelectionToAudibleMs }) => observedSelectionToAudibleMs));
    const nativeTempoMedianMs = median(nativeValues);
    const tempoMatchedMedianMs = median(matchedValues);
    const { browser, operatingSystem, deviceClass } = groupReports[0].report.environment;

    return {
      browser,
      operatingSystem,
      deviceClass,
      reports: groupReports,
      nativeTempoMedianMs,
      tempoMatchedMedianMs,
      tempoMatchedMinusNativeMedianMs: tempoMatchedMedianMs - nativeTempoMedianMs,
      nativeSampleCount: nativeValues.length,
      tempoMatchedSampleCount: matchedValues.length,
    };
  });
}
