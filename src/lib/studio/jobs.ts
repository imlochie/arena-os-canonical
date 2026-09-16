// Studio job orchestrator — create, submit, poll, persist.
//
// Persistence is best-effort Postgres (studio_jobs table, auto-created on
// first use) with an in-memory fallback so the Studio keeps working even
// when the DB is down — same philosophy as the rest of this app.
//
// Backends: wangp (bridge) · comfyui · dashscope (BYOK) · demo (local).

import { db } from "@/db";
import { studioJobs } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import type { StudioJob, StudioBackend, StudioModality, StudioJobFile, BackendJobSnapshot } from "./types";
import { demoMedia, demoSnapshot, demoSeed } from "./demo";
import * as wangp from "./wangp";
import * as comfy from "./comfyui";
import * as hosted from "./hosted";

export interface StudioBackendOpts {
  wangpUrl?: string;
  comfyUrl?: string;
  hostedKey?: string;
  hostedRegion?: string;
}

export interface CreateJobInput {
  backend: StudioBackend;
  modality: StudioModality;
  modelType: string;
  modelName?: string;
  prompt: string;
  negativePrompt?: string;
  seed?: number | null;
  width?: number;
  height?: number;
  resolution?: string; // "WxH" (wangp-style)
  durationSeconds?: number;
  steps?: number;
  guidance?: number;
  fps?: number;
  size?: string; // "W*H" (dashscope-style)
  settings?: Record<string, unknown>; // raw passthrough (WanGP settings / advanced)
  workflowJson?: string; // comfyui: custom API-format workflow
  projectId?: string | null;
}

// Full row shape (all fields present — we always populate them ourselves).
interface JobRowLike {
  id: string;
  backend: string;
  externalId: string | null;
  modelType: string;
  modelName: string;
  modality: string;
  prompt: string;
  negativePrompt: string;
  settings: string;
  status: string;
  phase: string;
  progress: number;
  files: string;
  preview: string | null;
  error: string | null;
  seed: number | null;
  projectId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ---------------- persistence (DB with memory fallback) ----------------

let tableReady = false;
const memoryJobs = new Map<string, JobRowLike>();
let dbHealthy = true;

export async function ensureStudioTable(): Promise<void> {
  if (tableReady) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "studio_jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "backend" text NOT NULL,
        "external_id" text,
        "model_type" text NOT NULL,
        "model_name" text DEFAULT '' NOT NULL,
        "modality" text DEFAULT 'video' NOT NULL,
        "prompt" text NOT NULL,
        "negative_prompt" text DEFAULT '' NOT NULL,
        "settings" text DEFAULT '{}' NOT NULL,
        "status" text DEFAULT 'queued' NOT NULL,
        "phase" text DEFAULT '' NOT NULL,
        "progress" real DEFAULT 0 NOT NULL,
        "files" text DEFAULT '[]' NOT NULL,
        "preview" text,
        "error" text,
        "seed" integer,
        "project_id" uuid,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    tableReady = true;
    dbHealthy = true;
  } catch {
    dbHealthy = false; // fall back to memory
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function toRow(input: CreateJobInput, externalId: string | null, status: string): JobRowLike {
  const settings = {
    ...(input.settings ?? {}),
    ...(input.width && input.height ? { width: input.width, height: input.height } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.durationSeconds ? { duration_seconds: input.durationSeconds } : {}),
    ...(input.steps ? { steps: input.steps } : {}),
    ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
    ...(input.fps ? { fps: input.fps } : {}),
    ...(input.workflowJson ? { workflowJson: input.workflowJson } : {}),
  };
  const now = new Date();
  return {
    id: newId(),
    backend: input.backend,
    externalId,
    modelType: input.modelType,
    modelName: input.modelName ?? input.modelType,
    modality: input.modality,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? "",
    settings: JSON.stringify(settings),
    status,
    phase: "",
    progress: 0,
    files: "[]",
    preview: null,
    error: null,
    seed: input.seed ?? null,
    projectId: input.projectId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertJob(row: JobRowLike): Promise<void> {
  memoryJobs.set(row.id, row);
  try {
    await ensureStudioTable();
    if (!dbHealthy) return;
    await db.insert(studioJobs).values(row as typeof studioJobs.$inferInsert);
    memoryJobs.delete(row.id);
  } catch {
    dbHealthy = false; // keep memory copy
  }
}

async function loadJob(id: string): Promise<JobRowLike | null> {
  try {
    await ensureStudioTable();
    if (dbHealthy) {
      const rows = await db.select().from(studioJobs).where(eq(studioJobs.id, id)).limit(1);
      if (rows.length) return rows[0] as JobRowLike;
      return null;
    }
  } catch {
    dbHealthy = false;
  }
  return memoryJobs.get(id) ?? null;
}

async function saveJob(row: JobRowLike): Promise<void> {
  row.updatedAt = new Date();
  memoryJobs.set(row.id, row); // always keep latest in memory too
  try {
    if (!dbHealthy) return;
    await db
      .update(studioJobs)
      .set({
        externalId: row.externalId,
        status: row.status,
        phase: row.phase,
        progress: row.progress,
        files: row.files,
        preview: row.preview ?? null,
        error: row.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(studioJobs.id, row.id));
  } catch {
    dbHealthy = false;
  }
}

export async function listJobs(limit = 24): Promise<JobRowLike[]> {
  try {
    await ensureStudioTable();
    if (dbHealthy) {
      const rows = await db.select().from(studioJobs).orderBy(desc(studioJobs.createdAt)).limit(limit);
      return rows as JobRowLike[];
    }
  } catch {
    dbHealthy = false;
  }
  return [...memoryJobs.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

// ---------------- public shape ----------------

export function publicJobs(rows: JobRowLike[]): StudioJob[] {
  return rows.map(publicJob);
}

interface StoredFile {
  name: string;
  mediaType: string;
  kind: StudioModality;
  size?: number;
  backendUrl?: string;
  subfolder?: string;
}

function publicJob(row: JobRowLike): StudioJob {
  const files: StudioJobFile[] = (JSON.parse(row.files || "[]") as StoredFile[]).map((f) => ({
    name: f.name,
    url: `/api/studio/jobs/${row.id}/media?f=${encodeURIComponent(f.name)}`,
    mediaType: f.mediaType,
    kind: f.kind,
    size: f.size,
  }));  return {
    id: row.id,
    backend: row.backend as StudioBackend,
    externalId: row.externalId,
    modelType: row.modelType,
    modelName: row.modelName,
    modality: row.modality as StudioModality,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    settings: JSON.parse(row.settings || "{}"),
    status: row.status as StudioJob["status"],
    phase: row.phase,
    progress: row.progress,
    files,
    preview: row.preview ?? null,
    error: row.error ?? null,
    seed: row.seed ?? null,
    projectId: row.projectId ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

// ---------------- submit ----------------

export async function submitStudioJob(input: CreateJobInput, opts: StudioBackendOpts): Promise<StudioJob> {
  if (!input.prompt?.trim()) throw new Error("prompt is required");
  const prompt = input.prompt.trim();

  if (input.backend === "demo") {
    const row = toRow({ ...input, prompt }, null, "running");
    row.phase = "loading model";
    row.seed = demoSeed(prompt, input.seed ?? null);
    await insertJob(row);
    return publicJob(row);
  }

  if (input.backend === "wangp") {
    const settings = buildWangpSettings(input);
    const jobId = await wangp.wangpSubmit(settings, opts.wangpUrl);
    const row = toRow({ ...input, prompt }, jobId, "queued");
    row.phase = "submitted to WanGP";
    await insertJob(row);
    return publicJob(row);
  }

  if (input.backend === "comfyui") {
    const workflow = resolveComfyWorkflow(input);
    const promptId = await comfy.comfySubmit(workflow, opts.comfyUrl);
    const row = toRow({ ...input, prompt }, promptId, "queued");
    row.phase = "submitted to ComfyUI";
    await insertJob(row);
    return publicJob(row);
  }

  if (input.backend === "dashscope") {
    if (!opts.hostedKey) throw new Error("A DashScope API key is required for the hosted backend (Settings → Cloud key)");
    const cfg: hosted.HostedConfig = { apiKey: opts.hostedKey, region: (opts.hostedRegion as "intl" | "cn") || "intl" };
    if (input.modality === "image") {
      const { url } = await hosted.hostedSubmitImage(cfg, {
        prompt,
        negativePrompt: input.negativePrompt,
        size: input.size || (input.width && input.height ? `${input.width}*${input.height}` : undefined),
        model: input.modelType,
      });
      const row = toRow({ ...input, prompt }, `img_${Date.now().toString(36)}`, "completed");
      row.phase = "done";
      row.progress = 1;
      row.files = JSON.stringify([
        { name: "image.png", mediaType: "image/png", kind: "image" as StudioModality, backendUrl: url },
      ]);
      await insertJob(row);
      return publicJob(row);
    }
    const taskId = await hosted.hostedSubmitVideo(cfg, {
      prompt,
      negativePrompt: input.negativePrompt,
      size: input.size || (input.width && input.height ? `${input.width}*${input.height}` : undefined),
      duration: input.durationSeconds,
      model: input.modelType,
    });
    const row = toRow({ ...input, prompt }, taskId, "queued");
    row.phase = "queued (hosted)";
    await insertJob(row);
    return publicJob(row);
  }

  throw new Error(`unknown backend: ${input.backend}`);
}

function buildWangpSettings(input: CreateJobInput): Record<string, unknown> {
  const s: Record<string, unknown> = {
    ...(input.settings ?? {}),
    model_type: input.modelType,
    prompt: input.prompt.trim(),
  };
  if (input.negativePrompt?.trim()) s.negative_prompt = input.negativePrompt.trim();
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) s.seed = Math.floor(input.seed);
  if (input.resolution) s.resolution = input.resolution;
  else if (input.width && input.height) s.resolution = `${input.width}x${input.height}`;
  if (input.steps) s.num_inference_steps = input.steps;
  if (input.durationSeconds) s.video_length = `${input.durationSeconds}s`;
  if (input.fps) s.force_fps = input.fps;
  // raw passthrough wins (power users can paste WanGP-exported settings)
  return { ...s, ...(input.settings ?? {}) };
}

function resolveComfyWorkflow(input: CreateJobInput): Record<string, unknown> {
  const raw = input.workflowJson?.trim();
  let workflow: Record<string, unknown>;
  if (raw) {
    workflow = comfy.parseWorkflowJson(raw);
  } else {
    // modelType is "comfy:<templateId>"
    const template = comfy.findComfyTemplate(input.modelType.replace(/^comfy:/, ""));
    if (!template) throw new Error("Provide a workflow (paste API-format JSON) or pick a built-in template");
    workflow = template.workflow;
  }
  const seed =
    typeof input.seed === "number" && Number.isFinite(input.seed)
      ? Math.floor(input.seed)
      : Math.floor(Math.random() * 2147483647);
  const vars: comfy.TemplateVars = {
    PROMPT: input.prompt.trim(),
    NEGATIVE: (input.negativePrompt ?? "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走").trim() || "low quality, blurry",
    SEED: seed,
    WIDTH: input.width ?? 832,
    HEIGHT: input.height ?? 480,
    LENGTH: input.settings && typeof input.settings.length === "number" ? input.settings.length : 81,
    STEPS: input.steps ?? 20,
    CFG: input.guidance ?? 3.5,
    FPS: input.fps ?? 16,
  };
  return comfy.applyTemplateVars(workflow, vars);
}

// ---------------- refresh (poll backend) ----------------

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function refreshStudioJob(id: string, opts: StudioBackendOpts): Promise<StudioJob | null> {
  const row = await loadJob(id);
  if (!row) return null;
  if (TERMINAL.has(row.status)) return publicJob(row);

  let snap: BackendJobSnapshot | null = null;
  try {
    if (row.backend === "demo") {
      snap = demoSnapshot(demoShape(row), new Date(row.createdAt).getTime());
    } else if (row.backend === "wangp" && row.externalId) {
      snap = await wangp.wangpJob(row.externalId, opts.wangpUrl);
    } else if (row.backend === "comfyui" && row.externalId) {
      snap = await comfy.comfyJob(row.externalId, opts.comfyUrl);
    } else if (row.backend === "dashscope" && row.externalId) {
      if (!opts.hostedKey) return publicJob(row); // can't poll without the BYOK key
      const cfg: hosted.HostedConfig = { apiKey: opts.hostedKey, region: (opts.hostedRegion as "intl" | "cn") || "intl" };
      snap = await hosted.hostedTask(cfg, row.externalId);
    }
  } catch (e) {
    // transient poll failure → keep last known state, surface as phase hint
    row.phase = row.phase || "waiting for backend";
    await saveJob(row);
    return publicJob(row);
  }

  if (snap) {
    row.status = snap.status;
    row.phase = snap.phase;
    row.progress = snap.progress;
    row.error = snap.error ?? null;
    if (snap.preview) row.preview = snap.preview;
    if (snap.files.length) {
      const stored: StoredFile[] = snap.files.map((f) => ({
        name: f.name,
        mediaType: f.mediaType,
        kind: f.kind,
        size: f.size,
        backendUrl: f.url,
        subfolder: (f as { subfolder?: string }).subfolder,
      }));
      row.files = JSON.stringify(stored);
    }
    await saveJob(row);
  }
  return publicJob(row);
}

function demoShape(row: JobRowLike): Parameters<typeof demoSnapshot>[0] {
  return {
    prompt: row.prompt,
    modelType: row.modelType,
    modelName: row.modelName,
    modality: row.modality as StudioModality,
    settings: JSON.parse(row.settings || "{}"),
    seed: row.seed ?? null,
  };
}

// ---------------- cancel ----------------

export async function cancelStudioJob(id: string, opts: StudioBackendOpts): Promise<StudioJob | null> {
  const row = await loadJob(id);
  if (!row) return null;
  if (TERMINAL.has(row.status)) return publicJob(row);
  try {
    if (row.backend === "wangp" && row.externalId) await wangp.wangpCancel(row.externalId, opts.wangpUrl);
    else if (row.backend === "comfyui" && row.externalId) await comfy.comfyCancel(row.externalId, opts.comfyUrl);
    // dashscope has no task cancel in this client; demo cancels locally
  } catch {
    /* best-effort */
  }
  row.status = "cancelled";
  row.phase = "cancelled";
  await saveJob(row);
  return publicJob(row);
}

// ---------------- media serving ----------------

export async function studioJobMedia(
  id: string,
  fileName: string,
  range: string | null,
  opts: StudioBackendOpts
): Promise<Response | null> {
  const row = await loadJob(id);
  if (!row) return null;
  const files = JSON.parse(row.files || "[]") as StoredFile[];
  const file = files.find((f) => f.name === fileName);
  if (!file) return null;

  if (row.backend === "demo") {
    const media = demoMedia(demoShape(row), fileName);
    const body = typeof media.body === "string" ? Buffer.from(media.body, "utf-8") : media.body;
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": media.mediaType,
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "none",
      },
    });
  }

  if (row.backend === "wangp" && row.externalId) {
    return wangp.wangpFile(row.externalId, fileName, range, opts.wangpUrl);
  }
  if (row.backend === "comfyui" && row.externalId) {
    return comfy.comfyFile(file.name, file.subfolder, range, opts.comfyUrl);
  }
  if (row.backend === "dashscope" && file.backendUrl) {
    return fetch(file.backendUrl, range ? { headers: { Range: range } } : undefined);
  }
  return null;
}

// re-export for the media route / routes needing catalog fallbacks
export { demoMedia, demoSeed };
