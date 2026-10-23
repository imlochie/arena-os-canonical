/**
 * Stand-in deep engine for the bridge tests — a REAL Python interpreter
 * driving a FAKE Demucs, on every platform.
 *
 * The bridge's real spawn path is what is under test, so the stand-in must
 * be something the bridge can execute exactly as it executes the owner's
 * engine: `python -c <probe>` and `python -m demucs --name … --repo …
 * --device … --out … input`. A shell-script "python" cannot do that on
 * Windows (and would test a shell, not an interpreter), so the fixture uses
 * the machine's own Python 3 and puts a fake `demucs` package, a fake
 * `torch`, and the package metadata the probe reads (`demucs-<v>.dist-info`)
 * on an isolated PYTHONPATH. A `sitecustomize.py` on that path records every
 * interpreter invocation (probes included) to STUB_CALL_LOG and drops the
 * machine's site-packages from sys.path, so a REAL Demucs install on the
 * host can never leak into the "not installed" scenarios.
 *
 * The fake Demucs behaves like the real CLI where the bridge can tell:
 * it writes `<out>/<name>/<track>/<stem>.wav`, reports percent on stderr,
 * and — like `demucs.repo.LocalRepo` — refuses a `--repo` that does not
 * contain a checkpoint for the requested signature. The checkpoint the
 * fixture writes is a DUMMY file: these tests prove the readiness gate and
 * the invocation contract, never real inference (that remains an
 * owner-machine acceptance item, see ADR-007).
 *
 * Test-only module (same pattern as worker-local/separation-fixtures.ts):
 * production code never imports it.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEEP_CHECKPOINT_FILE, DEEP_MODEL_SIGNATURE } from "./deep";
import { DEEP_STEM_TYPES } from "./modes";

export type StubDeepOptions = {
  /** Process-lifecycle fixture only; never learned inference. */
  hangIgnoringTermination?: boolean;
  /** Demucs version the interpreter reports; null = not installed (no
   *  package metadata AND no `demucs` module — `-m demucs` fails too). */
  demucsVersion?: string | null;
  /** What torch.cuda.is_available() reports. */
  cuda?: boolean;
  /** Which stems the fake writes (default: all six). */
  stems?: readonly string[];
  /** Stems written as zero-byte files (the bridge must refuse them). */
  emptyStems?: readonly string[];
  /** Non-zero exit with this stderr instead of writing stems. */
  runStderr?: string;
  runExitCode?: number;
  /** Where the dummy checkpoint goes (default `<directory>/models`). */
  modelsDir?: string;
  /** Write the dummy checkpoint (default true; false = "not prepared"). */
  checkpoint?: boolean;
};

export type StubDeepEngine = {
  /** Absolute path of the real interpreter (what WAVEYARD_DEEP_PYTHON gets). */
  python: string;
  /** The isolated PYTHONPATH entry holding the fakes. */
  sitePath: string;
  /** WAVEYARD_MODELS_DIR for the bridge — holds the dummy checkpoint. */
  modelsDir: string;
  checkpointPath: string;
  callLog: string;
  /** Everything the bridge needs, over the current process env. */
  env: NodeJS.ProcessEnv;
  /** One line per interpreter invocation: the argv after the executable. */
  calls(): Promise<string[]>;
};

/** Env keys the fixture sets — tests that drive the handler (which reads
 *  process.env) save and restore exactly these. */
export const STUB_DEEP_ENV_KEYS = [
  "WAVEYARD_DEEP_PYTHON",
  "PYTHONPATH",
  "PYTHONNOUSERSITE",
  "STUB_CALL_LOG",
] as const;

let cachedPython: string | null | undefined;

/** The machine's Python 3 (≥ 3.8 — importlib.metadata), resolved to the
 *  interpreter's own absolute path; null when there is none. Cached. */
export function findTestPython(env: NodeJS.ProcessEnv = process.env): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates: Array<{ bin: string; prefixArgs: string[] }> = [];
  for (const explicit of [env.WAVEYARD_DEEP_PYTHON, env.PYTHON_BIN]) {
    if (explicit && explicit.trim() !== "") candidates.push({ bin: explicit.trim(), prefixArgs: [] });
  }
  if (process.platform === "win32") candidates.push({ bin: "py", prefixArgs: ["-3"] }, { bin: "python", prefixArgs: [] });
  else candidates.push({ bin: "python3", prefixArgs: [] }, { bin: "python", prefixArgs: [] });
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate.bin,
      [...candidate.prefixArgs, "-c", "import sys; print(sys.executable); print(sys.version_info[0], sys.version_info[1])"],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (result.error || result.status !== 0) continue;
    const [executable, version] = (result.stdout ?? "").trim().split(/\r?\n/);
    const [major, minor] = (version ?? "").split(" ").map(Number);
    if (!executable || major !== 3 || !(minor >= 8)) continue;
    cachedPython = executable;
    return executable;
  }
  cachedPython = null;
  return null;
}

/** The skip message for machines without an interpreter — honest "NOT
 *  VERIFIED here", never a silent pass. */
export const NO_TEST_PYTHON = "no Python 3 interpreter on this machine — the deep bridge tests drive a real interpreter";

function pythonString(value: string): string {
  return JSON.stringify(value);
}

const SITECUSTOMIZE = `# Stand-in deep engine (deep-fixtures.ts): record every interpreter start,
# then isolate this interpreter from the machine's installed packages.
import os
import sys
_log = os.environ.get("STUB_CALL_LOG")
if _log:
    _argv = list(getattr(sys, "orig_argv", None) or sys.argv)
    with open(_log, "a", encoding="utf-8") as _handle:
        _handle.write(" ".join(_argv[1:]).replace("\\r", " ").replace("\\n", " ") + "\\n")
_cwd = os.getcwd()
sys.path[:] = [
    _entry for _entry in sys.path
    if _entry not in ("", _cwd) and "site-packages" not in _entry and "dist-packages" not in _entry
]
`;

function fakeDemucsMain(options: Required<Pick<StubDeepOptions, "stems" | "emptyStems">> & StubDeepOptions, fixtureWavPath: string): string {
  const failure = options.runStderr !== undefined
    ? `    sys.stderr.write(${pythonString(options.runStderr)} + "\\n")\n    sys.stderr.flush()\n    sys.exit(${options.runExitCode ?? 1})\n`
    : "    pass\n";
  return `# Fake Demucs CLI (deep-fixtures.ts) — the same argv contract as \`python -m demucs\`.
import os
import shutil
import sys

STEMS = ${JSON.stringify([...options.stems])}
EMPTY_STEMS = ${JSON.stringify([...options.emptyStems])}
FIXTURE = ${pythonString(fixtureWavPath)}


def main(argv):
    name = "htdemucs"
    repo = None
    device = "cpu"
    out = "separated"
    tracks = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in ("--name", "-n"):
            name = argv[index + 1]
            index += 2
        elif token == "--repo":
            repo = argv[index + 1]
            index += 2
        elif token in ("--device", "-d"):
            device = argv[index + 1]
            index += 2
        elif token in ("--out", "-o"):
            out = argv[index + 1]
            index += 2
        elif token.startswith("-"):
            index += 1
        else:
            tracks.append(token)
            index += 1
    if device not in ("cpu", "cuda"):
        sys.stderr.write("fake demucs: unsupported device %s\\n" % device)
        return 2
    # demucs.repo.LocalRepo: a --repo is scanned for <signature>[-<checksum>].th;
    # an unknown signature is a ModelLoadingError before any audio is read.
    if repo is not None:
        if not os.path.isdir(repo):
            sys.stderr.write("%s must exist and be a directory.\\n" % repo)
            return 1
        found = [
            entry for entry in os.listdir(repo)
            if entry.endswith(".th") and (entry[:-3] == name or entry[:-3].split("-")[0] == name)
        ]
        if not found:
            sys.stderr.write("demucs.repo.ModelLoadingError: Could not find pre-trained model with signature %s.\\n" % name)
            return 1
    if not tracks:
        sys.stderr.write("fake demucs: no input track\\n")
        return 2
    for track in tracks:
        if not os.path.isfile(track):
            sys.stderr.write("fake demucs: no such file %s\\n" % track)
            return 2
${options.hangIgnoringTermination ? `    import signal, time
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    sys.stderr.write("1%\\n")
    sys.stderr.flush()
    time.sleep(60)
` : ""}${failure}
    track_dir = os.path.join(out, name, "track")
    os.makedirs(track_dir, exist_ok=True)
    for stem in STEMS:
        shutil.copyfile(FIXTURE, os.path.join(track_dir, stem + ".wav"))
    for stem in EMPTY_STEMS:
        open(os.path.join(track_dir, stem + ".wav"), "wb").close()
    sys.stderr.write(" 50%\\n")
    sys.stderr.flush()
    sys.stderr.write("100%\\n")
    sys.stderr.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;
}

/**
 * Lay down the stand-in: the fake packages on an isolated site path, the
 * dummy checkpoint in a models dir, and the env the bridge needs. Returns
 * null when the machine has no Python 3 (callers skip, visibly).
 */
export async function writeStubDeepEngine(
  directory: string,
  fixtureWavPath: string,
  options: StubDeepOptions = {},
): Promise<StubDeepEngine | null> {
  const python = findTestPython();
  if (python === null) return null;

  const stems = options.stems ?? DEEP_STEM_TYPES;
  const emptyStems = options.emptyStems ?? [];
  const sitePath = join(directory, "site");
  const modelsDir = options.modelsDir ?? join(directory, "models");
  const callLog = join(directory, "calls.log");
  await mkdir(sitePath, { recursive: true });
  await mkdir(modelsDir, { recursive: true });

  await writeFile(join(sitePath, "sitecustomize.py"), SITECUSTOMIZE);
  await mkdir(join(sitePath, "torch"), { recursive: true });
  await writeFile(
    join(sitePath, "torch", "__init__.py"),
    `# Fake torch (deep-fixtures.ts): only what the bridge's device probe touches.\nclass cuda:\n    @staticmethod\n    def is_available():\n        return ${options.cuda === true ? "True" : "False"}\n`,
  );
  const demucsVersion = options.demucsVersion === undefined ? null : options.demucsVersion;
  if (demucsVersion !== null) {
    await mkdir(join(sitePath, "demucs"), { recursive: true });
    await writeFile(join(sitePath, "demucs", "__init__.py"), `__version__ = ${pythonString(demucsVersion)}\n`);
    await writeFile(join(sitePath, "demucs", "__main__.py"), fakeDemucsMain({ ...options, stems, emptyStems }, fixtureWavPath));
    const distInfo = join(sitePath, `demucs-${demucsVersion}.dist-info`);
    await mkdir(distInfo, { recursive: true });
    await writeFile(join(distInfo, "METADATA"), `Metadata-Version: 2.1\nName: demucs\nVersion: ${demucsVersion}\n`);
  }

  const checkpointPath = join(modelsDir, DEEP_CHECKPOINT_FILE);
  if (options.checkpoint !== false) {
    await writeFile(
      checkpointPath,
      `dummy ${DEEP_MODEL_SIGNATURE} checkpoint written by deep-fixtures.ts — presence only, not weights\n`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WAVEYARD_DEEP_PYTHON: python,
    PYTHONPATH: sitePath,
    PYTHONNOUSERSITE: "1",
    STUB_CALL_LOG: callLog,
    WAVEYARD_MODELS_DIR: modelsDir,
  };
  return {
    python,
    sitePath,
    modelsDir,
    checkpointPath,
    callLog,
    env,
    async calls() {
      const raw = await readFile(callLog, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean);
    },
  };
}
