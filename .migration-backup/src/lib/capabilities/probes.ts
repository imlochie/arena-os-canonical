/**
 * Real probes behind the capability report. Server-only: each one exercises
 * the dependency (query, `--version`, loopback HTTP) instead of trusting config.
 */

import { execFile } from "node:child_process";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { resolveExecutable } from "@/lib/capabilities/resolver";
import type { CapabilityProbes, ProbeResult } from "@/lib/capabilities/report";
import { listProviders } from "@/lib/waveyard/ai/providers";
import { resolveToolPath, toolVersion } from "@/lib/waveyard/ffmpeg";
import { deepEngineStatusForThisRuntime } from "@/lib/waveyard/separation/deep";
import { queueConfigured } from "@/lib/waveyard/queue";
import { localWorkerActive, localWorkerStats } from "@/lib/waveyard/worker-local";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function run(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, windowsHide: true }, (error, stdout, stderr) =>
      resolve(error ? null : `${stdout}${stderr}`.trim()),
    );
  });
}

async function mediaTool(tool: "ffmpeg" | "ffprobe"): Promise<ProbeResult> {
  const resolved = await resolveToolPath(tool);
  if (resolved === null) {
    return {
      ok: false,
      reason: `${tool} not found (no override, not bundled, no installer package, not on PATH).`,
      remediation: `Reinstall Arena (the installer bundles ${tool}) or set ARENA_${tool.toUpperCase()}_PATH.`,
    };
  }
  const version = await toolVersion(resolved.path);
  if (version === null) return { ok: false, path: resolved.path, source: resolved.source, reason: `${tool} found but failed to run -version.`, remediation: "Reinstall Arena." };
  const system = resolved.source === "system";
  return {
    ok: true,
    degraded: system,
    path: resolved.path,
    version,
    source: resolved.source,
    reason: system ? `${tool} is the system copy, not the one bundled with Arena.` : `${tool} executed -version.`,
    remediation: system ? "Reinstall Arena so the bundled copy is used." : undefined,
  };
}

async function probeLocalAi(): Promise<ProbeResult> {
  const targets = [
    { name: "Ollama", url: "http://127.0.0.1:11434/api/version" },
    { name: "LM Studio", url: "http://127.0.0.1:1234/v1/models" },
  ];
  for (const target of targets) {
    try {
      const res = await fetch(target.url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
      if (res.ok) return { ok: true, source: target.name, path: target.url, reason: `${target.name} answered on loopback.` };
    } catch {
      /* try next */
    }
  }
  return {
    ok: false,
    reason: "No local AI runtime answered on 127.0.0.1 (Ollama :11434, LM Studio :1234). Optional.",
    remediation: "Optional: install Ollama or LM Studio and start it. Arena works without one.",
  };
}

export function realCapabilityProbes(): CapabilityProbes {
  return {
    database: async () => {
      try {
        await db.execute(sql`select 1`);
        return { ok: true, source: process.env.ARENA_DESKTOP_MODE === "1" ? "embedded" : "external", reason: "PostgreSQL answered select 1." };
      } catch (error) {
        return { ok: false, reason: `Database query failed: ${message(error)}`, remediation: "Restart Arena; see logs\\arena-desktop.log for PostgreSQL output." };
      }
    },
    migrations: async () => {
      try {
        const rows = (await db.execute(sql`select count(*)::int as n from arena_schema_migrations`)) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>;
        const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
        const n = Number(list[0]?.n ?? 0);
        return n > 0 ? { ok: true, version: `${n} applied`, reason: `${n} migrations recorded.` } : { ok: false, reason: "No migrations recorded.", remediation: "Restart Arena to run migrations." };
      } catch (error) {
        return process.env.ARENA_DESKTOP_MODE === "1"
          ? { ok: false, reason: `Migration table unreadable: ${message(error)}`, remediation: "Restart Arena to run migrations." }
          : { ok: true, degraded: true, reason: "Not the desktop runtime; migrations are applied by drizzle-kit / the migration job.", remediation: "Run npm run db:migrate." };
      }
    },
    broker: async () => {
      if (localWorkerActive()) {
        const stats = localWorkerStats();
        if (stats === null) return { ok: true, degraded: true, reason: "Local executor active but no handlers registered.", remediation: "Restart Arena." };
        return { ok: true, degraded: stats.failed > 0, source: "local-db-queue", reason: `Local database-backed executor running ${stats.queues.length} queues (no Redis needed).` };
      }
      if (queueConfigured()) return { ok: true, degraded: true, source: "redis", reason: "REDIS_URL is set; connectivity is not probed here." };
      return { ok: false, reason: "No job executor (not desktop mode, REDIS_URL unset).", remediation: "Run the desktop app or set REDIS_URL." };
    },
    ffmpeg: () => mediaTool("ffmpeg"),
    ffprobe: () => mediaTool("ffprobe"),
    python: async () => {
      const deep = deepEngineStatusForThisRuntime();
      const python = deep.python ?? resolveExecutable("python3")?.path ?? resolveExecutable("python")?.path ?? resolveExecutable("py")?.path ?? null;
      if (python === null) return { ok: false, reason: "No Python interpreter found. Optional (only the deep stem pass needs it).", remediation: "Optional: install Python 3 and set WAVEYARD_DEEP_PYTHON." };
      const version = await run(python, ["--version"]);
      return { ok: version !== null, degraded: true, path: python, version, source: "system", reason: "Python is not bundled with Arena; using a system interpreter.", remediation: "Optional: a bundled Python is planned." };
    },
    demucs: async () => {
      const deep = deepEngineStatusForThisRuntime();
      return deep.prepared
        ? { ok: true, path: deep.checkpointPath, version: deep.demucsVersion, source: deep.pythonSource, reason: `Demucs ${deep.demucsVersion} and ${deep.modelName} checkpoint present.` }
        : { ok: false, version: deep.demucsVersion, reason: deep.reason, remediation: "Optional: install demucs into the Python above and place the checkpoint in the models folder." };
    },
    "yt-dlp": async () => {
      const found = resolveExecutable("yt-dlp", { envVar: "ARENA_YTDLP_PATH" });
      if (found === null) return { ok: false, reason: "yt-dlp not found. Optional (URL ingest only).", remediation: "Optional: set ARENA_YTDLP_PATH, or install yt-dlp." };
      const version = await run(found.path, ["--version"]);
      if (version === null) return { ok: false, path: found.path, source: found.source, reason: "yt-dlp found but failed to run.", remediation: "Reinstall yt-dlp." };
      return { ok: true, degraded: found.source === "system", path: found.path, version: version.split("\n")[0], source: found.source, reason: found.label };
    },
    "local-ai-runtime": probeLocalAi,
    "network-providers": async () => {
      const available = listProviders().filter((provider) => provider.state === "available");
      return available.length > 0
        ? { ok: true, reason: `${available.length} cloud AI provider key(s) configured.` }
        : { ok: false, reason: "No cloud AI provider keys set. Optional.", remediation: "Optional: add an OpenAI/Anthropic key in settings." };
    },
  };
}
