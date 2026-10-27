import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCapabilityReport, REQUIRED, type CapabilityId, type CapabilityProbes } from "./report";
import { findOnPath, resolveExecutable } from "./resolver";

const win = "win32" as const;
const present = (...files: string[]) => (p: string) => files.includes(p);

test("resolver: env override beats bundled beats system, all absolute", () => {
  const env = { ARENA_APP_BIN_DIR: "C:\\app\\bin", PATH: "C:\\sys", ARENA_FFMPEG_PATH: "C:\\own\\ffmpeg.exe" };
  const all = present("C:\\own\\ffmpeg.exe", "C:\\app\\bin\\ffmpeg.exe", "C:\\sys\\ffmpeg.exe");
  const sep = (p: string) => p; // join() on this host may use /; normalise in assertions
  const a = resolveExecutable("ffmpeg", { env, platform: win, envVar: "ARENA_FFMPEG_PATH", isFile: (p) => all(p.replace(/\//g, "\\")) });
  assert.equal(a?.source, "env");
  const b = resolveExecutable("ffmpeg", { env: { ...env, ARENA_FFMPEG_PATH: undefined }, platform: win, envVar: "ARENA_FFMPEG_PATH", isFile: (p) => all(sep(p).replace(/\//g, "\\")) });
  assert.equal(b?.source, "bundled");
  const c = resolveExecutable("ffmpeg", { env: { PATH: "C:\\sys" }, platform: win, isFile: (p) => all(p.replace(/\//g, "\\")) });
  assert.equal(c?.source, "system");
  assert.match(c!.label, /not bundled/);
});

test("resolver: never returns a bare name; missing tool is null", () => {
  assert.equal(resolveExecutable("yt-dlp", { env: { PATH: "C:\\sys" }, platform: win, isFile: () => false }), null);
  const hit = resolveExecutable("python3", { env: { PATH: "/usr/bin" }, platform: "linux", isFile: (p) => p.replace(/\\/g, "/") === "/usr/bin/python3" });
  assert.equal(hit?.path.replace(/\\/g, "/"), "/usr/bin/python3");
});

test("resolver: relative PATH entries and relative overrides are ignored", () => {
  assert.equal(findOnPath("tool", { env: { PATH: ".;;bin" }, platform: win, isFile: () => true }), null);
  const r = resolveExecutable("tool", { env: { MYTOOL: "tool.exe" }, envVar: "MYTOOL", platform: win, isFile: () => true, allowSystem: false });
  assert.equal(r, null);
});

test("resolver: allowSystem=false keeps bundled-only tools off PATH", () => {
  const r = resolveExecutable("python", { env: { PATH: "C:\\sys" }, platform: win, isFile: () => true, allowSystem: false });
  assert.equal(r, null);
});

test("resolver finds a real bundled file on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-cap-"));
  try {
    mkdirSync(join(dir, "bin"));
    const name = process.platform === "win32" ? "faketool.exe" : "faketool";
    writeFileSync(join(dir, "bin", name), "x");
    const r = resolveExecutable("faketool", { env: { ARENA_APP_BIN_DIR: join(dir, "bin"), PATH: "" } });
    assert.equal(r?.source, "bundled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const allOk = (): CapabilityProbes =>
  Object.fromEntries((Object.keys(REQUIRED) as CapabilityId[]).map((id) => [id, async () => ({ ok: true, reason: "fine" })])) as CapabilityProbes;

test("report: all ready", async () => {
  const report = await buildCapabilityReport(allOk(), () => new Date("2026-01-01T00:00:00Z"));
  assert.equal(report.overall, "READY");
  assert.equal(report.capabilities.length, 10);
  assert.equal(report.checkedAt, "2026-01-01T00:00:00.000Z");
});

test("report: optional tools missing do not break overall; required missing does", async () => {
  const probes = allOk();
  probes["yt-dlp"] = async () => ({ ok: false, reason: "missing", remediation: "install" });
  probes.demucs = async () => ({ ok: false, reason: "no demucs" });
  let report = await buildCapabilityReport(probes);
  assert.equal(report.overall, "READY");
  const yt = report.capabilities.find((c) => c.id === "yt-dlp")!;
  assert.equal(yt.status, "UNAVAILABLE");
  assert.equal(yt.remediation, "install");

  probes.ffmpeg = async () => ({ ok: false, reason: "no ffmpeg", remediation: "reinstall" });
  report = await buildCapabilityReport(probes);
  assert.equal(report.overall, "UNAVAILABLE");
});

test("report: degraded and throwing probes are honest", async () => {
  const probes = allOk();
  probes.python = async () => ({ ok: true, degraded: true, reason: "system python", path: "C:\\py\\python.exe", version: "3.12" });
  probes.database = async () => {
    throw new Error("boom");
  };
  const report = await buildCapabilityReport(probes);
  assert.equal(report.capabilities.find((c) => c.id === "python")!.status, "DEGRADED");
  const db = report.capabilities.find((c) => c.id === "database")!;
  assert.equal(db.status, "UNAVAILABLE");
  assert.match(db.reason, /boom/);
  assert.equal(report.overall, "UNAVAILABLE");
});
