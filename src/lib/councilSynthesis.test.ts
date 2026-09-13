import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactRequestPayload,
  normalizeSynthesisProse,
  parseCouncilSynthesis,
  renderArtifactFromSynthesis,
  validateCouncilSynthesis,
  type ArtifactRequest,
  type CouncilSynthesis,
} from "./councilSynthesis";

const valid: CouncilSynthesis = {
  version: 1,
  title: "A decision brief",
  thesis: "Run the smallest reversible experiment before committing.",
  keyInsights: ["The largest uncertainty is demand."],
  disagreements: ["Speed was favored over completeness."],
  decisions: ["Test for two weeks."],
  openQuestions: ["What is the success threshold?"],
  recommendations: ["Define one measurable outcome."],
  sections: [{ heading: "Experiment", points: ["Recruit five participants."] }],
};

test("validates the canonical synthesis contract", () => {
  assert.deepEqual(validateCouncilSynthesis(valid), valid);
  assert.equal(validateCouncilSynthesis({ ...valid, recommendations: [] }), null);
  assert.equal(validateCouncilSynthesis({ ...valid, thesis: "x".repeat(1601) }), null);
});

test("extracts fenced JSON but rejects malformed model output", () => {
  assert.deepEqual(parseCouncilSynthesis(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), valid);
  assert.equal(parseCouncilSynthesis("Here is a nice prose answer, not the contract."), null);
});

test("normalizes non-JSON offline prose into a validated bounded contract", () => {
  const synthesis = normalizeSynthesisProse(
    "## Bottom line\nChoose the reversible path because it tests demand cheaply.\n- Define success first.\n- Run a two-week test.\nWhat threshold counts as success?",
    "Fallback title"
  );
  assert.ok(validateCouncilSynthesis(synthesis));
  assert.ok(synthesis.keyInsights.length > 0);
  assert.ok(synthesis.recommendations.length > 0);
});

test("artifact boundary allowlists data and excludes transcript fields", () => {
  const request = {
    sourceSessionId: "session-1",
    artifactType: "brief",
    synthesis: valid,
    provenance: {
      mode: "council",
      jobId: "thinking_instrument",
      modelIds: ["a", "b"],
      synthesisModel: "s",
      normalization: "model_json",
    },
    transcript: "SECRET RAW COUNCIL TRANSCRIPT",
    prompt: "SECRET SYSTEM PROMPT",
  } as unknown as ArtifactRequest;
  const payload = artifactRequestPayload(request);
  assert.doesNotMatch(payload, /SECRET|transcript|SYSTEM PROMPT/);
  assert.match(payload, /sourceSessionId/);
});

test("deterministic artifact renders meaning without provenance or JSON keys", () => {
  const request: ArtifactRequest = {
    sourceSessionId: "session-1",
    artifactType: "brief",
    synthesis: valid,
    provenance: {
      mode: "council",
      jobId: "thinking_instrument",
      modelIds: ["a", "b"],
      synthesisModel: "s",
      normalization: "model_json",
    },
  };
  const artifact = renderArtifactFromSynthesis(request);
  assert.match(artifact, /smallest reversible experiment/);
  assert.doesNotMatch(artifact, /sourceSessionId|modelIds|thinking_instrument/);
});
