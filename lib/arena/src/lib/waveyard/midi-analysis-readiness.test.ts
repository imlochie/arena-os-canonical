import test from "node:test";
import assert from "node:assert/strict";

import { midiAnalysisReadinessError, currentMidiSourceTempo, resolveMidiTempoBpm } from "./midi-analysis-readiness";
import { DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "./types/analysis-provenance";

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

test("implicit MIDI tempo requires current analysis provenance and the exact source checksum", () => {
  const analysis = {
    status: "complete",
    sourceChecksumSha256: "source-v2",
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    bpm: 96,
    bpmConfidence: 0,
  };
  assert.equal(currentMidiSourceTempo(analysis, "source-v2"), 96);
  assert.equal(currentMidiSourceTempo(analysis, "source-v1"), null);
  assert.equal(currentMidiSourceTempo({ ...analysis, status: "failed" }, "source-v2"), null);
  assert.equal(currentMidiSourceTempo({ ...analysis, bpmConfidence: null }, "source-v2"), null);
  assert.equal(currentMidiSourceTempo({ ...analysis, analysisEngineVersion: "1.3.0" }, "source-v2"), null);
  assert.equal(currentMidiSourceTempo({ ...analysis, analysisEngine: "waveyard-numpy-dsp" }, "source-v2"), null);
});
