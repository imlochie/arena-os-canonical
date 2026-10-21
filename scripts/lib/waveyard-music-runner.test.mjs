import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// CLI/negative-path tests ONLY. Not model execution or music acceptance.
test("real-music runner refuses invalid checkpoint before contacting or changing Arena", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-music-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "invalid-input.wav"), checkpoint = path.join(root, "invalid-checkpoint.th"), out = path.join(root, "evidence");
  writeFileSync(input, "invalid input"); writeFileSync(checkpoint, "not model weights");
  const run = spawnSync(process.execPath, ["scripts/waveyard-real-music.mjs", "--url", "http://127.0.0.1:1", "--input", input, "--checkpoint", checkpoint, "--out", out, "--real-music"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "music.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.match(report.error, /checkpoint matches production/);
  assert.equal(report.steps.length, 1);
  assert.equal(report.projectId, undefined);
  assert.ok(report.checkpoint.sha256);
  assert.ok(report.source.sourceDigest);
});

test("real-music runner refuses remote targets and never overwrites an evidence directory", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-music-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = ["scripts/waveyard-real-music.mjs", "--input", "missing.wav", "--checkpoint", "missing.th", "--out", root, "--real-music"];
  const remote = spawnSync(process.execPath, [...args, "--url", "https://example.invalid"], { encoding: "utf8" });
  assert.equal(remote.status, 1); assert.match(remote.stderr, /local Arena HTTP origin/);
  const existing = spawnSync(process.execPath, [...args, "--url", "http://localhost:1"], { encoding: "utf8" });
  assert.equal(existing.status, 1); assert.match(existing.stderr, /already exists/);
  assert.equal(existsSync(path.join(root, "music.json")), false);
});
