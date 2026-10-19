import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInsert, serializeInserts } from "../mixer/inserts";
import { encodeWav16, decodeWav16 } from "../mixer/synth";
import { requireTool } from "../ffmpeg";
import { parseExportSnapshot } from "./export";
import { bounceInsertBuses, insertBounceRequired } from "./export-inserts";

const gain = makeInsert("gain", { gainDb: -6 })!;
const snapshot = () => ({ masterVolume: 1, masterInserts: JSON.stringify([gain]), tracks: [{ id: "track", stemAssetId: "stem", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false, inserts: serializeInserts([gain]), phaseInverted: true, clips: [] }] });
test("export reads versioned serialized/array/wrapped chains and phase; legacy versions remain dry", () => {
  const state = parseExportSnapshot(JSON.stringify(snapshot())); assert.equal(state.masterInserts[0].params.gainDb, -6); assert.equal(state.tracks[0].inserts[0].processor, "gain"); assert.equal(state.tracks[0].phaseInverted, true);
  const legacy = snapshot() as Record<string, any>; delete legacy.masterInserts; delete legacy.tracks[0].inserts; delete legacy.tracks[0].phaseInverted;
  const dry = parseExportSnapshot(JSON.stringify(legacy)); assert.deepEqual(dry.masterInserts, []); assert.equal(insertBounceRequired(dry.tracks, dry.masterInserts), false);
});
for (const raw of ["{bad-json", [{ ...gain, processor: "not-implemented" }], [{ ...gain, params: { gainDb: NaN } }]]) test(`invalid chain must fail export instead of silently bypassing it: ${JSON.stringify(raw)}`, () => {
  const invalid = snapshot(); invalid.masterInserts = JSON.stringify(raw);
  assert.throws(() => parseExportSnapshot(JSON.stringify(invalid)), /insert chain/i);
});
test("real floating-point bus render applies phase and track/master FX before final quantization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-fx-bus-")); t.after(() => rm(root, { recursive: true, force: true }));
  const samples = new Float32Array(44100 * 2); samples.fill(0.25);
  const source = join(root, "source.wav"), output = join(root, "out.wav"); await writeFile(source, encodeWav16(samples, 44100));
  const options = { ffmpeg: (await requireTool("ffmpeg")).path, directory: root, inputs: ["-i", source], filters: ["[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo[bus]"], buses: [{ label: "[bus]", phaseInverted: true, inserts: [gain] }], masterVolume: 0.5, masterInserts: [gain], sampleRate: 44100, timelineSamples: 44100, outputPath: output };
  await bounceInsertBuses(options); const decoded = decodeWav16(new Uint8Array(await readFile(output)))!;
  assert.ok(Math.abs(decoded.samples[200] - -0.25 * 0.5 * 10 ** (-12 / 20)) < 0.0001);
  await assert.rejects(bounceInsertBuses({ ...options, timelineSamples: 44100 * 301 }), /limited to 5 minutes/);
});
test("wet/bypass detection does not force processing a dry legacy arrangement", () => {
  assert.equal(insertBounceRequired([{ phaseInverted: false, inserts: [{ ...gain, enabled: false }] }], []), false);
  assert.equal(insertBounceRequired([{ phaseInverted: false, inserts: [{ ...gain, wet: 0 }] }], []), false);
  assert.equal(insertBounceRequired([{ phaseInverted: false, inserts: [] }], [gain]), true);
});
