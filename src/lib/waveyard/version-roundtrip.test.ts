/**
 * Version snapshot/restore regression tests.
 *
 * These pin the persistence contract extracted into remix-versioning.ts:
 * TRACK INSERTS, MASTER INSERTS, and their combination must survive
 * save-version → restore-version → re-save (the path an export consumes).
 * They were written after masterInserts was silently dropped from version
 * snapshots — remove either chain from the mapping and these fail.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVersionSnapshot,
  restoredSessionFields,
  restoredTrackFields,
  type AutomationRow,
  type ClipRow,
  type SessionRow,
  type TrackRow,
} from "./remix-versioning";
import { normaliseRemixState } from "./remix";
import type { InsertChain } from "./mixer/inserts";

const STEM = "11111111-1111-4111-8111-111111111111";

const trackInserts: InsertChain = [
  { id: "fx-1", processor: "notch", enabled: true, wet: 1, params: { freqHz: 50, q: 18 } },
  { id: "fx-2", processor: "highpass", enabled: false, wet: 0.5, params: { cutoffHz: 90, q: 0.7071 } },
];
const masterInserts: InsertChain = [
  { id: "m-1", processor: "softclip", enabled: true, wet: 1, params: { ceilingDb: -1 } },
];

function sessionRow(): SessionRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    ownerId: "00000000-0000-4000-8000-000000000001",
    name: "Session",
    masterVolume: 0.9,
    masterInserts: JSON.stringify(masterInserts),
    loopStartMs: 0,
    loopEndMs: null,
    tempoBpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    gridDivision: "beat",
    snapEnabled: true,
    targetKey: null,
    version: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function trackRow(): TrackRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    remixSessionId: "22222222-2222-4222-8222-222222222222",
    stemAssetId: STEM,
    name: "Lead",
    sortOrder: 0,
    volume: 0.8,
    pan: -0.1,
    muted: false,
    solo: false,
    inserts: JSON.stringify(trackInserts),
    phaseInverted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function clipRow(): ClipRow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    remixTrackId: "44444444-4444-4444-8444-444444444444",
    stemAssetId: STEM,
    timelineStartMs: 0,
    durationMs: 6000,
    sourceOffsetMs: 0,
    gain: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    tempoSyncEnabled: false,
    keySyncEnabled: false,
    beatSnapEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function automationRow(): AutomationRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    remixSessionId: "22222222-2222-4222-8222-222222222222",
    remixTrackId: "44444444-4444-4444-8444-444444444444",
    parameter: "volume",
    timelineMs: 1000,
    value: 0.5,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test("TRACK INSERTS: version snapshots carry the chain", () => {
  const snapshot = buildVersionSnapshot({ remix: sessionRow(), tracks: [trackRow()], clips: [clipRow()], automation: [automationRow()] });
  assert.equal(snapshot.tracks[0].inserts, JSON.stringify(trackInserts));
});

test("MASTER INSERTS: version snapshots carry the chain (regression: it was dropped here)", () => {
  const snapshot = buildVersionSnapshot({ remix: sessionRow(), tracks: [trackRow()], clips: [clipRow()], automation: [automationRow()] });
  assert.equal(snapshot.masterInserts, JSON.stringify(masterInserts));
  // What the export worker consumes after normalising the snapshot:
  const state = normaliseRemixState(JSON.parse(JSON.stringify(snapshot)));
  assert.notEqual(state, null);
  assert.deepEqual(state!.masterInserts, masterInserts);
});

test("TRACK + MASTER combination: restore writes both chains back", () => {
  const snapshot = buildVersionSnapshot({ remix: sessionRow(), tracks: [trackRow()], clips: [clipRow()], automation: [automationRow()] });
  const state = normaliseRemixState(JSON.parse(JSON.stringify(snapshot)));
  assert.notEqual(state, null);

  const trackFields = restoredTrackFields("22222222-2222-4222-8222-222222222222", state!.tracks[0]);
  assert.equal(trackFields.inserts, JSON.stringify(trackInserts), "restore must rewrite the track chain");
  assert.equal(trackFields.phaseInverted, true, "phase flag travels too");

  const sessionFields = restoredSessionFields(state!, { name: "Session", version: 3 });
  assert.equal(sessionFields.masterInserts, JSON.stringify(masterInserts), "restore must rewrite the master chain");
  assert.equal(sessionFields.version, 4);
});

test("VERSION SAVE → RESTORE → RE-SAVE → EXPORT: chains survive the whole loop", () => {
  // 1. save: live rows → snapshot
  const first = buildVersionSnapshot({ remix: sessionRow(), tracks: [trackRow()], clips: [clipRow()], automation: [automationRow()] });

  // 2. restore: snapshot → normalised state → DB writes
  const state = normaliseRemixState(JSON.parse(JSON.stringify(first)))!;
  const trackFields = restoredTrackFields("22222222-2222-4222-8222-222222222222", state.tracks[0]);
  const sessionFields = restoredSessionFields(state, { name: "Session", version: 3 });

  // 3. re-save: the restored rows (as the DB now holds them) → new snapshot
  const restoredTrack: TrackRow = { ...trackRow(), inserts: trackFields.inserts!, phaseInverted: trackFields.phaseInverted };
  const restoredSession: SessionRow = { ...sessionRow(), masterInserts: sessionFields.masterInserts!, version: sessionFields.version };
  const second = buildVersionSnapshot({ remix: restoredSession, tracks: [restoredTrack], clips: [clipRow()], automation: [automationRow()] });

  // 4. export: the worker normalises the re-saved snapshot
  const exportState = normaliseRemixState(JSON.parse(JSON.stringify(second)))!;
  assert.deepEqual(exportState.tracks[0].inserts, trackInserts, "track chain must reach the export render");
  assert.deepEqual(exportState.masterInserts, masterInserts, "master chain must reach the export render");
  assert.equal(exportState.tracks[0].phaseInverted, true);
});

test("restore leaves persisted chains untouched when the snapshot carries none (historical versions)", () => {
  const legacySnapshot = JSON.parse(JSON.stringify({
    ...buildVersionSnapshot({ remix: sessionRow(), tracks: [trackRow()], clips: [clipRow()], automation: [automationRow()] }),
    masterInserts: undefined,
  }));
  delete legacySnapshot.masterInserts;
  legacySnapshot.tracks[0].inserts = undefined;
  delete legacySnapshot.tracks[0].inserts;

  const state = normaliseRemixState(legacySnapshot)!;
  const trackFields = restoredTrackFields("s", state.tracks[0]);
  const sessionFields = restoredSessionFields(state, { name: "S", version: 1 });
  assert.equal(trackFields.inserts, undefined, "no chain in snapshot → column untouched, not cleared");
  assert.equal(sessionFields.masterInserts, undefined);
});
