/**
 * Session-layer tests — all run WITHOUT the real onnxruntime module or any
 * model weights: the ort loader is injected (both a fake module and a
 * failing one), and model verification runs against temp files written by
 * the test. What is proven: the unavailable states are typed and honest,
 * checksum verification actually rejects wrong/corrupt/truncated files, the
 * tensor wiring ([1,4,dimF,dimT], input "input", output passthrough) is
 * correct, and geometry mismatches are caught rather than misinterpreted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMdxModel } from "./mdx";
import {
  SeparationUnavailableError,
  createMdxSession,
  resolveModelsDir,
  sessionInfer,
  setOrtLoaderForTests,
  verifyModelFile,
  type MdxSessionLike,
  type OrtModuleLike,
} from "./session";

const KIM = findMdxModel("kim_vocal_2")!;

function fakeOrt(session: MdxSessionLike): OrtModuleLike {
  return {
    InferenceSession: { create: async () => session },
    Tensor: class {
      data: Float32Array;
      dims: number[];
      constructor(_type: "float32", data: Float32Array, dims: number[]) {
        this.data = data;
        this.dims = dims;
      }
    },
  };
}

test.afterEach(() => setOrtLoaderForTests(null));

test("verifyModelFile: correct file passes, wrong content fails with the honest error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-models-"));
  try {
    // Correct digest: reuse the test's own writer with the right bytes.
    const bytes = Buffer.alloc(1_500_000, 7);
    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const spec = { ...KIM, file: "model.onnx", sha256: sha, sizeBytes: bytes.length };
    await writeFile(join(dir, "model.onnx"), bytes);
    const path = await verifyModelFile(spec, dir);
    assert.ok(path.endsWith("model.onnx"));

    // Corrupted: flip one byte.
    bytes[100] ^= 0xff;
    await writeFile(join(dir, "model.onnx"), bytes);
    await assert.rejects(() => verifyModelFile(spec, dir), SeparationUnavailableError);

    // Truncated: tiny file rejected before hashing.
    await writeFile(join(dir, "model.onnx"), Buffer.alloc(10));
    await assert.rejects(() => verifyModelFile(spec, dir), /truncated/i);

    // Missing entirely.
    await assert.rejects(() => verifyModelFile({ ...spec, file: "absent.onnx" }, dir), /not present/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createMdxSession: missing runtime is a typed unavailable error, never a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-models-"));
  try {
    const bytes = Buffer.alloc(1_200_000, 3);
    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const spec = { ...KIM, file: "model.onnx", sha256: sha, sizeBytes: bytes.length };
    await writeFile(join(dir, "model.onnx"), bytes);

    setOrtLoaderForTests(async () => null);
    await assert.rejects(() => createMdxSession(spec, { dir }), (err: unknown) => {
      assert.ok(err instanceof SeparationUnavailableError);
      assert.match(err.message, /onnxruntime-node is not available/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sessionInfer: feeds [1,4,dimF,dimT] under input name 'input' and returns the float32 output", async () => {
  let seenDims: number[] | null = null;
  let seenName: string | null = null;
  let seenSum = 0;
  const session: MdxSessionLike = {
    run: async (feeds) => {
      const key = Object.keys(feeds)[0];
      seenName = key;
      seenDims = feeds[key].dims;
      seenSum = feeds[key].data.reduce((a, b) => a + b, 0);
      const out = Float32Array.from(feeds[key].data, (v) => v * 2);
      return { output: { data: out, dims: feeds[key].dims } };
    },
    release: () => {},
  };
  const infer = sessionInfer(session);
  const spek = new Float32Array(4 * 3072 * 256);
  spek[0] = 1;
  spek[1] = 2.5;
  const out = await infer(spek, { nFft: 7680, hop: 1024, dimF: 3072 }, 256);
  assert.equal(seenName, "input");
  assert.deepEqual(seenDims, [1, 4, 3072, 256]);
  assert.ok(Math.abs(seenSum - 3.5) < 1e-6, "payload reaches the session unchanged");
  assert.equal(out.length, spek.length);
  assert.equal(out[0], 2, "output is the session's tensor data");
});

test("sessionInfer: geometry-mismatched output is rejected loudly", async () => {
  const session: MdxSessionLike = {
    run: async () => ({ output: { data: new Float32Array(11), dims: [1, 1, 1, 11] } }),
    release: () => {},
  };
  const infer = sessionInfer(session);
  await assert.rejects(
    () => infer(new Float32Array(4 * 3072 * 256), { nFft: 7680, hop: 1024, dimF: 3072 }, 256),
    /geometry mismatch/,
  );
});

test("resolveModelsDir honors WAVEYARD_MODELS_DIR and defaults beside the storage dir", () => {
  const prev = process.env.WAVEYARD_MODELS_DIR;
  try {
    process.env.WAVEYARD_MODELS_DIR = "/tmp/custom-models";
    assert.equal(resolveModelsDir(), "/tmp/custom-models");
    delete process.env.WAVEYARD_MODELS_DIR;
    const dir = resolveModelsDir();
    assert.ok(dir.endsWith(join(".data", "waveyard-models")), `default under .data, got ${dir}`);
  } finally {
    if (prev === undefined) delete process.env.WAVEYARD_MODELS_DIR;
    else process.env.WAVEYARD_MODELS_DIR = prev;
  }
});

test("createMdxSession: a real-shaped fake ort module wires end to end (verify → session → tensor)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wy-models-"));
  try {
    const bytes = Buffer.alloc(1_100_000, 9);
    const crypto = await import("node:crypto");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const spec = { ...KIM, file: "model.onnx", sha256: sha, sizeBytes: bytes.length };
    await writeFile(join(dir, "model.onnx"), bytes);

    const createdFrom: string[] = [];
    const session: MdxSessionLike = {
      run: async (feeds) => ({ out: { data: Float32Array.from(feeds.input.data), dims: feeds.input.dims } }),
      release: () => {},
    };
    setOrtLoaderForTests(async () => {
      return {
        InferenceSession: {
          create: async (path: string) => {
            createdFrom.push(path);
            return session;
          },
        },
        Tensor: class {
          data: Float32Array;
          dims: number[];
          constructor(_t: "float32", data: Float32Array, dims: number[]) {
            this.data = data;
            this.dims = dims;
          }
        },
      };
    });
    const opened = await createMdxSession(spec, { dir });
    assert.equal(createdFrom.length, 1);
    assert.ok(createdFrom[0].endsWith("model.onnx"), "session created from the VERIFIED file path");
    const infer = sessionInfer(opened);
    const spek = new Float32Array(4 * 3072 * 256).fill(0.5);
    const out = await infer(spek, { nFft: 7680, hop: 1024, dimF: 3072 }, 256);
    assert.equal(out.length, spek.length);
    assert.equal(out[0], 0.5, "fake session passthrough");
    await opened.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
