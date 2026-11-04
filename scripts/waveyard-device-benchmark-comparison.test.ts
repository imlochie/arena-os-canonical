import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDeviceReports,
  parseDeviceReport,
  type LoadedDeviceReport,
} from "../artifacts/arenaforge/src/app/waveyard/stem-device-benchmark/comparison";

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    measuredAt: "2026-11-04T12:00:00.000Z",
    fixtures: [{ durationSeconds: 8 }, { durationSeconds: 30 }],
    environment: {
      browser: "Safari 18",
      operatingSystem: "iOS / iPadOS",
      deviceClass: "Phone",
      deviceModel: "Example Phone",
    },
    observations: [
      { mode: "nativeTempo", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 20 },
      { mode: "nativeTempo", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 40 },
      { mode: "tempoMatched", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 30 },
      { mode: "tempoMatched", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 50 },
      { mode: "nativeTempo", fixtureDurationSeconds: 30, observedSelectionToAudibleMs: 60 },
      { mode: "tempoMatched", fixtureDurationSeconds: 30, observedSelectionToAudibleMs: 80 },
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
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.observations.length, 6);

  assert.throws(() => parseDeviceReport({ ...report(), schemaVersion: 3 }), /schema version 1 or 2/);
  assert.throws(() => parseDeviceReport(report({
    fixtures: [{ durationSeconds: 8 }],
    observations: [
      { mode: "nativeTempo", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 20 },
    ],
  })), /both native-tempo and tempo-matched/);
  assert.throws(() => parseDeviceReport(report({
    observations: [
      { mode: "nativeTempo", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 10 },
      { mode: "tempoMatched", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: Number.NaN },
    ],
  })), /invalid swap measurement/);
  assert.throws(() => parseDeviceReport(report({
    observations: [
      { mode: "nativeTempo", fixtureDurationSeconds: 60, observedSelectionToAudibleMs: 10 },
      { mode: "tempoMatched", fixtureDurationSeconds: 60, observedSelectionToAudibleMs: 20 },
    ],
  })), /invalid swap measurement/);

  const legacy = parseDeviceReport({
    ...report(),
    schemaVersion: 1,
    fixture: { durationSeconds: 8 },
    observations: [
      { mode: "nativeTempo", observedSelectionToAudibleMs: 12 },
      { mode: "tempoMatched", observedSelectionToAudibleMs: 22 },
    ],
  });
  assert.equal(legacy.observations[0].fixtureDurationSeconds, 8);
});

test("groups reports by device and donor duration using pooled medians", () => {
  const sameGroup = report({
    observations: [
      { mode: "nativeTempo", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 60 },
      { mode: "tempoMatched", fixtureDurationSeconds: 8, observedSelectionToAudibleMs: 70 },
    ],
    fixtures: [{ durationSeconds: 8 }],
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

  assert.equal(groups.length, 6);
  const phones = groups.find(group =>
    group.deviceClass === "Phone" && group.browser === "Safari 18" && group.durationSeconds === 8);
  assert.ok(phones);
  assert.equal(phones.reports.length, 2);
  assert.equal(phones.nativeSampleCount, 3);
  assert.equal(phones.tempoMatchedSampleCount, 3);
  assert.equal(phones.nativeTempoMedianMs, 40);
  assert.equal(phones.tempoMatchedMedianMs, 50);
  assert.equal(phones.tempoMatchedMinusNativeMedianMs, 10);
  const longerPhones = groups.find(group =>
    group.deviceClass === "Phone" && group.browser === "Safari 18" && group.durationSeconds === 30);
  assert.ok(longerPhones);
  assert.equal(longerPhones.nativeTempoMedianMs, 60);
  assert.equal(longerPhones.tempoMatchedMedianMs, 80);
  assert.ok(groups.some(group => group.deviceClass === "Tablet" && group.durationSeconds === 30));
  assert.ok(groups.some(group => group.operatingSystem === "Android" && group.durationSeconds === 8));
});
