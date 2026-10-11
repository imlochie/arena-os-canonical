/**
 * REAL-ONNXRUNTIME pipeline smoke test — Layer D evidence (mandate §5).
 *
 * What this proves: the separation pipeline executes end to end with a REAL
 * onnxruntime-node InferenceSession — real session creation from a model
 * FILE, real tensor marshaling ([1, 4, dim_f, dim_t] float32 in and out),
 * the real STFT → chunk → inference → overlap-add → ISTFT path, and real
 * persistence — against the same PGlite + local-storage + ffmpeg fixture
 * the fake-session e2e uses.
 *
 * What this does NOT prove: separation quality. The registry model weights
 * (Kim_Vocal_2.onnx, 66.8 MB, sha-pinned) cannot be downloaded in this
 * environment (network policy) and must never be fabricated — so this test
 * injects a hand-crafted REAL ONNX model whose graph is a pass-through
 * (Identity). The assertions are therefore SIGNAL-PATH assertions:
 *
 *   primary stem ≈ the source mixture   (the entire STFT→ORT→ISTFT chain
 *                                        reconstructs what went in)
 *   secondary stem = mixture − primary  (the stem-sum guarantee)
 *
 * A bug in tensor marshaling, session wiring, chunk overlap-add, or the
 * encode/persist path fails here. A bug in the separation MODEL cannot be
 * caught by anything but the real weights — that gap is recorded in
 * docs/waveyard-vision.md (acceptance protocol) and closed only by the
 * owner's real-machine acceptance run.
 *
 * The crafted model is opened through the same production call the engine
 * uses (ort.InferenceSession.create(path, { executionProviders: ["cpu"] }));
 * the sha verification this bypasses via the openEngine seam is exactly the
 * check that would refuse this ~300-byte stand-in in production — by design.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { decodeWav16 } from "@/lib/waveyard/mixer/synth";
import { getStorage } from "@/lib/waveyard/storage";
import { stemAssets, processingJobs } from "@/db/waveyardSchema";
import { findMdxModel } from "@/lib/waveyard/separation/mdx";
import type { OpenedEngine } from "./separation";
import { handleSeparationJob } from "./separation";
import { fixture, payloadOf, SAMPLES, snrDb, type SeparationFixture } from "./separation-fixtures";

const KIM = findMdxModel("kim_vocal_2")!;

// ------------------------------------------------------ hand-crafted ONNX
// Minimal protobuf writer: exactly the fields a loadable ONNX ModelProto
// needs — ir_version, one opset import, a graph with one Identity node,
// typed input/output value infos. (No initializers needed.)

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function tag(field: number, wire: 0 | 2): number[] {
  return varint((field << 3) | wire);
}

function lenDelimited(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function intField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function stringField(field: number, value: string): number[] {
  return lenDelimited(field, [...Buffer.from(value, "utf8")]);
}

/** TypeProto: tensor_type { elem_type: FLOAT(1), shape { dim... } }. */
function tensorType(elemType: number, dims: number[]): number[] {
  const shape = dims.flatMap((d) => lenDelimited(1, intField(1, d)));
  const tensorTypeBody = [...intField(1, elemType), ...lenDelimited(2, shape)];
  return lenDelimited(1, tensorTypeBody);
}

/** ValueInfoProto: name + type. */
function valueInfo(name: string, dims: number[]): number[] {
  return [...stringField(1, name), ...lenDelimited(2, tensorType(1, dims))];
}

/** A real, loadable ONNX model: one Identity node, input "input" → output "output". */
export function craftPassthroughOnnx(dimF: number, dimT: number): Buffer {
  const node = [
    ...lenDelimited(1, [...Buffer.from("input", "utf8")]), // node.input
    ...lenDelimited(2, [...Buffer.from("output", "utf8")]), // node.output
    ...stringField(3, "passthrough"), // node.name
    ...stringField(4, "Identity"), // node.op_type
  ];
  const graph = [
    ...lenDelimited(1, node), // graph.node
    ...stringField(2, "waveyard-plumbing-probe"), // graph.name
    ...lenDelimited(11, valueInfo("input", [1, 4, dimF, dimT])), // graph.input
    ...lenDelimited(12, valueInfo("output", [1, 4, dimF, dimT])), // graph.output
  ];
  const opset = [...intField(2, 13)]; // OperatorSetIdProto { version: 13 }
  const model = [
    ...intField(1, 8), // ir_version
    ...lenDelimited(7, graph), // graph
    ...lenDelimited(8, opset), // opset_import
  ];
  return Buffer.from(model);
}

/** The real-ORT engine: opens the crafted model with the PRODUCTION call.
 *  The handler owns the session's lifetime (it calls release()); the test
 *  must not double-release. */
async function realOrtEngine(f: SeparationFixture): Promise<{ engine: (spec: unknown) => Promise<OpenedEngine> }> {
  const ort = (await import("onnxruntime-node")) as unknown as {
    InferenceSession: {
      create(path: string, options?: { executionProviders?: string[] }): Promise<{
        run(feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
        release(): Promise<void>;
      }>;
    };
    Tensor: new (type: "float32", data: Float32Array, dims: number[]) => { data: Float32Array; dims: number[] };
  };
  const modelFile = join(f.modelsDir, "plumbing-probe.onnx");
  await writeFile(modelFile, craftPassthroughOnnx(KIM.params.dimF, KIM.params.dimT));
  const session = await ort.InferenceSession.create(modelFile, { executionProviders: ["cpu"] });
  return {
    engine: async () => ({
      infer: async (spek, cfg, frames) => {
        const tensor = new ort.Tensor("float32", spek, [1, 4, cfg.dimF, frames]);
        const outputs = await session.run({ input: tensor });
        const out = outputs[Object.keys(outputs)[0]];
        if (!out || !(out.data instanceof Float32Array)) throw new Error("real session returned no float32 output");
        if (out.data.length !== 4 * cfg.dimF * frames) throw new Error(`real session geometry mismatch: ${out.data.length}`);
        return out.data;
      },
      release: async () => {
        await session.release();
      },
      resolvedDevice: "cpu",
    }),
  };
}

test("real onnxruntime session: the separation pipeline executes and reconstructs the signal", { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const real = await realOrtEngine(f);

    const startedAt = Date.now();
    await handleSeparationJob(payloadOf(f), { db: f.database, openEngine: real.engine as never });
    const elapsedMs = Date.now() - startedAt;

    // The durable job completed honestly.
    const [row] = await f.database.select().from(processingJobs).where(eq(processingJobs.id, f.job.id));
    assert.equal(row.status, "complete", "job completed with the real runtime");
    assert.equal(row.resolvedDevice, "cpu");
    assert.equal(row.errorCode, null);

    // Both stems persisted as real WAV objects.
    const stems = await f.database.select().from(stemAssets).where(eq(stemAssets.separationJobId, f.job.id));
    assert.equal(stems.length, 2, "vocals + instrumental rows");
    const byType = new Map(stems.map((stem) => [stem.stemType, stem]));
    const primary = byType.get("vocals")!;
    const secondary = byType.get("instrumental")!;
    assert.ok(primary && secondary);
    for (const stem of stems) {
      assert.equal(stem.sampleRate, 44_100);
      assert.equal(stem.channels, 2);
      assert.equal(stem.durationSeconds, 1);
      const stored = getStorage().getLocalPath(stem.storageKey);
      assert.ok(stored, "stem object exists in storage");
      const bytes = new Uint8Array(await readFile(stored!));
      assert.equal(bytes.length, 44 + SAMPLES * 4, "16-bit stereo WAV size");
    }

    // SIGNAL-PATH arithmetic: the real STFT → real ORT Identity → real
    // overlap-add chain must reconstruct the source (primary ≈ mix), and the
    // stem-sum guarantee holds (secondary = mix − primary·compensate).
    const sourceDecoded = decodeWav16(new Uint8Array(await readFile(f.sourcePath)))!;
    const primaryDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(primary.storageKey)!)))!;
    const secondaryDecoded = decodeWav16(new Uint8Array(await readFile(getStorage().getLocalPath(secondary.storageKey)!)))!;
    assert.ok(sourceDecoded && primaryDecoded && secondaryDecoded);
    const trim = 3840; // the engine discards padded edges; assert the interior
    const snrPrimary = snrDb(primaryDecoded.samples, sourceDecoded.samples, trim * 2, (SAMPLES - trim) * 2);
    assert.ok(snrPrimary > 60, `real-ORT primary reconstructs the source through the whole chain (got ${snrPrimary.toFixed(1)} dB)`);

    // The engine derives secondary = mix − compensate·primary, so the sum
    // guarantee is compensate·primary + secondary = mix — the reconstruction
    // error of the whole STFT→ORT→ISTFT chain appears once, plus 16-bit
    // quantization on both stems.
    let maxSumError = 0;
    for (let i = trim * 2; i < (SAMPLES - trim) * 2; i += 1) {
      const lhs = KIM.params.compensate * primaryDecoded.samples[i] + secondaryDecoded.samples[i];
      maxSumError = Math.max(maxSumError, Math.abs(lhs - sourceDecoded.samples[i]));
    }
    assert.ok(maxSumError < 5e-3, `stem-sum guarantee through the real chain (max error ${maxSumError.toExponential(2)})`);

    // Honest record: this elapsed time is the PLUMBING cost (STFT + real ORT
    // Identity + overlap-add on 1 s of audio), NOT a separation benchmark —
    // the real model's conv nets are the missing variable. Recorded for the
    // acceptance protocol's baseline comparison.
    assert.ok(elapsedMs > 0);
  } finally {
    await f.close();
  }
});
