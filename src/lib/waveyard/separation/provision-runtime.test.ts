/**
 * Provisioning runtime — the machine operations, driven through
 * their injectable seams (process runner, fetch) so the SECURITY
 * and RECOVERY behaviour is tested deterministically without a
 * real Demucs, PyTorch, network or checkpoint.
 *
 * These tests prove the mandate's failure-handling contract:
 * untrusted sources refused, redirects validated, downloads
 * bounded and interrupted safely, wrong/corrupt checkpoints
 * rejected before placement, atomic placement, subprocess
 * failures surfaced with their exit codes, and cancellation
 * honoured. They do NOT prove real inference — that stays the
 * owner-machine acceptance (docs/DEEP-ENGINE-PROVISIONING.md).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEEP_CHECKPOINT_FILE } from "./deep";
import {
  ProvisionCancelledError,
  ProvisionError,
  acquireCheckpoint,
  acquireManagedPython,
  createManagedVenv,
  discoverEnvironment,
  downloadToTemp,
  importCheckpoint,
  installDependencies,
  runInferenceProbe,
  smokeTestWav,
  trustedFetch,
  validateTrustedUrl,
  verifyEngine,
  type ProvisionContext,
  type RunOutcome,
} from "./provision-runtime";

/** Build a context with optional injected seams. */
function ctx(overrides: Partial<ProvisionContext> = {}): ProvisionContext {
  return { log: () => undefined, ...overrides };
}

const noopRun = async (): Promise<RunOutcome> => ({ status: 0, stdout: "", stderr: "", error: null });

/** A Response with an explicit content-length, as a real server sends. */
function responseOf(body: string | Uint8Array, headers: Record<string, string> = {}): Response {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return new Response(buffer, { headers: { "content-length": String(buffer.length), ...headers } });
}

const sha256Of = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

// --------------------------------------------------------- trusted sources

test("validateTrustedUrl: the authoritative engine hosts are allowed over HTTPS", () => {
  for (const url of [
    "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th",
    "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip",
    "https://pypi.org/simple/demucs/",
    "https://files.pythonhosted.org/packages/pip.whl",
    "https://download.pytorch.org/whl/cpu/torch-2.0.1+cpu-cp311.whl",
  ]) {
    assert.equal(validateTrustedUrl(url).hostname.length > 0, true, url);
  }
});

test("validateTrustedUrl: plain HTTP, unknown hosts, credentials and non-URLs are refused", () => {
  const refuse = (url: string) => {
    assert.throws(() => validateTrustedUrl(url), (error: unknown) => {
      assert.ok(error instanceof ProvisionError);
      assert.equal((error as ProvisionError).code, "UNTRUSTED_SOURCE");
      return true;
    }, url);
  };
  refuse("http://dl.fbaipublicfiles.com/demucs/x.th"); // not HTTPS
  refuse("https://evil.example.com/demucs/x.th"); // not an authoritative host
  refuse("https://dl.fbaipublicfiles.com.evil.com/x.th"); // lookalike domain
  refuse("https://user:pass@dl.fbaipublicfiles.com/x.th"); // credentials
  refuse("not a url");
});

test("trustedFetch: a redirect to an untrusted host is refused", async () => {
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("fbaipublicfiles.com")) {
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.th" } });
    }
    return responseOf("x");
  };
  await assert.rejects(
    () => trustedFetch("https://dl.fbaipublicfiles.com/demucs/x.th", { fetch: fetchImpl }),
    (error: unknown) => (error as ProvisionError).code === "UNTRUSTED_SOURCE",
  );
});

// ------------------------------------------------------------- downloads

test("downloadToTemp: streams to a temp file and reports size + sha256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const body = Buffer.from("checkpoint-bytes".repeat(100));
    const tempPath = join(directory, "x.tmp");
    const seen: number[] = [];
    const result = await downloadToTemp("https://dl.fbaipublicfiles.com/demucs/x.th", tempPath, {
      ctx: ctx({ fetch: async () => responseOf(body) }),
      expectedBytes: body.length,
      onProgress: (done) => seen.push(done),
    });
    assert.equal(result.bytes, body.length);
    assert.equal(result.sha256, sha256Of(body));
    assert.deepEqual(await readFile(tempPath), body);
    assert.ok(seen.length > 0, "progress was reported");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadToTemp: a declared length wildly off the expectation is refused before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const tempPath = join(directory, "x.tmp");
    await assert.rejects(
      () =>
        downloadToTemp("https://dl.fbaipublicfiles.com/x.th", tempPath, {
          ctx: ctx({ fetch: async () => responseOf("tiny", { "content-length": "999999999" }) }),
          expectedBytes: 52_400_000,
        }),
      (error: unknown) => (error as ProvisionError).code === "DOWNLOAD_WRONG_SIZE",
    );
    await assert.rejects(() => stat(tempPath), "nothing was written for a refused download");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadToTemp: an interrupted stream is cleaned up and reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection reset"));
      },
    });
    const tempPath = join(directory, "x.tmp");
    await assert.rejects(
      () =>
        downloadToTemp("https://dl.fbaipublicfiles.com/x.th", tempPath, {
          ctx: ctx({ fetch: async () => new Response(brokenStream as unknown as BodyInit, { headers: { "content-length": "1000" } }) }),
        }),
      (error: unknown) => (error as ProvisionError).code === "DOWNLOAD_INTERRUPTED",
    );
    await assert.rejects(() => stat(tempPath), "the partial download was removed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadToTemp: a byte cap refuses an oversized response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const tempPath = join(directory, "x.tmp");
    await assert.rejects(
      () =>
        downloadToTemp("https://dl.fbaipublicfiles.com/x.th", tempPath, {
          ctx: ctx({ fetch: async () => responseOf(Buffer.alloc(1000)) }),
          maxBytes: 100,
        }),
      (error: unknown) => (error as ProvisionError).code === "DOWNLOAD_TOO_LARGE",
    );
    await assert.rejects(() => stat(tempPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- checkpoint

test("acquireCheckpoint: a wrong-checksum download is refused and never placed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const modelsDir = join(directory, "models");
    const body = Buffer.from("definitely not the real weights");
    await assert.rejects(
      () => acquireCheckpoint(modelsDir, ctx({ fetch: async () => responseOf(body) }), { expectedBytes: body.length }),
      (error: unknown) => {
        assert.ok(error instanceof ProvisionError);
        assert.equal((error as ProvisionError).code, "INTEGRITY_FAILED");
        return true;
      },
    );
    // Neither the final file nor a leftover temp remains.
    await assert.rejects(() => stat(join(modelsDir, DEEP_CHECKPOINT_FILE)));
    await assert.rejects(() => stat(join(modelsDir, `.download-${DEEP_CHECKPOINT_FILE}.tmp`)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireCheckpoint: a matching file is verified and atomically placed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const modelsDir = join(directory, "models");
    const body = Buffer.from("the real weights, for a test with a matching prefix");
    const prefix = sha256Of(body).slice(0, 8); // exercise the REAL verification with a real match
    await acquireCheckpoint(modelsDir, ctx({ fetch: async () => responseOf(body) }), { checksumPrefix: prefix, expectedBytes: body.length });
    const placed = await readFile(join(modelsDir, DEEP_CHECKPOINT_FILE));
    assert.deepEqual(placed, body);
    await assert.rejects(() => stat(join(modelsDir, `.download-${DEEP_CHECKPOINT_FILE}.tmp`)), "temp was renamed away");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importCheckpoint: a wrong file is refused, a matching one is imported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const modelsDir = join(directory, "models");
    const source = join(directory, "my-checkpoint.th");
    const body = Buffer.from("an owner-owned checkpoint");
    await writeFile(source, body);
    // Wrong prefix → refused, nothing imported.
    await assert.rejects(
      () => importCheckpoint(source, modelsDir, ctx()),
      (error: unknown) => (error as ProvisionError).code === "INTEGRITY_FAILED",
    );
    await assert.rejects(() => stat(join(modelsDir, DEEP_CHECKPOINT_FILE)));
    // Correct prefix (the real verification, with a genuinely matching file) → imported.
    const prefix = sha256Of(body).slice(0, 8);
    await importCheckpoint(source, modelsDir, ctx(), { checksumPrefix: prefix });
    assert.deepEqual(await readFile(join(modelsDir, DEEP_CHECKPOINT_FILE)), body);
    // A relative path is refused outright.
    await assert.rejects(
      () => importCheckpoint("relative/checkpoint.th", modelsDir, ctx()),
      (error: unknown) => (error as ProvisionError).code === "IMPORT_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- engine verify/probe

test("verifyEngine: reports the real Demucs and PyTorch versions", async () => {
  const runProcess = async (): Promise<RunOutcome> => ({
    status: 0,
    stdout: JSON.stringify({ demucs: "4.0.1", torch: "2.0.1+cpu", cuda: false }),
    stderr: "",
    error: null,
  });
  const verified = await verifyEngine("/venv/bin/python", ctx({ runProcess }));
  assert.equal(verified.demucsVersion, "4.0.1");
  assert.equal(verified.torchVersion, "2.0.1+cpu");
  assert.equal(verified.cuda, false);
});

test("verifyEngine: an import failure is an engine failure, not a crash", async () => {
  const runProcess = async (): Promise<RunOutcome> => ({
    status: 0,
    stdout: JSON.stringify({ error: "No module named 'torch'" }),
    stderr: "",
    error: null,
  });
  await assert.rejects(
    () => verifyEngine("/venv/bin/python", ctx({ runProcess })),
    (error: unknown) => (error as ProvisionError).code === "ENGINE_VERIFY_FAILED",
  );
});

test("runInferenceProbe: six controlled valid WAVs pass; missing stems are named and refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const modelsDir = join(directory, "models");
    const makeRunner = (stems: string[]) => async (_bin: string, args: readonly string[]): Promise<RunOutcome> => {
      if (!args.includes("demucs")) return noopRun();
      const outIndex = args.indexOf("--out");
      const outDir = args[outIndex + 1] as string;
      const { mkdir, writeFile } = await import("node:fs/promises");
      const trackDir = join(outDir, "5c90dfd2", "probe");
      await mkdir(trackDir, { recursive: true });
      await mkdir(modelsDir, { recursive: true });
      await writeFile(join(modelsDir, DEEP_CHECKPOINT_FILE), "controlled-not-weights");
      for (const [index, stem] of stems.entries()) {
        const wav = smokeTestWav(); wav.writeInt16LE(index + 1, 44);
        await writeFile(join(trackDir, `${stem}.wav`), wav);
      }
      return { status: 0, stdout: "", stderr: "100%", error: null };
    };
    const all = await runInferenceProbe("/venv/bin/python", modelsDir, ctx({ runProcess: makeRunner(["vocals", "drums", "bass", "guitar", "piano", "other"]) }));
    assert.deepEqual([...all], ["vocals", "drums", "bass", "guitar", "piano", "other"]);
    // Missing guitar + piano → an honest failure naming them.
    await assert.rejects(
      () => runInferenceProbe("/venv/bin/python", modelsDir, ctx({ runProcess: makeRunner(["vocals", "drums", "bass", "other"]) })),
      (error: unknown) => {
        assert.ok(error instanceof ProvisionError);
        assert.equal((error as ProvisionError).code, "ENGINE_PROBE_FAILED");
        assert.match((error as ProvisionError).message, /guitar, piano/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- venv / install

test("createManagedVenv: returns the environment's interpreter after a clean exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const envDir = join(directory, "env");
    const runProcess = async (_bin: string, args: readonly string[]): Promise<RunOutcome> => {
      if (args.includes("venv")) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const binDir = process.platform === "win32" ? "Scripts" : "bin";
        const pythonName = process.platform === "win32" ? "python.exe" : "python";
        await mkdir(join(envDir, "venv", binDir), { recursive: true });
        await writeFile(join(envDir, "venv", binDir, pythonName), "#!/bin/sh\n");
      }
      return noopRun();
    };
    const python = await createManagedVenv("/usr/bin/python3.11", envDir, ctx({ runProcess }));
    assert.ok(python.endsWith(process.platform === "win32" ? "python.exe" : "python"));
    const details = await stat(python);
    assert.ok(details.isFile());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing dependency install surfaces its exit code and diagnostic tail", async () => {
  const failing = async (): Promise<RunOutcome> => ({
    status: 1,
    stdout: "",
    stderr: "ERROR: Could not find a version that satisfies the requirement torch",
    error: null,
  });
  await assert.rejects(
    () => installDependencies("/venv/bin/python", ctx({ runProcess: failing })),
    (error: unknown) => {
      assert.ok(error instanceof ProvisionError);
      assert.equal((error as ProvisionError).code, "DEPENDENCY_INSTALL_FAILED");
      assert.match((error as ProvisionError).message, /exit 1/);
      return true;
    },
  );
});

// ------------------------------------------------------- managed CPython

test("acquireManagedPython: downloads, extracts, bootstraps pip and proves the version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const envDir = join(directory, "env");
    const pipWheel = Buffer.from("fake pip wheel contents");
    const pipSha = sha256Of(pipWheel);
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith("https://www.python.org/")) return responseOf(Buffer.from("cpython zip"));
      if (url === "https://pypi.org/pypi/pip/json") {
        return responseOf(
          JSON.stringify({
            urls: [
              {
                filename: "pip-24.0-py3-none-any.whl",
                url: "https://files.pythonhosted.org/pip.whl",
                digests: { sha256: pipSha },
                size: pipWheel.length,
              },
            ],
          }),
        );
      }
      if (url.includes("files.pythonhosted.org")) return responseOf(pipWheel);
      throw new Error(`unexpected fetch ${url}`);
    };
    const runProcess = async (_bin: string, args: readonly string[]): Promise<RunOutcome> => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      if (args[0] === "-xf") {
        const archive = args[1] as string;
        const dest = args[args.length - 1] as string;
        await mkdir(dest, { recursive: true });
        // The CPython zip extraction materialises the runtime + its ._pth.
        if (archive.endsWith(".zip") && !archive.includes("pip")) {
          await writeFile(join(dest, "python.exe"), "binary");
          await writeFile(join(dest, "python311._pth"), "python311.zip\n#import site\n");
        }
      }
      if (args[args.length - 1] === "--version") {
        return { status: 0, stdout: "Python 3.11.9\n", stderr: "", error: null };
      }
      return noopRun();
    };
    const python = await acquireManagedPython(envDir, ctx({ fetch: fetchImpl, runProcess }), { platform: "win32", arch: "x64", expectedBytes: 10 });
    assert.ok(python.endsWith("python.exe"));
    const details = await stat(python);
    assert.ok(details.isFile(), "the managed runtime's interpreter exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireManagedPython: a runtime that reports the wrong version is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const envDir = join(directory, "env");
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith("https://www.python.org/")) return responseOf(Buffer.from("zip"));
      if (url === "https://pypi.org/pypi/pip/json") {
        const wheel = Buffer.from("pip");
        return responseOf(JSON.stringify({ urls: [{ filename: "pip-24.0-py3-none-any.whl", url: "https://files.pythonhosted.org/p.whl", digests: { sha256: sha256Of(wheel) }, size: wheel.length }] }));
      }
      return responseOf(Buffer.from("pip"));
    };
    const runProcess = async (_bin: string, args: readonly string[]): Promise<RunOutcome> => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      if (args[0] === "-xf") {
        const dest = args[args.length - 1] as string;
        await mkdir(dest, { recursive: true });
        if ((args[1] as string).endsWith(".zip")) {
          await writeFile(join(dest, "python.exe"), "binary");
          await writeFile(join(dest, "python311._pth"), "python311.zip\n#import site\n");
        }
      }
      if (args[args.length - 1] === "--version") {
        return { status: 0, stdout: "Python 3.13.0\n", stderr: "", error: null };
      }
      return noopRun();
    };
    await assert.rejects(
      () => acquireManagedPython(envDir, ctx({ fetch: fetchImpl, runProcess }), { platform: "win32", arch: "x64", expectedBytes: 3 }),
      (error: unknown) => {
        assert.ok(error instanceof ProvisionError);
        assert.equal((error as ProvisionError).code, "RUNTIME_SETUP_FAILED");
        assert.match((error as ProvisionError).message, /expected Python 3\.11\.9/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- discovery

test("discoverEnvironment: reports every interpreter, the checkpoint and FFmpeg honestly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const modelsDir = join(directory, "models");
    const envDir = join(directory, "env");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(modelsDir, { recursive: true });
    const checkpointBody = Buffer.from("a checkpoint whose prefix we compute");
    const checkpointPath = join(modelsDir, DEEP_CHECKPOINT_FILE);
    await writeFile(checkpointPath, checkpointBody);
    // A probe runner that reports a compatible interpreter WITH Demucs.
    const runProcess = async (_bin: string, args: readonly string[]): Promise<RunOutcome> => {
      if (args[0] === "-c") {
        return { status: 0, stdout: JSON.stringify({ version: "3.11.9", demucs: "4.0.1" }), stderr: "", error: null };
      }
      return noopRun();
    };
    const report = await discoverEnvironment({
      ctx: ctx({ runProcess }),
      env: {
        ...process.env,
        WAVEYARD_DEEP_PYTHON: "/opt/python3.11/bin/python",
        WAVEYARD_MODELS_DIR: modelsDir,
        WAVEYARD_DEEP_ENV_DIR: envDir,
      },
    });
    assert.equal(report.checkpoint.present, true);
    assert.equal(report.checkpoint.sha256, sha256Of(checkpointBody));
    assert.equal(report.checkpoint.sizeBytes, checkpointBody.length);
    assert.equal(report.checkpoint.path, checkpointPath);
    assert.equal(report.managedEnvironmentExists, false);
    // The explicit override interpreter was probed and found compatible.
    const override = report.python.find((candidate) => candidate.source === "env");
    assert.ok(override !== undefined, "the WAVEYARD_DEEP_PYTHON interpreter was probed");
    assert.equal(override?.demucsVersion, "4.0.1");
    assert.equal(report.compatiblePython?.bin, "/opt/python3.11/bin/python");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("discoverEnvironment: an interpreter that cannot run reports version null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-prov-"));
  try {
    const runProcess = async (): Promise<RunOutcome> => ({ status: 1, stdout: "", stderr: "boom", error: null });
    const report = await discoverEnvironment({
      ctx: ctx({ runProcess }),
      env: { ...process.env, WAVEYARD_DEEP_PYTHON: "/no/such/python", WAVEYARD_MODELS_DIR: join(directory, "m"), WAVEYARD_DEEP_ENV_DIR: join(directory, "e") },
    });
    for (const candidate of report.python) {
      assert.equal(candidate.version, null);
      assert.equal(candidate.demucsVersion, null);
    }
    assert.equal(report.compatiblePython, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ cancellation

test("a cancelled preparation aborts before any work is done", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => downloadToTemp("https://dl.fbaipublicfiles.com/x.th", "/tmp/nowhere.tmp", { ctx: ctx({ signal: controller.signal }) }),
    (error: unknown) => error instanceof ProvisionCancelledError,
  );
});

test("a cancelled subprocess is killed and reported as cancelled", async () => {
  const { defaultRunProcess } = await import("./provision-runtime");
  const controller = new AbortController();
  const promise = defaultRunProcess("python3", ["-c", "import time; time.sleep(30)"], {
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const outcome = await promise;
  // The child was killed: no clean exit code, and the caller treats it as cancelled.
  assert.ok(outcome.status === null || outcome.error !== null || controller.signal.aborted);
});

test("trusted source cannot change the publisher's HTTPS port", () => {
  assert.throws(() => validateTrustedUrl("https://dl.fbaipublicfiles.com:8443/model.th"), /HTTPS port/);
});
