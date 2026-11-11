import assert from "node:assert/strict";
import test from "node:test";

import { currentEvidenceValue, measuredEvidence, unavailableEvidence } from "./musical-evidence";

test("evidence consumers reject a measured value from a different source checksum", () => {
  const evidence = measuredEvidence(
    { bpm: 120 },
    {
      analysisId: "analysis-current-for-another-version",
      analysisEngine: "test-engine",
      analysisEngineVersion: "1.0.0",
      sourceChecksumSha256: "a".repeat(64),
      persistence: "database",
    },
  );

  assert.equal(currentEvidenceValue(evidence, "b".repeat(64)), null);
  assert.deepEqual(currentEvidenceValue(evidence, "a".repeat(64)), { bpm: 120 });
});

test("unavailable measurements do not become values for a matching source", () => {
  assert.equal(
    currentEvidenceValue(unavailableEvidence<{ bpm: number }>("No analysis was saved."), "a".repeat(64)),
    null,
  );
});
