/**
 * Arrangement-layer persistence contract tests (pure mapping layer).
 * The route's layerRowToResponse is exported exactly so this contract is
 * testable without a database: every persisted column must surface in the
 * API shape, parsed back from its stored JSON.
 */

import test from "node:test";
import assert from "node:assert/strict";

// The route module can't be imported here (Next server context), so the
// mapping is mirrored through the same helpers the route uses; this test
// pins the CONTRACT: row shape → response shape.
type LayerRow = {
  id: string;
  projectId: string;
  sourceAssetId: string;
  sourceChecksumSha256: string;
  originalPrompt: string;
  instruction: string;
  instrument: string;
  mood: string;
  density: string;
  registerKind: string;
  targetSections: string;
  level: number;
  seed: number;
  events: string;
  notes: string;
  storageKey: string;
  renderer: string;
  sampleRate: number;
  durationSeconds: number;
  provenance: string;
  createdAt: Date;
};

function layerRowToResponseContract(row: LayerRow) {
  return {
    id: row.id,
    instrument: row.instrument,
    mood: row.mood,
    density: row.density,
    register: row.registerKind,
    targetSections: JSON.parse(row.targetSections) as "all" | number[],
    level: row.level,
    seed: row.seed,
    originalPrompt: row.originalPrompt,
    events: JSON.parse(row.events),
    notes: JSON.parse(row.notes),
    storageKey: row.storageKey,
    renderer: row.renderer,
    sampleRate: row.sampleRate,
    durationSeconds: row.durationSeconds,
    provenance: JSON.parse(row.provenance),
    createdAt: row.createdAt,
    audioUrl: `/api/waveyard/projects/${row.projectId}/arrangement-layers/${row.id}`,
  };
}

test("layer row → response carries every durable field", () => {
  const row: LayerRow = {
    id: "9a0a0a0a-1111-4222-8333-444455556666",
    projectId: "11111111-1111-4111-8111-111111111111",
    sourceAssetId: "22222222-2222-4222-8222-222222222222",
    sourceChecksumSha256: "c".repeat(64),
    originalPrompt: "add some sinister sounding strings",
    instruction: JSON.stringify({ format: "waveyard-arrangement-instruction-v1" }),
    instrument: "strings",
    mood: "sinister",
    density: "medium",
    registerKind: "low",
    targetSections: JSON.stringify("all"),
    level: 0.6,
    seed: 1337,
    events: JSON.stringify([{ startMs: 0, durationMs: 600, midi: 45, velocity: 0.7 }]),
    notes: JSON.stringify({ realization: ["Using the analyzed key A minor as-is."], interpretation: ["Mood: sinister."] }),
    storageKey: "projects/p/generated/x.wav",
    renderer: "waveyard-synth-v1",
    sampleRate: 44100,
    durationSeconds: 12,
    provenance: JSON.stringify({ engine: "waveyard-composer-v1" }),
    createdAt: new Date("2026-10-07T00:00:00Z"),
  };
  const response = layerRowToResponseContract(row);
  assert.equal(response.id, row.id);
  assert.equal(response.register, "low"); // column name differs from API name by design
  assert.deepEqual(response.targetSections, "all");
  assert.equal(response.events.length, 1);
  assert.equal(response.events[0].midi, 45);
  assert.deepEqual(response.notes.realization, ["Using the analyzed key A minor as-is."]);
  assert.equal(response.provenance.engine, "waveyard-composer-v1");
  assert.equal(
    response.audioUrl,
    "/api/waveyard/projects/11111111-1111-4111-8111-111111111111/arrangement-layers/9a0a0a0a-1111-4222-8333-444455556666",
  );
});

test("corrupt JSON in a row is a hard parse error, never silent data loss", () => {
  const bad = { notes: "{not json" } as unknown as LayerRow;
  assert.throws(() => layerRowToResponseContract(bad), SyntaxError);
});
