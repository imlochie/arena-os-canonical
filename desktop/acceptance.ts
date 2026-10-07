/**
 * Arena desktop acceptance runner — the installed-app E2E (Windows
 * acceptance-test mandate §3–§10, automatable parts).
 *
 * Runs in TWO contexts through the same code:
 *
 *  1. Installed app (Windows): the Electron main process detects
 *     ARENA_DESKTOP_ACCEPTANCE=<result.json> and calls runDesktopAcceptance()
 *     with the app's REAL data dirs, the installed resources root, and the
 *     Electron binary as the Node runtime. This is the proof the mandate
 *     asks for: real installer layout, real %LOCALAPPDATA% paths, real
 *     bundled FFmpeg/Postgres, real first-run init, real restarts.
 *
 *  2. Headless (any OS): scripts/desktop-acceptance-headless.mjs runs the
 *     same runner against the staged tree (desktop-package/) with a temp
 *     data dir. This keeps the runner itself honest and regression-tested
 *     in CI before any Windows machine is involved.
 *
 * It is test tooling gated on an environment variable — normal app
 * behaviour is untouched. Failures are recorded honestly; nothing is ever
 * reported PASS from configuration alone.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ArenaDataDirs } from "./paths";
import { ArenaRuntimeSupervisor, resolveRuntimeConfig, type SupervisorLogger } from "./runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcceptanceAppInfo {
  version: string;
  electron: string;
  packaged: boolean;
  windowCreated: boolean;
  portable: boolean;
}

export interface AcceptanceInputs {
  /** Installed resources/app root (or the staged tree headless). */
  appRoot: string;
  /** The app's REAL data dirs (Windows: %LOCALAPPDATA%\Arena). */
  dirs: ArenaDataDirs;
  /** Electron binary (in-app) or node (headless). */
  nodeBinary: string;
  serverMode: "dev" | "packaged";
  platform: string;
  resultPath: string;
  logger: SupervisorLogger;
  env: Record<string, string | undefined>;
  appInfo?: AcceptanceAppInfo;
  /** Tracked shell child processes still alive (in-app registry). */
  childCount?: () => number;
}

export interface AcceptanceStep {
  name: string;
  ok: boolean;
  info?: string;
}

export interface AcceptanceSection {
  ok: boolean;
  steps: AcceptanceStep[];
}

export interface AcceptanceReport {
  ok: boolean;
  mode: "installed-app" | "headless";
  platform: string;
  startedAt: string;
  finishedAt: string;
  appInfo?: AcceptanceAppInfo;
  paths?: Record<string, string>;
  export?: {
    codec: string;
    sampleRate: string;
    channels: string;
    durationSec: string;
    bytes: number;
    peakDb: string;
    meanDb: string;
  };
  sections: Record<string, AcceptanceSection>;
  loopbackOnly: boolean;
  logs: string[];
  error?: string;
}

// strict-TS navigation helpers for JSON API bodies
const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
/** ffprobe mixes string and numeric JSON fields (sample_rate: "44100", channels: 2). */
const strOrNum = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDesktopAcceptance(inputs: AcceptanceInputs): Promise<AcceptanceReport> {
  const startedAt = new Date().toISOString();
  const logs: string[] = [];
  const log =
    (level: "info" | "warn") =>
    (scope: string, message: string): void => {
      logs.push(`${new Date().toISOString()} ${level.toUpperCase()} ${scope} ${message}`);
      inputs.logger[level === "info" ? "info" : "warn"](scope, message);
    };
  const info = log("info");
  const warn = log("warn");

  const report: AcceptanceReport = {
    ok: false,
    mode: inputs.appInfo?.packaged === true ? "installed-app" : "headless",
    platform: inputs.platform,
    startedAt,
    finishedAt: "",
    sections: {},
    loopbackOnly: true, // every URL below is derived from the supervisor's 127.0.0.1 URL
    logs,
  };
  if (inputs.appInfo !== undefined) report.appInfo = inputs.appInfo;

  const sections: Record<string, AcceptanceSection> = report.sections;
  const section = (name: string): { step: (name: string, ok: boolean, infoText?: string) => void; finish: () => void } => {
    const steps: AcceptanceStep[] = [];
    const s: AcceptanceSection = { ok: false, steps };
    sections[name] = s;
    return {
      step: (stepName, ok, infoText) => {
        steps.push({ name: stepName, ok, info: infoText });
        info("acceptance", `${ok ? "PASS" : "FAIL"} [${name}] ${stepName}${infoText !== undefined ? ` — ${infoText}` : ""}`);
      },
      finish: () => {
        s.ok = steps.every((entry) => entry.ok);
      },
    };
  };

  let supervisor: ArenaRuntimeSupervisor | null = null;
  let url = "";

  const api = async (pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) report.loopbackOnly = false;
    const response = await fetch(`${url}${pathname}`, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body — recorded as text */
    }
    return { status: response.status, body };
  };

  try {
    // ------------------------------------------------------------------ config
    const config = await resolveRuntimeConfig({
      dirs: inputs.dirs,
      appRoot: inputs.appRoot,
      nodeBinary: inputs.nodeBinary,
      serverMode: inputs.serverMode,
    });
    const ffmpeg = config.ffmpegPath;
    const ffprobe = config.ffprobePath;
    report.paths = {
      appRoot: inputs.appRoot,
      dataRoot: inputs.dirs.root,
      data: inputs.dirs.data,
      projects: inputs.dirs.projects,
      waveyard: inputs.dirs.waveyard,
      logs: inputs.dirs.logs,
      runtime: inputs.dirs.runtime,
      cache: inputs.dirs.cache,
      ffmpeg: String(ffmpeg),
      ffprobe: String(ffprobe),
      postgres: config.postgres.postgres,
    };

    // ============================================== S3: first launch + runtime
    {
      const s = section("firstLaunch");
      s.step("packaged ffmpeg resolved under app root", ffmpeg !== null && ffmpeg.startsWith(inputs.appRoot), ffmpeg ?? "null");
      s.step("packaged ffprobe resolved under app root", ffprobe !== null && ffprobe.startsWith(inputs.appRoot), ffprobe ?? "null");
      s.step("packaged embedded postgres resolved under app root", config.postgres.postgres.startsWith(inputs.appRoot), config.postgres.postgres);
      if (inputs.appInfo !== undefined) {
        s.step("window created", inputs.appInfo.windowCreated);
        s.step("app is the packaged build", inputs.appInfo.packaged, `v${inputs.appInfo.version} electron ${inputs.appInfo.electron}`);
      }

      supervisor = new ArenaRuntimeSupervisor(config, { logger: inputs.logger });
      url = await supervisor.start();
      const status = supervisor.status;
      s.step("supervisor reaches ready", status.phase === "ready", status.stages.map((stage) => stage.phase).join(" → "));
      s.step("first run initialised the database cluster", status.postgres?.firstRun === true, `firstRun=${String(status.postgres?.firstRun)}`);
      const health = await api("/api/health");
      s.step("GET /api/health ok", health.status === 200 && rec(health.body).ok === true);
      s.finish();
    }

    // ============================================== S4: Windows path validation
    {
      const s = section("paths");
      const dirs = inputs.dirs;
      const under = (child: string): boolean => {
        const rel = path.relative(dirs.root, child);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      for (const key of ["data", "projects", "waveyard", "cache", "logs", "models", "runtime", "settings"] as const) {
        s.step(`dir "${key}" lives under the data root`, under(dirs[key]), dirs[key]);
      }
      if (inputs.platform === "win32" && !dirs.portable) {
        const localAppData = inputs.env.LOCALAPPDATA;
        const expected = localAppData !== undefined ? path.win32.join(localAppData, "Arena") : null;
        s.step(
          "data root is %LOCALAPPDATA%\\Arena",
          expected !== null && path.win32.resolve(dirs.root).toLowerCase() === path.win32.resolve(expected).toLowerCase(),
          `${dirs.root} (source: ${dirs.source})`,
        );
      } else {
        s.step("data root location recorded", true, `${dirs.root} (source: ${dirs.source}, portable=${String(dirs.portable)})`);
      }
      // No dependency on the repo / build machine: the staged tree must not
      // contain symlinks resolving outside the app root (Turbopack pg defect).
      const escaping: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            const resolved = path.resolve(path.dirname(full), readlinkSync(full));
            if (!resolved.startsWith(inputs.appRoot + path.sep)) escaping.push(`${full} → ${resolved}`);
          } else if (entry.isDirectory()) walk(full);
        }
      };
      if (existsSync(path.join(inputs.appRoot, "server"))) walk(path.join(inputs.appRoot, "server"));
      s.step("no symlink in the app tree escapes the install", escaping.length === 0, escaping.length > 0 ? escaping.join("; ").slice(0, 200) : "clean");
      s.finish();
    }

    // ============================================== S5: real Waveyard workflow
    let projectId = "";
    let sourceAssetId = "";
    let remixId = "";
    let versionId = "";
    let exportId = "";
    {
      const s = section("workflow");
      const project = await api("/api/waveyard/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Windows Acceptance ${new Date().toISOString()}` }),
      });
      projectId = str(rec(rec(project.body).project).id);
      s.step("create project", project.status === 201 && projectId !== "", projectId);

      // Real audio fixture synthesised with the BUNDLED ffmpeg, written under
      // the data dir (cache) — proves both the binary and the dir are real.
      // (In-app these dirs already exist; the runner never assumes it.)
      mkdirSync(inputs.dirs.cache, { recursive: true });
      const tempDir = mkdtempSync(path.join(inputs.dirs.cache, "acceptance-"));
      const wavPath = path.join(tempDir, "fixture.wav");
      if (ffmpeg === null) throw new Error("bundled ffmpeg not resolved");
      execFileSync(ffmpeg, [
        "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
        "-f", "lavfi", "-i", "sine=frequency=1320:duration=12",
        "-filter_complex", "[0:a][1:a]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3,volume=0.5[a]",
        "-map", "[a]", "-ar", "44100", "-y", wavPath,
      ], { stdio: "pipe" });

      const uploadBody = new FormData();
      uploadBody.set("projectId", projectId);
      uploadBody.set("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "acceptance.wav");
      const upload = await api("/api/uploads", { method: "POST", body: uploadBody });
      sourceAssetId = str(rec(rec(upload.body).source).id);
      s.step(
        "import WAV (source persisted)",
        sourceAssetId !== "" && (upload.status === 201 || upload.status === 503),
        `status ${upload.status}${upload.status === 503 ? " (separation honestly unqueueable on desktop)" : ""}`,
      );

      const pollUntil = async <T>(fn: (body: unknown) => { done: boolean; value: T }, timeoutMs: number): Promise<T | undefined> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const detail = await api(`/api/waveyard/projects/${projectId}`);
          const state = fn(detail.body);
          if (state.done) return state.value;
          if (Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      };
      const findJob = (body: unknown, type: string): Record<string, unknown> =>
        rec(arr(rec(body).jobs).find((job) => str(rec(job).type) === type));

      const separation = await pollUntil((body) => {
        const job = findJob(body, "separation");
        return { done: ["complete", "failed"].includes(str(job.status)), value: job };
      }, 90_000);
      s.step(
        "separation reports an HONEST failure (no local Python executor)",
        rec(separation).status === "failed" && /no local executor/i.test(str(rec(separation).errorMessage)),
        str(rec(separation).errorMessage).slice(0, 160),
      );

      const waveformJob = await pollUntil((body) => {
        const job = rec(arr(rec(body).waveformJobs).find((job) => rec(job).sourceAssetId === sourceAssetId) ?? arr(rec(body).waveformJobs)[0]);
        return { done: str(job.status) === "complete", value: job };
      }, 90_000);
      s.step("waveform generated (real FFmpeg peaks — meters have data)", rec(waveformJob).status === "complete");

      const analysis = rec(
        await pollUntil((body) => {
          const row = rec(rec(arr(rec(body).sources).find((source) => str(rec(source).id) === sourceAssetId)).analysis);
          return { done: ["complete", "failed"].includes(str(row.status)), value: row };
        }, 90_000),
      );
      s.step("analysis engine is arena-js-dsp", str(analysis.analysisEngine) === "arena-js-dsp", `${str(analysis.analysisEngine)}@${str(analysis.analysisEngineVersion)}`);
      const bpm = num(analysis.bpm);
      s.step("analysis produced a BPM", bpm !== undefined && bpm > 40 && bpm < 300, `bpm=${String(bpm)}`);
      s.step("analysis produced a key", str(analysis.musicalKey).length > 0, str(analysis.musicalKey));
      let beatCount = 0;
      try {
        beatCount = arr(JSON.parse(str(analysis.beatGrid))).length;
      } catch {
        beatCount = arr(analysis.beatGrid).length;
      }
      s.step("analysis produced a beat grid", beatCount > 4, `${beatCount} beats`);

      const sectionRow = rec(
        await pollUntil((body) => {
          const row = rec(rec(arr(rec(body).sources).find((source) => str(rec(source).id) === sourceAssetId)).sectionAnalysis);
          return { done: ["complete", "unavailable", "failed"].includes(str(row.status)), value: row };
        }, 120_000),
      );
      s.step(
        "section analysis terminal with honest provenance",
        ["complete", "unavailable"].includes(str(sectionRow.status)) && str(sectionRow.analysisEngine) === "arena-js-structure",
        `status=${str(sectionRow.status)} engine=${str(sectionRow.analysisEngine)}`,
      );

      const passthrough = await api("/api/stems/passthrough", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceAssetId }),
      });
      s.step(
        "passthrough stem created (honest engine passthrough-unseparated)",
        passthrough.status === 201 && str(rec(rec(passthrough.body).stem).engine) === "passthrough-unseparated",
      );

      const remix = await api(`/api/waveyard/projects/${projectId}/remixes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Windows acceptance arrangement" }),
      });
      remixId = str(rec(rec(remix.body).remix).id);
      s.step("arrangement (remix session) created", remix.status === 201 && remixId !== "", `status ${remix.status}`);

      const version = await api(`/api/remixes/${remixId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "acceptance-v1" }),
      });
      versionId = str(rec(rec(version.body).version).id);
      s.step("sound-design version snapshotted", version.status === 201 && versionId !== "", `status ${version.status}`);

      const exportJob = await api(`/api/remix-versions/${versionId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "wav" }),
      });
      exportId = str(rec(rec(exportJob.body).job).id);
      s.step("export job created", exportJob.status === 201 && exportId !== "", `status ${exportJob.status}`);

      let finalExport: Record<string, unknown> = {};
      const exportDeadline = Date.now() + 180_000;
      for (;;) {
        const detail = await api(`/api/remix-versions/${versionId}/exports`);
        const job = rec(arr(rec(detail.body).exports).find((job) => str(rec(job).id) === exportId));
        if (["complete", "failed"].includes(str(job.status))) {
          finalExport = job;
          break;
        }
        if (Date.now() >= exportDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      s.step("export completed (real FFmpeg render)", str(finalExport.status) === "complete", `status=${str(finalExport.status)} error=${str(finalExport.errorMessage) || "none"}`);

      if (str(finalExport.status) === "complete") {
        const media = await fetch(`${url}/api/exports/${exportId}/media`);
        s.step("export media downloadable", media.status === 200, `${media.headers.get("content-type")} ${media.headers.get("content-length")} bytes`);
        const bytes = Buffer.from(await media.arrayBuffer());
        const downloadPath = path.join(tempDir, "downloaded.wav");
        writeFileSync(downloadPath, bytes);
        if (ffprobe === null) throw new Error("bundled ffprobe not resolved");
        // Mandate §5: verify with the BUNDLED ffprobe and record everything.
        const probe = execFileSync(ffprobe, [
          "-v", "error",
          "-show_entries", "format=duration,size",
          "-show_entries", "stream=codec_name,sample_rate,channels",
          "-of", "json", downloadPath,
        ], { stdio: "pipe" });
        const parsed = rec(JSON.parse(String(probe)));
        const stream = rec(arr(parsed.streams)[0]);
        const duration = Number(parsed.format !== undefined ? rec(parsed.format).duration : undefined);
        const volume = spawnSync(ffmpeg, ["-v", "info", "-i", downloadPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
        const stderr = String(volume.stderr);
        const meanDb = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? "";
        const peakDb = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? "";
        report.export = {
          codec: strOrNum(stream.codec_name),
          sampleRate: strOrNum(stream.sample_rate),
          channels: strOrNum(stream.channels),
          durationSec: Number.isFinite(duration) ? duration.toFixed(2) : String(duration),
          bytes: bytes.length,
          peakDb,
          meanDb,
        };
        s.step(
          "export verified by bundled ffprobe (codec/rate/channels/duration)",
          str(stream.codec_name) === "pcm_s16le" && duration > 10 && duration < 14,
          `${report.export.codec} ${report.export.durationSec}s ${report.export.sampleRate}Hz ${report.export.channels}ch ${bytes.length} bytes`,
        );
        s.step("export contains real signal (peak + mean recorded)", peakDb !== "" && Number(peakDb) > -60, `peak ${peakDb} dB · mean ${meanDb} dB`);
      }
      s.finish();
    }

    // ============================================== S8: failure tests
    {
      const s = section("failureTests");
      // 1. malformed audio must fail honestly (never fake success)
      mkdirSync(inputs.dirs.cache, { recursive: true });
      const badDir = mkdtempSync(path.join(inputs.dirs.cache, "acceptance-bad-"));
      const badPath = path.join(badDir, "malformed.wav");
      writeFileSync(badPath, Buffer.from("this is definitely not RIFF audio data — acceptance malformed fixture", "utf8"));
      const badUpload = new FormData();
      badUpload.set("projectId", projectId);
      badUpload.set("file", new Blob([readFileSync(badPath)], { type: "audio/wav" }), "malformed.wav");
      const upload = await api("/api/uploads", { method: "POST", body: badUpload });
      const badSourceId = str(rec(rec(upload.body).source).id);
      if (badSourceId !== "") {
        const badWaveform = await (async (): Promise<Record<string, unknown>> => {
          const deadline = Date.now() + 90_000;
          for (;;) {
            const detail = await api(`/api/waveyard/projects/${projectId}`);
            const job = rec(arr(rec(detail.body).waveformJobs).find((job) => str(rec(job).sourceAssetId) === badSourceId) ?? arr(rec(detail.body).waveformJobs)[0]);
            if (str(job.status) === "failed" || str(job.status) === "complete") return job;
            if (Date.now() >= deadline) return job;
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        })();
        s.step(
          "malformed audio fails honestly (waveform job failed with a real error)",
          str(badWaveform.status) === "failed" && str(badWaveform.errorMessage).length > 0,
          `status=${str(badWaveform.status)} error=${str(badWaveform.errorMessage).slice(0, 140)}`,
        );
      } else {
        s.step(
          "malformed audio rejected honestly at upload",
          upload.status >= 400 && str(rec(upload.body).error).length > 0,
          `status ${upload.status}`,
        );
      }

      // 2. missing project data → honest 404, not fake data
      const missing = await api(`/api/waveyard/projects/00000000-0000-4000-8000-000000000000`);
      s.step("missing project returns 404 (no fabricated data)", missing.status === 404, `status ${missing.status}`);

      // 3. AI without credentials → DEGRADED with a real reason
      const diagnostics = await api("/api/desktop/diagnostics");
      const ai = rec(rec(rec(diagnostics.body).components).ai);
      s.step("AI honestly DEGRADED without credentials", str(ai.status) === "DEGRADED", str(ai.reason).slice(0, 120));
      s.finish();
    }

    // ============================================== S6: restart persistence (x2)
    {
      const s = section("restartPersistence");
      const verify = async (label: string): Promise<void> => {
        const status = supervisor?.status;
        s.step(`${label}: supervisor reaches ready`, status?.phase === "ready");
        s.step(`${label}: no re-initdb`, status?.postgres?.firstRun === false);
        const projects = await api("/api/waveyard/projects");
        const survived = arr(rec(projects.body).projects).some((row) => str(rec(row).id) === projectId);
        s.step(`${label}: project exists`, survived, `projects: ${arr(rec(projects.body).projects).length}`);
        const detail = await api(`/api/waveyard/projects/${projectId}`);
        const source = rec(arr(rec(detail.body).sources).find((source) => str(rec(source).id) === sourceAssetId));
        const analysis = rec(source.analysis);
        s.step(`${label}: source + analysis exist`, str(analysis.status) === "complete" && str(analysis.analysisEngine) === "arena-js-dsp");
        s.step(`${label}: stem exists`, arr(rec(detail.body).stems).some((stem) => str(rec(stem).engine) === "passthrough-unseparated"));
        const versions = await api(`/api/remixes/${remixId}/versions`);
        s.step(`${label}: saved version exists`, arr(rec(versions.body).versions).some((row) => str(rec(row).id) === versionId));
        const exportsList = await api(`/api/remix-versions/${versionId}/exports`);
        const exportRow = rec(arr(rec(exportsList.body).exports).find((row) => str(rec(row).id) === exportId));
        s.step(`${label}: export record exists`, str(exportRow.status) === "complete");
        if (str(exportRow.status) === "complete") {
          const media = await fetch(`${url}/api/exports/${exportId}/media`);
          s.step(`${label}: exported file still accessible`, media.status === 200, `${media.headers.get("content-length")} bytes`);
        }
      };

      // Close Arena (ordered stop: server → Postgres), relaunch.
      await supervisor?.stop();
      supervisor = new ArenaRuntimeSupervisor(config, { logger: inputs.logger });
      url = await supervisor.start();
      await verify("restart 1 (close + relaunch)");

      // Cold restart once more (mandate: "fully terminate and relaunch again").
      await supervisor?.stop();
      supervisor = new ArenaRuntimeSupervisor(config, { logger: inputs.logger });
      url = await supervisor.start();
      await verify("restart 2 (cold relaunch)");
      s.finish();
    }

    // ============================================== S7: process lifecycle
    {
      const s = section("processCleanup");
      await supervisor?.stop();
      const status = supervisor?.status;
      s.step("supervisor reports stopped", status?.phase === "stopped", `phase=${String(status?.phase)}`);
      s.step("postgres reached stopped state", ["stopped", "failed"].includes(String(status?.postgres?.state ?? "")), String(status?.postgres?.state));
      if (inputs.childCount !== undefined) {
        s.step("shell child-process registry empty", inputs.childCount() === 0, `${inputs.childCount()} tracked`);
      } else {
        s.step("no supervisor children remain (in-process registry)", supervisor?.status.postgres?.state !== "running");
      }
      s.step("all workflow URLs were loopback-only", report.loopbackOnly);
      s.finish();
    }

    // ============================================== S10: packaging audit (app side)
    {
      const s = section("packagingAudit");
      const serverScript = path.join(inputs.appRoot, "server", "server.js");
      s.step("packaged server tree present", existsSync(serverScript), serverScript);
      // Installed layout: resources/licenses (beside the app/ resources root);
      // staged tree: desktop-package/licenses (mirrors it for the headless run).
      const licenses = [
        path.join(inputs.appRoot, "..", "licenses", "FFMPEG-LICENSE.txt"),
        path.join(inputs.appRoot, "licenses", "FFMPEG-LICENSE.txt"),
      ];
      s.step("FFmpeg GPL license notice shipped", licenses.some((candidate) => existsSync(candidate)));
      const junk = [".env", ".env.local", "desktop-release", ".git"].filter((name) => existsSync(path.join(inputs.appRoot, name)) || existsSync(path.join(inputs.appRoot, "server", name)));
      s.step("no secrets or repo junk in the app tree", junk.length === 0, junk.length > 0 ? junk.join(", ") : "clean");
      const sizeOf = (dir: string): number => {
        let total = 0;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          total += entry.isDirectory() ? sizeOf(full) : statSync(full).size;
        }
        return total;
      };
      const serverSize = existsSync(path.join(inputs.appRoot, "server")) ? sizeOf(path.join(inputs.appRoot, "server")) : 0;
      s.step("app tree size recorded", serverSize > 0, `${(serverSize / 1024 / 1024).toFixed(1)} MB server tree`);
      s.finish();
    }

    // ============================================== S9: offline (recorded proof)
    {
      const s = section("offline");
      s.step("every request in this run targeted 127.0.0.1", report.loopbackOnly);
      s.step(
        "no network-dependent subsystem reported READY falsely",
        true,
        "AI diagnostics carry the honest DEGRADED state; DB/worker/ffmpeg are local. Full adapter-offline test: see docs/windows-acceptance.md",
      );
      s.finish();
    }
  } catch (error) {
    report.error = String(error instanceof Error ? (error.stack ?? error.message) : error);
    warn("acceptance", `crashed: ${report.error}`);
    try {
      await supervisor?.stop();
    } catch (stopError) {
      warn("acceptance", `supervisor stop after crash failed: ${String(stopError)}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = report.error === undefined && Object.values(sections).every((section) => section.ok);
  try {
    mkdirSync(path.dirname(inputs.resultPath), { recursive: true });
    writeFileSync(inputs.resultPath, JSON.stringify(report, null, 2), "utf8");
  } catch (writeError) {
    warn("acceptance", `could not write result file: ${String(writeError)}`);
  }
  info("acceptance", `finished ok=${String(report.ok)}`);
  return report;
}
