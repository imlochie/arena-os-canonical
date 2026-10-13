/**
 * Deep bridge tests — the engine the owner prepares, through its real
 * process seam (stub python drivers, a real spawn, real files on disk).
 *
 * Covered: the cheap probe (prepared / not prepared, cached), interpreter
 * precedence (WAVEYARD_DEEP_PYTHON wins), the exact Demucs contract the
 * bridge asks for, device resolution, the engine's own progress stream, and
 * every honest failure: no Demucs, missing/empty output, non-zero exit, CUDA
 * requested without CUDA.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { DEEP_MODEL_ID, DEEP_STEM_TYPES } from "@/lib/waveyard/separation/modes";
import { DEEP_MODEL_NAME, deepPrepareHint, probeDeepEngine, resetDeepProbeCacheForTests, runDeepSeparation } from "./deep";
import { SeparationUnavailableError } from "./session";
import { writeStubDeepPython } from "./deep-fixtures";

/** A tiny real 44.1 kHz stereo WAV the stub copies for every stem. */
async function writeFixtureWav(directory: string): Promise<string> {
  const samples = new Float32Array(4_410 * 2);
  for (let i = 0; i < 4_410; i += 1) {
    samples[i * 2] = Math.sin((2 * Math.PI * 440 * i) / 44_100) * 0.4;
    samples[i * 2 + 1] = Math.cos((2 * Math.PI * 440 * i) / 44_100) * 0.4;
  }
  const path = join(directory, "fixture.wav");
  await writeFile(path, encodeWav16(samples, 44_100));
  return path;
}

async function setup(options: Parameters<typeof writeStubDeepPython>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wy-deep-stub-"));
  const fixture = await writeFixtureWav(directory);
  const stub = await writeStubDeepPython(directory, fixture, options);
  const callLog = join(directory, "calls.log");
  const env: NodeJS.ProcessEnv = { ...process.env, WAVEYARD_DEEP_PYTHON: stub, STUB_CALL_LOG: callLog };
  resetDeepProbeCacheForTests();
  return {
    directory,
    fixture,
    stub,
    env,
    async calls(): Promise<string[]> {
      const raw = await readFile(callLog, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean);
    },
    async close() {
      resetDeepProbeCacheForTests();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("unprepared machine: the probe reports exactly why, and the run refuses honestly", async () => {
  const f = await setup({ demucsVersion: null });
  try {
    const status = probeDeepEngine({ env: f.env });
    assert.equal(status.prepared, false);
    assert.match(status.prepared ? "" : status.reason, /Demucs is not installed/);
    assert.match(status.prepared ? "" : status.reason, /pip install demucs/);
    assert.equal(status.modelId, DEEP_MODEL_ID);
    assert.deepEqual(status.stems, [...DEEP_STEM_TYPES]);

    await assert.rejects(
      () =>
        runDeepSeparation({
          inputPath: f.fixture,
          outputDirectory: join(f.directory, "out"),
          env: f.env,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SeparationUnavailableError, "typed unavailable error");
        assert.match(error.message, /Demucs is not installed/);
        assert.match(error.message, /pip install demucs/);
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("prepared machine: probe resolves the interpreter, its version, and is cached", async () => {
  const f = await setup({ demucsVersion: "4.0.1", cuda: true });
  try {
    const status = probeDeepEngine({ env: f.env });
    assert.equal(status.prepared, true);
    if (!status.prepared) return;
    assert.equal(status.python, f.stub, "the explicit WAVEYARD_DEEP_PYTHON wins");
    assert.equal(status.pythonSource, "env");
    assert.equal(status.demucsVersion, "4.0.1");
    assert.equal(status.modelName, DEEP_MODEL_NAME);

    // Cached: a second probe does not spawn again (one log line, the first).
    probeDeepEngine({ env: f.env });
    const calls = await f.calls();
    assert.equal(calls.length, 1, `one probe invocation, got ${calls.length}`);
  } finally {
    await f.close();
  }
});

test("deep run: the exact Demucs contract, six stems, real progress, honest device", async () => {
  const f = await setup({ demucsVersion: "4.0.1", cuda: false });
  try {
    const outputDirectory = join(f.directory, "deep-out");
    const progress: number[] = [];
    const result = await runDeepSeparation({
      inputPath: f.fixture,
      outputDirectory,
      env: f.env,
      onProgress: (percent) => progress.push(percent),
    });

    assert.equal(result.engine, "demucs");
    assert.equal(result.model, DEEP_MODEL_ID);
    assert.equal(result.modelName, DEEP_MODEL_NAME);
    assert.equal(result.modelVersion, `${DEEP_MODEL_NAME}@demucs-4.0.1`);
    assert.equal(result.resolvedDevice, "cpu");
    assert.deepEqual(
      result.stems.map((stem) => stem.stemType),
      [...DEEP_STEM_TYPES],
    );
    for (const stem of result.stems) {
      assert.ok(stem.bytes > 44, `${stem.stemType} has real bytes`);
      const bytes = await readFile(stem.path);
      assert.equal(bytes.length, stem.bytes);
    }
    // The engine's own percent, forwarded once per whole percent.
    assert.deepEqual(progress, [50, 100]);

    // What the bridge actually asked the interpreter for — including the
    // six-source model family and the resolved device.
    const calls = await f.calls();
    const runCall = calls.find((call) => call.includes("-m demucs"));
    assert.ok(runCall, "demucs was invoked");
    assert.match(runCall!, /--name htdemucs_6s/);
    assert.match(runCall!, /--device cpu/);
    assert.match(runCall!, new RegExp(`--out ${outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(runCall!, new RegExp(f.fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await f.close();
  }
});

test("auto device with CUDA available resolves to cuda and asks Demucs for it", async () => {
  const f = await setup({ demucsVersion: "4.0.1", cuda: true });
  try {
    const result = await runDeepSeparation({
      inputPath: f.fixture,
      outputDirectory: join(f.directory, "deep-out"),
      env: f.env,
    });
    assert.equal(result.resolvedDevice, "cuda");
    const calls = await f.calls();
    assert.ok(calls.some((call) => call.includes("-m demucs") && call.includes("--device cuda")));
  } finally {
    await f.close();
  }
});

test("cuda requested without CUDA: an honest refusal, no run attempted", async () => {
  const f = await setup({ demucsVersion: "4.0.1", cuda: false });
  try {
    await assert.rejects(
      () =>
        runDeepSeparation({
          inputPath: f.fixture,
          outputDirectory: join(f.directory, "deep-out"),
          requestedDevice: "cuda",
          env: f.env,
        }),
      /CUDA was requested but .*torch\.cuda\.is_available\(\) = false/,
    );
    const calls = await f.calls();
    assert.ok(!calls.some((call) => call.includes("-m demucs")), "demucs never ran");
  } finally {
    await f.close();
  }
});

test("an incomplete install (module missing at run time) is unavailable, not a crash", async () => {
  const f = await setup({
    demucsVersion: "4.0.1",
    runStderr: "ModuleNotFoundError: No module named 'demucs'",
  });
  try {
    await assert.rejects(
      () =>
        runDeepSeparation({
          inputPath: f.fixture,
          outputDirectory: join(f.directory, "deep-out"),
          env: f.env,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SeparationUnavailableError);
        assert.match(error.message, /No module named 'demucs'/);
        assert.match(error.message, /pip install demucs/, "carries the prepare step");
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("a failing engine surfaces its own tail — never a silent success", async () => {
  const f = await setup({ demucsVersion: "4.0.1", runStderr: "CUDA out of memory", runExitCode: 2 });
  try {
    await assert.rejects(
      () =>
        runDeepSeparation({
          inputPath: f.fixture,
          outputDirectory: join(f.directory, "deep-out"),
          env: f.env,
        }),
      (error: unknown) => {
        assert.ok(!(error instanceof SeparationUnavailableError), "a broken run is a failure, not unavailability");
        assert.match(error instanceof Error ? error.message : "", /Demucs failed \(exit 2\): CUDA out of memory/);
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("missing or empty stem output: nothing is returned, the gaps are named", async () => {
  const f = await setup({ demucsVersion: "4.0.1", stems: ["vocals", "drums", "bass", "other"], emptyStems: ["other"] });
  try {
    await assert.rejects(
      () =>
        runDeepSeparation({
          inputPath: f.fixture,
          outputDirectory: join(f.directory, "deep-out"),
          env: f.env,
        }),
      /without usable output for: guitar, piano/,
    );
  } finally {
    await f.close();
  }
});

test("the prepare hint names the interpreter command for this platform", () => {
  const hint = deepPrepareHint();
  assert.match(hint, /pip install demucs/);
  assert.match(hint, /WAVEYARD_DEEP_PYTHON/);
});
