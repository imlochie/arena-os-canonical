import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tracks = (process.env.WAVEYARD_ACCEPTANCE_TRACKS ?? "")
  .split(delimiter)
  .map((path) => path.trim())
  .filter(Boolean)
  .map((path) => resolve(workspaceRoot, path));
const expectedChecksums = new Set([
  "6c034800da6b34c44f6d85ba627048e20c0fa61f3e3abab79c121891d12f6be1",
  "30e1774d7e3ed1579eaae0e70e18bbd526ea3a9e7868514bc63db9e5c629ac2c",
  "1464946afc0aff4c4b106b10a6d0cb999f019b1efa0ece80d8d6980e2add3b90",
  "a1bf58f20b60a0dc903bf7029ef196c144e66b72ffc7a0707130dfb9aee85387",
  "b59ec128e86cddb06cf813356bc5f28b40d0fbef50ad00d2c921646d7b512e10",
  "a0545c5d56a0815faca1275b841289b20dc58f25cd5e049f47469e45285946e5",
]);
const skipReason = tracks.length === 6
  ? false
  : "Set WAVEYARD_ACCEPTANCE_TRACKS to six full-length audio paths; the test deliberately does not substitute generated tones.";

test("six full-track audio files produce persisted-feature comparisons without false compatibility claims", { skip: skipReason }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "waveyard-cross-track-"));
  const reportPath = join(outputDir, "report.json");
  try {
    const checksums = await Promise.all(tracks.map(async (path) =>
      createHash("sha256").update(await readFile(path)).digest("hex"),
    ));
    assert.deepEqual(new Set(checksums), expectedChecksums, "the acceptance test must use the exact six owner-provided audio inputs");
    const analysisScript = join(workspaceRoot, "scripts/waveyard-mashup-analysis.ts");
    const command = spawnSync("pnpm", [
      "--filter", "@workspace/scripts", "exec", "tsx",
      analysisScript, "--", reportPath, "0", "full", ...tracks,
    ], { cwd: workspaceRoot, encoding: "utf8", timeout: 300_000 });
    assert.equal(command.status, 0, `${command.stdout}\n${command.stderr}`);

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.tracks.length, 6);
    for (const track of report.tracks) {
      assert.ok(track.analyzedDurationSeconds >= 180, `${track.filename} was not analyzed as a full track`);
      assert.ok(track.sections.length > 0, `${track.filename} produced no sections`);
      assert.ok(track.sections.every((section) => section.passageFingerprint), `${track.filename} has a section without a passage fingerprint`);
    }
    assert.ok(report.crossSourceCompatibility.evaluatedPassagePairs > 0);
    assert.equal(report.crossSourceCompatibility.coreEligibleMatches, 0,
      "the current six-track acceptance set has no pair that meets every independent compatibility gate");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
