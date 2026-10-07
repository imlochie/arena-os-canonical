/**
 * Headless desktop-mode E2E — drives the REAL runtime supervisor against the
 * REAL staged package tree (desktop-package/, exactly what the installer
 * ships) on a fresh app-data directory. No Electron required: the supervisor
 * module is Electron-free by design, so this is the same lifecycle the
 * Electron main process runs.
 *
 * Verifies (spec §10/§18/§19 adapted to a headless Linux host):
 *   1. first run: embedded Postgres initdb + migrations + standalone server + health
 *   2. real upload → honest separation failure (no local Python executor)
 *   3. real waveform (FFmpeg peaks)
 *   4. real analysis (arena-js-dsp BPM/key/grid) + real sections (bar-aligned)
 *   5. passthrough stem (existing product surface) → remix → version → export
 *   6. real FFmpeg render: download the WAV and verify content with ffprobe
 *   7. diagnostics endpoint reports honestly per subsystem
 *   8. ordered shutdown; restart on the same data dir → everything persists,
 *      migrations skip, second first-run flag false
 *
 * Usage: node scripts/desktop-e2e.mjs [report.json]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const reportPath = process.argv[2] ?? path.join(root, "desktop-e2e-report.json");
const steps = [];
let failed = false;

function step(name, ok, detail = {}) {
  steps.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${typeof detail.info === "string" ? ` — ${detail.info}` : ""}`);
  if (!ok) failed = true;
}

async function main() {
  const { resolveRuntimeConfig, ArenaRuntimeSupervisor } = await import("../desktop/runtime/index.ts");
  const { resolveArenaDataDirs } = await import("../desktop/paths.ts");

  const dataRoot = mkdtempSync(path.join(tmpdir(), "arena-desktop-e2e-"));
  const dirs = resolveArenaDataDirs({
    platform: process.platform,
    env: { ...process.env, ARENA_DATA_DIR: dataRoot },
    homeDir: tmpdir(),
    fileExists: existsSync,
  });
  const appRoot = path.join(root, "desktop-package"); // the staged installer tree
  const logs = [];
  const logger = {
    info: (scope, message, detail) => logs.push(`${new Date().toISOString()} INFO ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
    warn: (scope, message, detail) => logs.push(`${new Date().toISOString()} WARN ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
    error: (scope, message, detail) => logs.push(`${new Date().toISOString()} ERROR ${scope} ${message} ${detail ? JSON.stringify(detail) : ""}`),
  };

  const config = await resolveRuntimeConfig({
    dirs,
    appRoot,
    nodeBinary: process.execPath,
    serverMode: "packaged",
  });
  step("config resolves the staged package tree", existsSync(config.server.kind === "packaged" ? config.server.serverScript : ""), {
    info: `db port ${config.database.port}, server port ${config.port}`,
  });
  step("packaged ffmpeg resolved", config.ffmpegPath !== null && config.ffmpegPath.startsWith(appRoot), { info: config.ffmpegPath });
  step("packaged ffprobe resolved", config.ffprobePath !== null && config.ffprobePath.startsWith(appRoot), { info: config.ffprobePath });
  step("packaged embedded postgres resolved", config.postgres.postgres.startsWith(appRoot), { info: config.postgres.postgres });

  let supervisor = new ArenaRuntimeSupervisor(config, { logger });
  let url;
  try {
    url = await supervisor.start();
    const status = supervisor.status;
    step("first run: supervisor reaches ready", status.phase === "ready", {
      info: `phases: ${status.stages.map((stage) => stage.phase).join(" → ")}`,
    });
    step("first run initialised the database cluster", status.postgres?.firstRun === true);
  } catch (error) {
    step("first run: supervisor reaches ready", false, { info: String(error) });
    throw error;
  }

  const api = async (pathname, init) => {
    const response = await fetch(`${url}${pathname}`, init);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };

  // --- health + project ------------------------------------------------------
  const health = await api("/api/health");
  step("GET /api/health ok", health.status === 200 && health.body.ok === true);

  const project = await api("/api/waveyard/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Desktop E2E" }),
  });
  step("create project", project.status === 201 && project.body.project?.id, { info: project.body.project?.id });
  const projectId = project.body.project.id;

  // --- real audio: 12 s two-tone signal (bundled-ffmpeg-compatible mix) ------
  const tempDir = mkdtempSync(path.join(tmpdir(), "arena-e2e-audio-"));
  const wavPath = path.join(tempDir, "track.wav");
  execFileSync(path.join(appRoot, "bin", "ffmpeg"), [
    "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=1320:duration=12",
    "-filter_complex", "[0:a][1:a]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3,volume=0.5[a]",
    "-map", "[a]", "-ar", "44100", "-y", wavPath,
  ], { stdio: "pipe" });
  const uploadBody = new FormData();
  uploadBody.set("projectId", projectId);
  uploadBody.set("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "desktop-e2e.wav");
  const upload = await api("/api/uploads", { method: "POST", body: uploadBody });
  // Desktop: separation cannot queue (no Python executor) → honest 503, but
  // the source + waveform job rows persist and the waveform DOES run.
  const uploadOk = upload.body.source?.id !== undefined && (upload.status === 201 || upload.status === 503);
  step("upload audio (source persisted)", uploadOk, { info: `status ${upload.status}${upload.status === 503 ? " (separation honestly unqueueable on desktop)" : ""}` });
  const sourceAssetId = upload.body.source?.id;

  // --- poll pipeline to terminal states --------------------------------------
  const pollUntil = async (name, fn, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const detail = await api(`/api/waveyard/projects/${projectId}`);
      last = fn(detail.body);
      if (last.done) return last;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    step(name, false, { info: `timeout; last: ${JSON.stringify(last?.value)?.slice(0, 400)}` });
    return last;
  };

  const separation = await pollUntil("separation reaches terminal state", (body) => {
    const job = body.jobs?.find((job) => job.type === "separation");
    return job && ["complete", "failed"].includes(job.status)
      ? { done: true, job }
      : { done: false, job };
  });
  step("separation fails HONESTLY on desktop (no Python executor)", separation.job?.status === "failed" && /no local executor/i.test(String(separation.job?.errorMessage ?? "")), {
    info: String(separation.job?.errorMessage ?? "").slice(0, 160),
  });

  const waveform = await pollUntil("source waveform completes", (body) => {
    const job = body.waveformJobs?.find((job) => job.sourceAssetId === sourceAssetId) ?? body.waveformJobs?.[0];
    return job && job.status === "complete" ? { done: true, job } : { done: false, job };
  });
  step("waveform generated (real FFmpeg peaks)", waveform.job?.status === "complete");

  const analysis = await pollUntil("source analysis completes", (body) => {
    const row = body.sources?.find((source) => source.id === sourceAssetId)?.analysis;
    return row && ["complete", "failed"].includes(row.status) ? { done: true, row } : { done: false, row };
  });
  const analysisRow = analysis.row;
  step("analysis engine is arena-js-dsp", analysisRow?.analysisEngine === "arena-js-dsp", { info: `${analysisRow?.analysisEngine}@${analysisRow?.analysisEngineVersion}` });
  step("analysis produced BPM", typeof analysisRow?.bpm === "number" && analysisRow.bpm > 40 && analysisRow.bpm < 300, { info: `bpm=${analysisRow?.bpm}` });
  step("analysis produced a key", typeof analysisRow?.musicalKey === "string" && analysisRow.musicalKey.length > 0, { info: analysisRow?.musicalKey });
  const beatGrid = typeof analysisRow?.beatGrid === "string" ? JSON.parse(analysisRow.beatGrid) : analysisRow?.beatGrid;
  step("analysis produced a beat grid", Array.isArray(beatGrid) && beatGrid.length > 4, {
    info: `${Array.isArray(beatGrid) ? beatGrid.length : 0} beats`,
  });

  const sections = await pollUntil("section analysis reaches terminal state", (body) => {
    const row = body.sources?.find((source) => source.id === sourceAssetId)?.sectionAnalysis;
    return row && ["complete", "unavailable", "failed"].includes(row.status) ? { done: true, row } : { done: false, row };
  });
  step("section analysis terminal with honest provenance", ["complete", "unavailable"].includes(sections.row?.status) && sections.row?.analysisEngine === "arena-js-structure", {
    info: `status=${sections.row?.status} engine=${sections.row?.analysisEngine}`,
  });

  // --- passthrough stem (existing product surface) ---------------------------
  const passthrough = await api("/api/stems/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceAssetId }),
  });
  step("passthrough stem created (honest engine passthrough-unseparated)", passthrough.status === 201 && passthrough.body.stem?.engine === "passthrough-unseparated");

  // --- remix session + version + export --------------------------------------
  const remix = await api(`/api/waveyard/projects/${projectId}/remixes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Desktop E2E remix" }),
  });
  step("remix session created from the stem", remix.status === 201 && remix.body.remix?.id, { info: `status ${remix.status}` });
  const remixId = remix.body.remix?.id;

  const version = await api(`/api/remixes/${remixId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "v1" }),
  });
  step("remix version snapshotted", version.status === 201 && version.body.version?.id, { info: `status ${version.status}` });
  const versionId = version.body.version?.id;

  const exportJob = await api(`/api/remix-versions/${versionId}/exports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "wav" }),
  });
  step("export job created", exportJob.status === 201 && exportJob.body.job?.id, { info: `status ${exportJob.status}` });

  const exportRow = exportJob.body.job;
  let finalExport = exportRow;
  {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const detail = await api(`/api/remix-versions/${versionId}/exports`);
      const job = detail.body.exports?.find((job) => job.id === exportRow.id);
      if (job && ["complete", "failed"].includes(job.status)) {
        finalExport = job;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  step("export completed (real FFmpeg render)", finalExport.status === "complete", {
    info: `status=${finalExport.status} error=${finalExport.errorMessage ?? "none"}`,
  });

  if (finalExport.status === "complete") {
    const media = await fetch(`${url}/api/exports/${finalExport.id}/media`);
    step("export media downloadable", media.status === 200, { info: `${media.headers.get("content-type")} ${media.headers.get("content-length")} bytes` });
    const bytes = Buffer.from(await media.arrayBuffer());
    const downloadPath = path.join(tempDir, "downloaded.wav");
    writeFileSync(downloadPath, bytes);
    const probe = execFileSync(path.join(appRoot, "bin", "ffprobe"), [
      "-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_name,sample_rate,channels",
      "-of", "json", downloadPath,
    ], { stdio: "pipe" });
    const parsed = JSON.parse(String(probe));
    const stream = parsed.streams[0];
    const duration = Number(parsed.format.duration);
    step("downloaded export is real audio (ffprobe-verified)", stream?.codec_name === "pcm_s16le" && duration > 10 && duration < 14, {
      info: `${stream.codec_name} ${duration.toFixed(2)}s ${stream.sample_rate}Hz ${stream.channels}ch ${bytes.length} bytes`,
    });
    // Non-silence check: decode min/max via volumedetect (prints to stderr).
    const volume = spawnSync(path.join(appRoot, "bin", "ffmpeg"), ["-v", "info", "-i", downloadPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
    const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(volume.stderr))?.[1];
    step("export contains real signal (not silence)", meanVolume !== undefined && Number(meanVolume) > -60, { info: `mean ${meanVolume} dB` });
  }

  // --- diagnostics -------------------------------------------------------------
  const diagnostics = await api("/api/desktop/diagnostics");
  const components = diagnostics.body.components ?? {};
  step("diagnostics: database READY", components.database?.status === "READY", { info: components.database?.reason?.slice(0, 100) });
  step("diagnostics: storage READY", components.storage?.status === "READY");
  step("diagnostics: ffmpeg READY (packaged binary)", components.ffmpeg?.status === "READY" && components.ffmpeg?.detail?.path?.startsWith?.(appRoot), { info: components.ffmpeg?.detail?.path });
  step("diagnostics: worker reports the local executor", components.worker?.status !== "UNAVAILABLE" && /arena|Local executor/i.test(String(components.worker?.reason ?? "")), {
    info: components.worker?.reason?.slice(0, 140),
  });
  step("diagnostics: ai honestly DEGRADED without keys", components.ai?.status === "DEGRADED", { info: components.ai?.reason?.slice(0, 100) });

  // --- ordered shutdown ---------------------------------------------------------
  await supervisor.stop();
  const stoppedStatus = supervisor.status;
  step("ordered shutdown: postgres stopped", ["stopped", "failed"].includes(stoppedStatus.postgres?.state), { info: stoppedStatus.postgres?.state });

  // --- restart: persistence + migration skip ------------------------------------
  supervisor = new ArenaRuntimeSupervisor(config, { logger });
  url = await supervisor.start();
  const restartStatus = supervisor.status;
  step("restart reaches ready", restartStatus.phase === "ready");
  step("restart does NOT re-initdb", restartStatus.postgres?.firstRun === false);
  const projectAfter = await api("/api/waveyard/projects");
  const survived = projectAfter.body.projects?.some((row) => row.id === projectId);
  step("project persisted across restart", survived === true, { info: `projects: ${projectAfter.body.projects?.length}` });
  const detailAfter = await api(`/api/waveyard/projects/${projectId}`);
  const sourceAfter = detailAfter.body.sources?.find((source) => source.id === sourceAssetId);
  step("analysis persisted across restart", sourceAfter?.analysis?.status === "complete" && sourceAfter?.analysis?.analysisEngine === "arena-js-dsp");
  const stemAfter = detailAfter.body.stems?.some((stem) => stem.engine === "passthrough-unseparated");
  step("stem persisted across restart", stemAfter === true);

  await supervisor.stop();

  // --- report --------------------------------------------------------------------
  writeFileSync(reportPath, JSON.stringify({ ok: !failed, steps, logs: logs.slice(-200) }, null, 2));
  console.log(failed ? `E2E FAILED — report: ${reportPath}` : `E2E PASSED — report: ${reportPath}`);
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  step("E2E crashed", false, { info: String(error?.stack ?? error) });
  writeFileSync(reportPath, JSON.stringify({ ok: false, steps, error: String(error?.stack ?? error) }, null, 2));
  process.exitCode = 1;
});
