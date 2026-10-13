/**
 * Stub "python" drivers for the deep-bridge tests.
 *
 * The bridge's real spawn path is what is under test, so the stub is a real
 * executable that speaks the same two interfaces the bridge uses: `-c`
 * probes (Demucs package metadata, torch device availability) and the
 * Demucs CLI invocation (`-m demucs --name … --device … --out … input`).
 * It records its own argv so tests can assert the exact contract the bridge
 * asked for, and can be told to fail in each honest way the bridge must
 * classify (no Demucs, missing output, non-zero exit, no CUDA).
 *
 * Test-only module (same pattern as worker-local/separation-fixtures.ts):
 * production code never imports it.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEEP_STEM_TYPES } from "./modes";

export type StubDeepOptions = {
  /** Demucs version the interpreter reports; null = not installed. */
  demucsVersion?: string | null;
  /** What torch.cuda.is_available() reports. */
  cuda?: boolean;
  /** Which stems the stub writes (default: all six). */
  stems?: readonly string[];
  /** Stems written as zero-byte files (the bridge must refuse them). */
  emptyStems?: readonly string[];
  /** Non-zero exit with this stderr instead of writing stems. */
  runStderr?: string;
  runExitCode?: number;
};

/** Write the stub driver; returns its absolute path (executable). */
export async function writeStubDeepPython(
  directory: string,
  fixtureWavPath: string,
  options: StubDeepOptions = {},
): Promise<string> {
  const stems = options.stems ?? DEEP_STEM_TYPES;
  const emptyStems = options.emptyStems ?? [];
  const demucsJson = options.demucsVersion === null || options.demucsVersion === undefined
    ? "null"
    : `"${options.demucsVersion}"`;
  const runFailure = options.runStderr
    ? `echo ${shellQuote(options.runStderr)} >&2\nexit ${options.runExitCode ?? 1}`
    : "";
  const script = `#!/usr/bin/env bash
# Stub python driver for the deep-bridge tests (see deep-fixtures.ts).
if [ -n "$STUB_CALL_LOG" ]; then printf '%s\\n' "$(echo "$*" | tr '\\n' ' ')" >> "$STUB_CALL_LOG"; fi
if [ "$1" = "-c" ]; then
  case "$2" in
    *demucs_version*) echo '{"demucs": ${demucsJson}}' ;;
    *torch*) echo '{"cuda": ${options.cuda === true ? "true" : "false"}}' ;;
    *) echo '{}' ;;
  esac
  exit 0
fi
out=""; name=""; device=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --device) device="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    -*) shift ;;
    *) input="$1"; shift ;;
  esac
done
${runFailure}
mkdir -p "$out/$name/track"
for stem in ${stems.join(" ")}; do cp ${shellQuote(fixtureWavPath)} "$out/$name/track/$stem.wav"; done
for stem in ${emptyStems.join(" ")}; do : > "$out/$name/track/$stem.wav"; done
echo " 50%" >&2
echo "100%" >&2
exit 0
`;
  const path = join(directory, "python-stub");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
