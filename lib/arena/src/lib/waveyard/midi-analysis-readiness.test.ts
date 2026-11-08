import test from "node:test";
import assert from "node:assert/strict";

import { midiAnalysisReadinessError, resolveMidiTempoBpm } from "./midi-analysis-readiness";

test("MIDI export requires complete current analysis for every analysis kind", () => {
  for (const kind of ["vocal", "drums", "harmony"] as const) {
    assert.deepEqual(midiAnalysisReadinessError(kind, "queued", null), {
      status: 409,
      error: `Complete ${kind === "drums" ? "drum" : kind} analysis is required for MIDI export.`,
    });
    assert.equal(midiAnalysisReadinessError(kind, "complete", "analysis_stale")?.status, 409);
    assert.equal(midiAnalysisReadinessError(kind, "complete", "analysis_version_mismatch")?.status, 409);
    assert.equal(midiAnalysisReadinessError(kind, "complete", null), null);
  }
});

test("MIDI tempo prefers an explicit export value, then matching-source analysis, then the SMF default", () => {
  assert.equal(resolveMidiTempoBpm(132, 96), 132);
  assert.equal(resolveMidiTempoBpm(null, 96), 96);
  assert.equal(resolveMidiTempoBpm(Number.NaN, 96), 96);
  assert.equal(resolveMidiTempoBpm(301, 0), 120);
  assert.equal(resolveMidiTempoBpm(null, null), 120);
});
