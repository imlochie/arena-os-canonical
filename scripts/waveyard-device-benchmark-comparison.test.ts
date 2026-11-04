import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDeviceReports,
  parseDeviceReport,
  type LoadedDeviceReport,
} from "../artifacts/arenaforge/src/app/waveyard/stem-device-benchmark/comparison";

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-11-04T12:00:00.000Z",
    environment: {
      browser: "Safari 18",
      operatingSystem: "iOS / iPadOS",
      deviceClass: "Phone",
      deviceModel: "Example Phone",
    },
    observations: [
      { mode: "nativeTempo", observedSelectionToAudibleMs: 20 },
      { mode: "nativeTempo", observedSelectionToAudibleMs: 40 },
      { mode: "tempoMatched", observedSelectionToAudibleMs: 30 },
      { mode: "tempoMatched", observedSelectionToAudibleMs: 50 },
    ],
    ...overrides,
  };
}

function loaded(filename: string, value: unknown): LoadedDeviceReport {
  return { id: filename, filename, report: parseDeviceReport(value) };
}

test("parses exported reports and rejects incomplete or unsafe swap observations", () => {
  const parsed = parseDeviceReport(report());
  assert.equal(parsed.environment.browser, "Safari 18");
  assert.equal(parsed.observations.length, 4);

  assert.throws(() => parseDeviceReport({ ...report(), schemaVersion: 2 }), /schema version 1/);
  assert.throws(() => parseDeviceReport(report({
    observations: [{ mode: "nativeTempo", observedSelectionToAudibleMs: 20 }],
  })), /both native-tempo and tempo-matched/);
  assert.throws(() => parseDeviceReport(report({
    observations: [{ mode: "tempoMatched", observedSelectionToAudibleMs: Number.NaN }],
  })), /invalid swap measurement/);
});

test("groups reports by browser, operating system, and device class using pooled medians", () => {
  const sameGroup = report({
    observations: [
      { mode: "nativeTempo", observedSelectionToAudibleMs: 60 },
      { mode: "tempoMatched", observedSelectionToAudibleMs: 70 },
    ],
  });
  const tablet = report({
    environment: {
      browser: "Safari 18",
      operatingSystem: "iOS / iPadOS",
      deviceClass: "Tablet",
      deviceModel: "Example Tablet",
    },
  });
  const android = report({
    environment: {
      browser: "Chrome 130",
      operatingSystem: "Android",
      deviceClass: "Phone",
      deviceModel: "Example Android",
    },
  });

  const groups = groupDeviceReports([
    loaded("phone-a.json", report()),
    loaded("phone-b.json", sameGroup),
    loaded("tablet.json", tablet),
    loaded("android.json", android),
  ]);

  assert.equal(groups.length, 3);
  const phones = groups.find(group => group.deviceClass === "Phone" && group.browser === "Safari 18");
  assert.ok(phones);
  assert.equal(phones.reports.length, 2);
  assert.equal(phones.nativeSampleCount, 3);
  assert.equal(phones.tempoMatchedSampleCount, 3);
  assert.equal(phones.nativeTempoMedianMs, 40);
  assert.equal(phones.tempoMatchedMedianMs, 50);
  assert.equal(phones.tempoMatchedMinusNativeMedianMs, 10);
  assert.ok(groups.some(group => group.deviceClass === "Tablet"));
  assert.ok(groups.some(group => group.operatingSystem === "Android"));
});
