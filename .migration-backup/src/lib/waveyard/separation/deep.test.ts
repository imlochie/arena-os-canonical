/**
 * Deep bridge tests — the engine the owner prepares, through its real
 * process seam: a REAL Python interpreter running a stand-in Demucs (see
 * deep-fixtures.ts), a real spawn, real files on disk, a dummy checkpoint.
 *
 * Covered: the cheap probe (not installed / installed without the local
 * checkpoint / prepared, cached per interpreter set with the checkpoint
 * re-checked live), interpreter precedence (WAVEYARD_DEEP_PYTHON wins), the
 * exact Demucs contract the bridge asks for (`--repo <models dir>` and the
 * checkpoint's signature — never the remote weight store), the provenance
 * string, device resolution, the engine's own progress stream, and every
 * honest failure: no Demucs, no checkpoint, a checkpoint Demucs refuses,
 * missing/empty output, non-zero exit, CUDA requested without CUDA.
 *
 * What these tests do NOT prove: real inference. The checkpoint is a dummy
 * and the Demucs is a fake — the readiness gate and the invocation contract
 * are verified; six-stem quality on real audio is an owner-machine
 * acceptance item (ADR-007).
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { encodeWav16 } from "@/lib/waveyard/mixer/synth";
import { DEEP_MODEL_ID, DEEP_STEM_TYPES } from "@/lib/waveyard/separation/modes";
import {
  DEEP_CHECKPOINT_FILE,
  DEEP_MODEL_NAME,
  DEEP_MODEL_SIGNATURE,
  deepCheckpointPath,
  deepModelVersion,
  deepPrepareHint,
  probeDeepEngine,
  resetDeepProbeCacheForTests,
  runDeepSeparation,
} from "./deep";
import { SeparationUnavailableError } from "./session";
import { NO_TEST_PYTHON, writeStubDeepEngine, type StubDeepOptions } from "./deep-fixtures";

/** A tiny real 44.1 kHz stereo WAV the stand-in copies for every stem. */
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function setup(t: TestContext, options: StubDeepOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wy-deep-stub-"));
  const fixture = await writeFixtureWav(directory);
  const engine = await writeStubDeepEngine(directory, fixture, options);
  if (engine === null) {
    await rm(directory, { recursive: true, force: true });
    t.skip(NO_TEST_PYTHON);
    return null;
  }
  resetDeepProbeCacheForTests();
  return {
    directory,
    fixture,
    engine,
    env: engine.env,
    async close() {
      resetDeepProbeCacheForTests();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("unprepared machine (no Demucs): the probe reports exactly why, and the run refuses honestly", async (t) => {
  const f = await setup(t, { demucsVersion: null });
  if (f === null) return;
  try {
    const status = probeDeepEngine({ env: f.env });
    assert.equal(status.prepared, false);
    if (status.prepared) return;
    assert.match(status.reason, /Demucs is not installed/);
    assert.match(status.reason, /pip install demucs/);
    assert.equal(status.python, null);
    assert.equal(status.modelId, DEEP_MODEL_ID);
    assert.deepEqual(status.stems, [...DEEP_STEM_TYPES]);
    // The checkpoint path is reported for the env that was probed, present or not.
    assert.equal(status.checkpointPath, f.engine.checkpointPath);
    assert.equal(status.checkpointPresent, true, "the dummy checkpoint is there — the gap is the interpreter");

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
    const calls = await f.engine.calls();
    assert.ok(!calls.some((call) => call.includes("-m demucs")), "demucs never ran");
  } finally {
    await f.close();
  }
});

test("Demucs installed but no local checkpoint: not prepared, and the reason names the exact configured path", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", checkpoint: false });
  if (f === null) return;
  try {
    const expectedPath = join(f.engine.modelsDir, DEEP_CHECKPOINT_FILE);
    const status = probeDeepEngine({ env: f.env });
    assert.equal(status.prepared, false);
    if (status.prepared) return;
    assert.equal(status.checkpointPath, expectedPath);
    assert.equal(status.checkpointPresent, false);
    assert.equal(status.python, f.engine.python, "the interpreter is fine — the reason says which gap remains");
    assert.equal(status.demucsVersion, "4.0.1");
    assert.match(status.reason, /Demucs 4\.0\.1 is ready/);
    assert.ok(status.reason.includes(expectedPath), `the reason names the probed path: ${status.reason}`);
    assert.ok(
      !status.reason.includes(resolve(process.cwd(), ".data/waveyard-models")),
      "never the default models dir when WAVEYARD_MODELS_DIR is overridden",
    );
    assert.match(status.reason, /nothing is downloaded from here/);

    await assert.rejects(
      () => runDeepSeparation({ inputPath: f.fixture, outputDirectory: join(f.directory, "out"), env: f.env }),
      (error: unknown) => {
        assert.ok(error instanceof SeparationUnavailableError);
        assert.ok(error.message.includes(expectedPath), "the run's refusal carries the same exact path");
        return true;
      },
    );
    const calls = await f.engine.calls();
    assert.ok(!calls.some((call) => call.includes("-m demucs")), "demucs never ran without the checkpoint");

    // Placing the file flips readiness immediately — the interpreter probe
    // is cached, the checkpoint is checked live (no restart, no cache reset).
    await writeFile(expectedPath, "dummy checkpoint placed after the first probe\n");
    const after = probeDeepEngine({ env: f.env });
    assert.equal(after.prepared, true, "ready as soon as the checkpoint exists");
    assert.equal((await f.engine.calls()).filter((call) => call.startsWith("-c")).length, 1, "no second interpreter probe");

    // And removing it takes readiness away again — a run never starts on a vanished file.
    await unlink(expectedPath);
    assert.equal(probeDeepEngine({ env: f.env }).prepared, false);
  } finally {
    await f.close();
  }
});

test("prepared machine: probe resolves the interpreter, its version, the checkpoint, and is cached", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", cuda: true });
  if (f === null) return;
  try {
    const status = probeDeepEngine({ env: f.env });
    assert.equal(status.prepared, true);
    if (!status.prepared) return;
    assert.equal(status.python, f.engine.python, "the explicit WAVEYARD_DEEP_PYTHON wins");
    assert.equal(status.pythonSource, "env");
    assert.equal(status.demucsVersion, "4.0.1");
    assert.equal(status.modelName, DEEP_MODEL_NAME);
    assert.equal(status.checkpointPath, deepCheckpointPath(f.env));
    assert.equal(status.checkpointPath, join(f.engine.modelsDir, DEEP_CHECKPOINT_FILE));
    assert.equal(status.checkpointPresent, true);

    // Cached: a second probe does not spawn again (one log line, the first).
    probeDeepEngine({ env: f.env });
    const calls = await f.engine.calls();
    assert.equal(calls.length, 1, `one probe invocation, got ${calls.length}: ${calls.join(" | ")}`);
    assert.match(calls[0], /^-c /, "the probe is a -c snippet");
    assert.match(calls[0], /importlib\.metadata/, "…that reads package metadata (never imports torch)");
  } finally {
    await f.close();
  }
});

test("deep run: the exact Demucs contract — local repo + checkpoint signature — six stems, real progress, honest device", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", cuda: false });
  if (f === null) return;
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
    assert.equal(result.modelVersion, "htdemucs_6s@5c90dfd2-34c22ccb/demucs-4.0.1", "provenance pins family, checkpoint identity and engine version");
    assert.equal(result.modelVersion, deepModelVersion("4.0.1"));
    assert.equal(result.checkpointPath, f.engine.checkpointPath);
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

    // What the bridge actually asked the interpreter for: the checkpoint's
    // signature out of the configured models dir as a LOCAL repo — never
    // the family name against Demucs' remote weight store.
    const calls = await f.engine.calls();
    const runCall = calls.find((call) => call.includes("-m demucs"));
    assert.ok(runCall, "demucs was invoked");
    assert.match(runCall!, new RegExp(`--name ${DEEP_MODEL_SIGNATURE}(\\s|$)`));
    assert.ok(!/--name htdemucs_6s/.test(runCall!), "the family name would make Demucs look for a remote bag");
    assert.match(runCall!, new RegExp(`--repo ${escapeRegExp(f.engine.modelsDir)}(\\s|$)`));
    assert.match(runCall!, /--device cpu/);
    assert.match(runCall!, new RegExp(`--out ${escapeRegExp(outputDirectory)}`));
    assert.match(runCall!, new RegExp(escapeRegExp(f.fixture)));
  } finally {
    await f.close();
  }
});

test("auto device with CUDA available resolves to cuda and asks Demucs for it", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", cuda: true });
  if (f === null) return;
  try {
    const result = await runDeepSeparation({
      inputPath: f.fixture,
      outputDirectory: join(f.directory, "deep-out"),
      env: f.env,
    });
    assert.equal(result.resolvedDevice, "cuda");
    const calls = await f.engine.calls();
    assert.ok(calls.some((call) => call.includes("-m demucs") && call.includes("--device cuda")));
  } finally {
    await f.close();
  }
});

test("cuda requested without CUDA: an honest refusal, no run attempted", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", cuda: false });
  if (f === null) return;
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
    const calls = await f.engine.calls();
    assert.ok(!calls.some((call) => call.includes("-m demucs")), "demucs never ran");
  } finally {
    await f.close();
  }
});

test("an incomplete install (module missing at run time) is unavailable, not a crash", async (t) => {
  const f = await setup(t, {
    demucsVersion: "4.0.1",
    runStderr: "ModuleNotFoundError: No module named 'torch'",
  });
  if (f === null) return;
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
        assert.match(error.message, /No module named 'torch'/);
        assert.match(error.message, /pip install demucs/, "carries the prepare step");
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("a checkpoint Demucs refuses (bad checksum) is unavailable and names the file", async (t) => {
  const f = await setup(t, {
    demucsVersion: "4.0.1",
    runStderr: `demucs.repo.ModelLoadingError: Invalid checksum for file ${DEEP_CHECKPOINT_FILE}, expected 34c22ccb but got deadbeef`,
  });
  if (f === null) return;
  try {
    await assert.rejects(
      () => runDeepSeparation({ inputPath: f.fixture, outputDirectory: join(f.directory, "deep-out"), env: f.env }),
      (error: unknown) => {
        assert.ok(error instanceof SeparationUnavailableError, "a wrong file is a preparation problem, not an engine crash");
        assert.ok(error.message.includes(f.engine.checkpointPath), "names the exact checkpoint path");
        assert.match(error.message, /Invalid checksum/);
        assert.match(error.message, /nothing is downloaded from here/);
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("a failing engine surfaces its own tail — never a silent success", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", runStderr: "CUDA out of memory", runExitCode: 2 });
  if (f === null) return;
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

test("missing or empty stem output: nothing is returned, the gaps are named", async (t) => {
  const f = await setup(t, { demucsVersion: "4.0.1", stems: ["vocals", "drums", "bass", "other"], emptyStems: ["other"] });
  if (f === null) return;
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

test("the prepare hint names the interpreter command for this platform and the checkpoint path for the GIVEN environment", () => {
  const hint = deepPrepareHint();
  assert.match(hint, /pip install demucs/);
  assert.match(hint, /WAVEYARD_DEEP_PYTHON/);
  assert.ok(hint.includes(DEEP_CHECKPOINT_FILE));
  assert.ok(hint.includes(deepCheckpointPath()), "default env → default models dir");

  const custom = join(tmpdir(), "wy-custom-models-dir");
  const injected = deepPrepareHint({ ...process.env, WAVEYARD_MODELS_DIR: custom });
  assert.ok(injected.includes(join(custom, DEEP_CHECKPOINT_FILE)), `the injected models dir is reported: ${injected}`);
  assert.ok(!injected.includes(resolve(process.cwd(), ".data/waveyard-models")), "never the default when overridden");
});
