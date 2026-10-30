/**
 * Real Windows Waveyard check. This uses the installed app, its local worker,
 * prepared ONNX weights, and one real audio file. Audio and its filename are
 * never copied into the report; all app data is isolated in a temporary root.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { open, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import {
  measurePcmWavSignal,
  probeAudioFile,
  writeCompressedAudioExcerpt,
  writePcmWavExcerpt,
} from "./waveyard-audio.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "../generated-artifacts/windows-waveyard");
const reportName = `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const reportPath = path.join(outputDir, reportName);
const exe = process.argv[2];
const audioPath = process.argv[3];
const mediaToolsDir = exe ? path.join(path.dirname(exe), "resources", "bin") : "";
const ffmpegPath = mediaToolsDir ? path.join(mediaToolsDir, "ffmpeg.exe") : "";
const ffprobePath = mediaToolsDir ? path.join(mediaToolsDir, "ffprobe.exe") : "";
const defaultModelsPath = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Arena", "waveyard", "models")
  : "";
const modelsPath = process.argv[4] || process.env.WAVEYARD_MODELS_DIR || defaultModelsPath;
const maxSeconds = Number(process.argv[5] ?? 20);
const startSeconds = Number(process.argv[6] ?? 0);
const requiredModels = ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"];
const execFileAsync = promisify(execFile);
const report = {
  passed: false,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  machine: {
    windowsVersion: os.version(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    physicalMemoryBytes: os.totalmem(),
    gpuNames: [],
  },
  file: null,
  model: null,
  timings: {},
  memory: { samples: 0, peakWorkingSetBytes: 0, peakPrivateBytes: 0 },
  checks: [],
};

let desktop;
let page;
let base;
let isolatedDataRoot;
let memoryTimer;
let memorySampleInFlight = null;
let failure = null;
const memorySamples = [];

function record(name, details = {}) {
  report.checks.push({ name, passed: true, ...details });
  console.log(`PASS: ${name}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  let text = value instanceof Error ? value.message : String(value);
  for (const secretPath of [audioPath, modelsPath, isolatedDataRoot, exe]) {
    if (secretPath) text = text.split(secretPath).join("[local path]");
  }
  if (audioPath) text = text.split(path.basename(audioPath)).join("[audio file]");
  return text;
}

async function apiGet(route) {
  const response = await page.request.get(`${base}${route}`, { timeout: 30_000 });
  const payload = await response.json().catch(() => ({}));
  assert(response.ok(), `${route}: ${payload.error ?? `HTTP ${response.status()}`}`);
  return payload;
}

async function readPcmWav(filePath) {
  const info = await stat(filePath);
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    assert(bytesRead >= 44, "The selected audio file is too short to be a WAV.");
    assert.equal(header.toString("ascii", 0, 4), "RIFF", "Use an uncompressed RIFF/WAV file.");
    assert.equal(header.toString("ascii", 8, 12), "WAVE", "Use an uncompressed RIFF/WAV file.");

    let format = null;
    let dataBytes = 0;
    let dataOffset = 0;
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const name = header.toString("ascii", offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (name === "fmt ") {
        assert(chunkSize >= 16 && chunkStart + 16 <= bytesRead, "The WAV format header is incomplete.");
        format = {
          code: header.readUInt16LE(chunkStart),
          channels: header.readUInt16LE(chunkStart + 2),
          sampleRate: header.readUInt32LE(chunkStart + 4),
          bitsPerSample: header.readUInt16LE(chunkStart + 14),
        };
      } else if (name === "data") {
        dataBytes = Math.min(chunkSize, Math.max(0, info.size - chunkStart));
        dataOffset = chunkStart;
      }
      if (format && dataBytes > 0) break;
      offset = chunkStart + chunkSize + (chunkSize % 2);
      if (offset >= info.size) break;
    }

    assert(format, "The WAV file has no readable format chunk.");
    assert.equal(format.code, 1, "Use PCM audio (not compressed WAV).");
    assert.equal(format.bitsPerSample, 16, "Use 16-bit PCM WAV audio.");
    assert.equal(format.channels, 2, "Use stereo audio for this separation check.");
    assert.equal(format.sampleRate, 44_100, "The fast PCM excerpt path expects 44.1 kHz audio.");
    assert(dataBytes > 0, "The WAV file has no audio data.");
    const durationSeconds = dataBytes / (format.sampleRate * format.channels * (format.bitsPerSample / 8));
    assert(durationSeconds <= 900, "Choose a track shorter than 15 minutes for this first measurement.");
    return {
      format: "WAV PCM 16-bit",
      formatCode: format.code,
      sizeBytes: info.size,
      channels: format.channels,
      sampleRateHz: format.sampleRate,
      bitsPerSample: format.bitsPerSample,
      dataOffset,
      dataBytes,
      durationSeconds: Number(durationSeconds.toFixed(2)),
    };
  } finally {
    await handle.close();
  }
}

async function sampleProcessTree(rootPid) {
  const command = `
$root = ${Number(rootPid)}
$all = Get-CimInstance -ClassName Win32_Process
$ids = New-Object 'System.Collections.Generic.List[int]'
$ids.Add($root)
do {
  $changed = $false
  foreach ($proc in $all) {
    $parent = [int]$proc.ParentProcessId
    $child = [int]$proc.ProcessId
    if ($ids.Contains($parent) -and -not $ids.Contains($child)) {
      $ids.Add($child)
      $changed = $true
    }
  }
} while ($changed)
$selected = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
$working = ($selected | Measure-Object -Property WorkingSetSize -Sum).Sum
$private = ($selected | Measure-Object -Property PrivatePageCount -Sum).Sum
if ($null -eq $working) { $working = 0 }
if ($null -eq $private) { $private = 0 }
[pscustomobject]@{
  workingSetBytes = [int64]$working
  privateBytes = [int64]$private
  processCount = $selected.Count
} | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command,
  ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

async function sampleGpuNames() {
  const command = "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", command,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim() || "[]");
    report.machine.gpuNames = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
  } catch {
    report.machine.gpuNames = [];
  }
}

async function assertAppClosed() {
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "if (Get-Process -Name ArenaForge -ErrorAction SilentlyContinue) { exit 7 }"],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    if (error?.code === 7) throw new Error("Close ArenaForge before running this isolated measurement.");
    throw new Error("Could not verify that ArenaForge is closed; run this from Windows PowerShell.");
  }
}

async function launch() {
  desktop = await _electron.launch({
    executablePath: exe,
    timeout: 150_000,
    args: ["--autoplay-policy=no-user-gesture-required"],
    env: {
      ...process.env,
      ARENA_DATA_DIR: isolatedDataRoot,
      ARENA_TEST_WAVEYARD_STORAGE_DIR: path.join(isolatedDataRoot, "waveyard", "storage"),
      ARENA_TEST_WAVEYARD_MODELS_DIR: modelsPath,
    },
  });
  page = await desktop.firstWindow({ timeout: 150_000 });
  await page.waitForURL("**/spaces", { timeout: 150_000 });
  base = new URL(page.url()).origin;
  await page.addInitScript(() => {
    window.audioProbe = { sources: [], masterGains: [] };
    const OriginalAudioContext = window.AudioContext;
    if (!OriginalAudioContext) return;
    window.AudioContext = class extends OriginalAudioContext {
      constructor(...args) {
        super(...args);
        this.probeFirstGain = true;
      }
      createGain() {
        const node = super.createGain();
        const connect = node.connect.bind(node);
        node.connect = (target, ...args) => {
          node.nextNode = target;
          return connect(target, ...args);
        };
        if (this.probeFirstGain) {
          window.audioProbe.masterGains.push(node);
          this.probeFirstGain = false;
        }
        return node;
      }
      createMediaElementSource(media) {
        const node = super.createMediaElementSource(media);
        const connect = node.connect.bind(node);
        node.connect = (target, ...args) => {
          node.inputNode = target;
          return connect(target, ...args);
        };
        node.mediaElement = media;
        window.audioProbe.sources.push(node);
        return node;
      }
    };
  });
  await page.goto(`${base}/waveyard`);
}

async function waitForSeparation(track) {
  const deadline = Date.now() + 45 * 60_000;
  let latestJob = null;
  let latestProject = null;
  let stems = [];
  let activePass = null;
  const observedPasses = [];
  const finishActivePass = (observedAt = performance.now()) => {
    if (!activePass) return;
    observedPasses.push({
      phase: activePass.phase,
      model: activePass.model,
      observedDurationSeconds: Number(((observedAt - activePass.startedAt) / 1000).toFixed(2)),
    });
    activePass = null;
  };
  const captureProgress = (job) => {
    let metadata = job?.metadata ?? {};
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    const progress = metadata?.progress;
    const nextPass = typeof progress?.phase === "string" && typeof progress?.model === "string"
      ? { phase: progress.phase, model: progress.model }
      : null;
    if (activePass && (nextPass?.phase !== activePass.phase || nextPass?.model !== activePass.model)) {
      finishActivePass();
    }
    if (nextPass && !activePass) {
      activePass = { ...nextPass, startedAt: performance.now() };
    }
  };
  const saveObservedPasses = () => {
    finishActivePass();
    report.timings.progressObservedModelPasses = observedPasses;
    report.timings.progressObservationIntervalSeconds = 2;
  };
  while (Date.now() < deadline) {
    latestProject = await apiGet(`/api/waveyard/projects/${track.studioProjectId}`);
    latestJob = (latestProject.jobs ?? []).find(
      (job) => job.type === "separation" && job.sourceAssetId === track.source.id,
    ) ?? null;
    captureProgress(latestJob);
    stems = (latestProject.stems ?? []).filter(
      (stem) => stem.sourceAssetId === track.source.id && stem.engine !== "passthrough-unseparated",
    );
    if (latestJob?.status === "failed") {
      saveObservedPasses();
      throw new Error(`Separation failed: ${latestJob.errorMessage ?? latestJob.errorCode ?? latestJob.stage}`);
    }
    if (latestJob?.status === "complete" && stems.length === 4) {
      saveObservedPasses();
      return { job: latestJob, project: latestProject, stems };
    }
    await delay(2_000);
  }
  saveObservedPasses();
  throw new Error(`Separation did not produce four stems within 45 minutes (last status: ${latestJob?.status ?? "no job"}).`);
}

async function run() {
  assert.equal(process.platform, "win32", "This check only counts when run on Windows.");
  assert.equal(process.arch, "x64", "This package targets Windows x64.");
  assert(exe && path.isAbsolute(exe), "Pass the absolute path to the installed ArenaForge.exe.");
  assert(audioPath && path.isAbsolute(audioPath), "Pass the absolute path to a real audio file.");
  assert(modelsPath && path.isAbsolute(modelsPath), "Pass or configure the local Waveyard model-cache path.");
  assert(
    Number.isInteger(maxSeconds) && (maxSeconds === 0 || (maxSeconds >= 2 && maxSeconds <= 20)),
    "Maximum duration must be 0 (full remaining file) or 2–20 seconds.",
  );
  assert(Number.isInteger(startSeconds) && startSeconds >= 0 && startSeconds <= 899, "Start time must be an integer from 0 to 899 seconds.");
  assert(await stat(exe).catch(() => null), "The ArenaForge executable was not found.");
  assert(await stat(ffmpegPath).catch(() => null), "The installed app is missing its bundled FFmpeg binary.");
  assert(await stat(ffprobePath).catch(() => null), "The installed app is missing its bundled FFprobe binary.");
  const modelsStat = await stat(modelsPath).catch(() => null);
  assert(modelsStat?.isDirectory(), "The model cache was not found; prepare the four stem models in Waveyard first.");
  await assertAppClosed();
  const extension = path.extname(audioPath).toLowerCase();
  assert(
    [".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".wma"].includes(extension),
    "Choose a supported audio file such as MP3, M4A, WAV, FLAC, or OGG.",
  );
  const sourceMetadata = await probeAudioFile(audioPath, ffprobePath);
  const sourceStat = await stat(audioPath);
  assert(sourceMetadata.durationSeconds <= 900, "Choose a track shorter than 15 minutes for this first measurement.");
  let pcmWavInfo = null;
  if (extension === ".wav") {
    try {
      pcmWavInfo = await readPcmWav(audioPath);
    } catch {
      // FFmpeg will make the bounded excerpt for WAV variants that cannot use
      // the fast, format-preserving PCM byte-copy path.
    }
  }
  const sourceFile = {
    ...sourceMetadata,
    sizeBytes: sourceStat.size,
    pcmWavInfo,
  };
  record(`Bundled FFprobe read the selected ${sourceMetadata.codec} audio file`);
  await sampleGpuNames();

  isolatedDataRoot = await mkdtemp(path.join(os.tmpdir(), "arena-waveyard-measure-"));
  let measurementAudioPath = audioPath;
  let excerpt = {
    startSeconds: 0,
    durationSeconds: sourceFile.durationSeconds,
    sizeBytes: sourceFile.sizeBytes,
  };
  if (startSeconds > 0 || maxSeconds > 0) {
    measurementAudioPath = path.join(isolatedDataRoot, `waveyard-measurement${extension}`);
    if (pcmWavInfo) {
      excerpt = await writePcmWavExcerpt(audioPath, measurementAudioPath, pcmWavInfo, {
        startSeconds,
        maxSeconds,
      });
    } else {
      excerpt = await writeCompressedAudioExcerpt(audioPath, measurementAudioPath, {
        ffmpegPath,
        ffprobePath,
        startSeconds,
        maxSeconds,
      });
    }
  }
  report.file = {
    format: sourceFile.format,
    codec: sourceFile.codec,
    sourceSizeBytes: sourceFile.sizeBytes,
    sourceDurationSeconds: sourceFile.durationSeconds,
    processedStartSeconds: excerpt.startSeconds,
    processedDurationSeconds: excerpt.durationSeconds,
    sizeBytes: excerpt.sizeBytes,
    channels: sourceFile.channels,
    sampleRateHz: sourceFile.sampleRateHz,
    durationSeconds: excerpt.durationSeconds,
  };
  await launch();
  record("Packaged Windows app launched with an isolated library and local model cache");

  const processing = await apiGet("/api/waveyard/processing-status");
  assert(
    processing.localWorker?.queues?.includes("waveyard-separation"),
    "The local separation worker did not register its real job handler.",
  );
  const modelStatus = await apiGet("/api/waveyard/separation/models");
  const modelById = new Map((modelStatus.models ?? []).map((model) => [model.id, model]));
  const missing = requiredModels.filter((id) => !modelById.get(id)?.ready);
  assert.equal(
    missing.length,
    0,
    `Prepare the four Waveyard models before measuring. Not ready: ${missing.join(", ") || "model registry incomplete"}.`,
  );
  record("Local worker and all four real separation models are ready");

  const memoryRootPid = desktop.process().pid;
  const sampleMemory = async () => {
    if (memorySampleInFlight !== null) return memorySampleInFlight;
    memorySampleInFlight = sampleProcessTree(memoryRootPid)
      .then((sample) => memorySamples.push(sample))
      .catch(() => {})
      .finally(() => { memorySampleInFlight = null; });
    return memorySampleInFlight;
  };
  await sampleMemory();
  memoryTimer = setInterval(() => { void sampleMemory(); }, 2_000);

  const uploadStarted = performance.now();
  const uploadResponsePromise = page.waitForResponse(
    (response) => response.url().split("?")[0] === `${base}/api/library/tracks`
      && response.request().method() === "POST",
    { timeout: 5 * 60_000 },
  );
  await page.getByLabel("Add music files", { exact: true }).setInputFiles(measurementAudioPath);
  const uploadResponse = await uploadResponsePromise;
  const uploadBody = await uploadResponse.json().catch(() => ({}));
  assert(uploadResponse.ok(), uploadBody.error ?? `Audio import returned ${uploadResponse.status()}.`);
  assert.equal(uploadBody.separationQueued, true, "The real separation job was not accepted.");
  const trackId = uploadBody.track?.id;
  assert(typeof trackId === "string", "Audio import did not return a library track.");
  report.timings.uploadToQueueSeconds = Number(((performance.now() - uploadStarted) / 1000).toFixed(2));
  record(`Real ${sourceFile.codec} audio uploaded through the Waveyard library workflow`);

  const trackPayload = await apiGet(`/api/library/tracks/${trackId}`);
  const track = trackPayload.track;
  assert(track?.source?.id && track?.studioProjectId, "The imported track has no source or Studio project metadata.");
  report.file.codec = track.source.codec;
  report.file.sampleRateHz = track.source.sampleRate ?? report.file.sampleRateHz;
  report.file.channels = track.source.channels ?? report.file.channels;
  report.file.bitrateBitsPerSecond = track.source.bitrate;
  report.file.durationSeconds = track.durationSeconds ?? report.file.durationSeconds;

  const separationStarted = performance.now();
  const result = await waitForSeparation(track);
  report.timings.uploadToSeparationCompleteSeconds = Number(((performance.now() - uploadStarted) / 1000).toFixed(2));
  const metadata = typeof result.job.metadata === "string"
    ? JSON.parse(result.job.metadata)
    : (result.job.metadata ?? {});
  assert(typeof metadata.engine === "string", "The completed job did not record its inference engine.");
  assert(Array.isArray(metadata.models) && metadata.models.length === 4, "The job did not record all four model passes.");
  assert.equal(result.job.requestedDevice, "auto", "The Windows measurement must exercise automatic device selection.");
  const resolvedDevice = typeof metadata.resolvedDevice === "string" ? metadata.resolvedDevice : null;
  assert(
    resolvedDevice,
    `The job did not record its resolved device; DirectML selected: ${resolvedDevice === "dml"}.`,
  );
  const directMlSelected = resolvedDevice.toLowerCase() === "dml";
  report.model = {
    requested: result.job.model,
    requestedDevice: result.job.requestedDevice,
    actualModels: metadata.models ?? [],
    engine: metadata.engine ?? null,
    resolvedDevice,
    directMlSelected,
  };
  record("Windows separation provider", { resolvedDevice, directMlSelected });
  report.timings.inferenceSeconds = result.job.startedAt && result.job.completedAt
    ? Number(((Date.parse(result.job.completedAt) - Date.parse(result.job.startedAt)) / 1000).toFixed(2))
    : Number(((performance.now() - separationStarted) / 1000).toFixed(2));
  if (result.job.createdAt && result.job.startedAt) {
    report.timings.queueWaitSeconds = Number(
      ((Date.parse(result.job.startedAt) - Date.parse(result.job.createdAt)) / 1000).toFixed(2),
    );
  }
  report.outputs = result.stems.map((stem) => ({
    stemType: stem.stemType,
    engine: stem.engine,
    model: stem.model,
    codec: stem.codec,
    sampleRateHz: stem.sampleRate,
    channels: stem.channels,
    fileSizeBytes: stem.fileSizeBytes,
  }));
  const stemMap = Object.fromEntries(result.stems.map((stem) => [stem.stemType, stem.id]));
  assert.deepEqual(Object.keys(stemMap).sort(), ["bass", "drums", "other", "vocals"]);
  assert(result.stems.every((stem) => stem.fileSizeBytes > 0 && stem.checksumSha256));
  record("Four non-empty separated audio assets were persisted", {
    outputStemCount: result.stems.length,
    stemTypes: Object.keys(stemMap).sort(),
  });

  const liveMixerLink = page.getByRole("link", { name: "Open live mixer", exact: true });
  await liveMixerLink.waitFor({ timeout: 60_000 });
  await liveMixerLink.click();
  const switchButton = page.locator('[data-testid^="button-switch-stems-"]').first();
  await switchButton.waitFor({ timeout: 90_000 });
  const stemIds = Object.values(stemMap);
  const responseStatuses = new Map();
  const audioResponseBodies = new Map();
  const stemIdSet = new Set(stemIds);
  const collectAssetResponse = (response) => {
    const id = new URL(response.url()).pathname.split("/").at(-1);
    if (!stemIdSet.has(id)) return;
    responseStatuses.set(id, response.status());
    if (response.status() === 200) {
      audioResponseBodies.set(id, response.body().catch(() => null));
    }
  };
  page.on("response", collectAssetResponse);
  await switchButton.click();
  await page.waitForFunction((ids) => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4
      && audio.every((element) => element.readyState >= 2 && !element.paused)
      && ids.every((id) => audio.some((element) => (element.currentSrc || element.src).includes(id)));
  }, stemIds, { timeout: 120_000 });

  const audioSignalByStem = {};
  const pcmFingerprints = new Set();
  for (const [stemType, id] of Object.entries(stemMap)) {
    const bodyPromise = audioResponseBodies.get(id);
    assert(bodyPromise, `The ${stemType} stem response body was not captured.`);
    const body = await bodyPromise;
    assert(body, `The ${stemType} stem response body could not be read.`);
    const metrics = measurePcmWavSignal(body);
    assert(
      metrics.rms > 0.000001,
      `The ${stemType} stem is silent (RMS ${metrics.rms}, peak ${metrics.peakAbsolute}).`,
    );
    const { pcmFingerprint, ...reportMetrics } = metrics;
    pcmFingerprints.add(pcmFingerprint);
    audioSignalByStem[stemType] = reportMetrics;
  }
  assert.equal(
    pcmFingerprints.size,
    Object.keys(stemMap).length,
    "Two or more stems contain identical PCM audio instead of distinct separation outputs.",
  );
  report.audioSignal = {
    minimumRms: 0.000001,
    distinctPcmStemCount: pcmFingerprints.size,
    stems: audioSignalByStem,
  };

  const current = page.locator('[data-role="current"]');
  const isolate = current.getByLabel("Isolate vocals", { exact: true });
  await isolate.click();
  await page.waitForFunction((ids) => {
    const values = Object.fromEntries(ids.map((id) => {
      const source = [...window.audioProbe.sources].reverse().find((item) => {
        const url = item.mediaElement?.currentSrc || item.mediaElement?.src || "";
        return url.split("?")[0].split("/").at(-1) === id;
      });
      const url = source?.mediaElement?.currentSrc || source?.mediaElement?.src || "";
      return [id, source?.inputNode?.nextNode?.gain?.value];
    }));
    return Object.values(values).every((value) => typeof value === "number")
      && values[ids.vocals] > 0.9
      && ["drums", "bass", "other"].every((type) => values[ids[type]] < 0.01);
  }, stemMap, { timeout: 15_000 });
  assert.equal(await isolate.getAttribute("aria-pressed"), "true");
  const before = await current.locator("audio").evaluateAll((elements) => elements.map((element) => element.currentTime));
  await page.waitForTimeout(1_000);
  const after = await current.locator("audio").evaluateAll((elements) => elements.map((element) => element.currentTime));
  assert.equal(after.length, 4);
  assert(after.every((time, index) => time > before[index]), "The isolated stem deck stopped advancing.");
  assert(stemIds.every((id) => responseStatuses.get(id) === 200), "One or more real stem assets did not return HTTP 200.");
  page.off("response", collectAssetResponse);
  report.timings.uploadToPlayableIsolatedStemsSeconds = Number(((performance.now() - uploadStarted) / 1000).toFixed(2));
  record("Four distinct non-silent real stems play in sync and vocal isolation changes their audio gains", {
    rmsByStem: Object.fromEntries(
      Object.entries(audioSignalByStem).map(([stemType, metrics]) => [stemType, metrics.rms]),
    ),
  });

  report.passed = true;
}

try {
  await run();
} catch (error) {
  failure = sanitize(error);
  report.error = failure;
  console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
} finally {
  if (memoryTimer) clearInterval(memoryTimer);
  await memorySampleInFlight?.catch(() => {});
  if (desktop) await desktop.close().catch(() => {});
  if (isolatedDataRoot) await rm(isolatedDataRoot, { recursive: true, force: true }).catch(() => {});
  report.completedAt = new Date().toISOString();
  if (memorySamples.length > 0) {
    report.memory.samples = memorySamples.length;
    report.memory.peakWorkingSetBytes = Math.max(...memorySamples.map((sample) => sample.workingSetBytes ?? 0));
    report.memory.peakPrivateBytes = Math.max(...memorySamples.map((sample) => sample.privateBytes ?? 0));
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
}
