import test from "node:test";
import assert from "node:assert/strict";

import { midiAnalysisReadinessError } from "./midi-analysis-readiness";

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
