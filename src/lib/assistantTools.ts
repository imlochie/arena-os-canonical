// Archive Assistant — the tool registry (the "plugin" layer).
//
// The assistant understands the platform by calling these tools. Each tool is
// a small, typed capability over an existing module — browse the workspace,
// drive Spaces, convene Congress, save artifacts, and manage the archive
// index. Adding a capability to the assistant means appending one entry to
// ASSISTANT_TOOLS: name, description, parameter spec, and a run() that calls
// existing library functions directly (no HTTP hop).
//
// House rules inherited by every tool:
// - tools describe and draft; they never take outward-facing actions
//   (posting, sending, buying) on the human's behalf;
// - destructive operations are limited to soft, reversible state changes.

import { db } from "@/db";
import { artifacts, projects } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import { createCongress, listCongresses } from "@/lib/congress";
import { createSpace, listSpaces, runSpace, updateSpace } from "@/lib/spaces";
import { getSpaceTemplate } from "@/lib/spaceTemplates";
import {
  addArchiveItems, archiveStats, getArchiveItem, listArchiveItems, scanInbox, updateArchiveItem,
} from "@/lib/archive";

export interface ToolCtx {
  keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string };
  localOnly?: boolean;
}

export interface AssistantTool {
  name: string;
  description: string;
  parameters: Record<string, { type: "string" | "number" | "boolean" | "array"; description: string; required?: boolean }>;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}

// ---------------- module manifest (understand + browse) ----------------

export const PLATFORM_MODULES: { name: string; path: string; what: string }[] = [
  { name: "Command", path: "/command", what: "Operator console / dashboard for the whole platform." },
  { name: "Arena", path: "/", what: "Model-vs-model battles with ELO ratings and a leaderboard." },
  { name: "Council", path: "/council", what: "Multi-model council runs producing artifacts." },
  { name: "Congress", path: "/congress", what: "Timed multi-seat deliberation → Act artifact; sittings can adjourn/resume/reconvene." },
  { name: "Spaces", path: "/spaces", what: "Multi-window workbench of recurring agent tasks with persistent briefcases (12 money/audience/ops templates)." },
  { name: "Archive Assistant", path: "/archive", what: "This: chat agent with tools over the platform + the searchable media archive index." },
  { name: "Collab", path: "/collab", what: "Multi-model collaborative documents." },
  { name: "Projects", path: "/projects", what: "Project spaces with memory and artifacts." },
  { name: "Artifacts", path: "/artifacts", what: "Cross-module artifact library (briefs, decisions, research…)." },
  { name: "Arcade", path: "/arcade", what: "Model-vs-model games." },
  { name: "Chat", path: "/chat", what: "BYOK multi-provider chat." },
  { name: "Image", path: "/image", what: "Image generation." },
  { name: "Studio", path: "/studio", what: "WanGP-backed video generation jobs." },
  { name: "Cut", path: "/cut", what: "Cut Lab: browser video editing projects." },
  { name: "Assistants", path: "/assistants", what: "Assistant definitions." },
  { name: "Guide", path: "/guide", what: "Platform guide." },
];

export const PLATFORM_DOCS: { file: string; what: string }[] = [
  { file: "ARCHIVE.md", what: "Archive Assistant + archive index guide" },
  { file: "SPACES.md", what: "Spaces (recurring agent workbench) guide" },
  { file: "CONGRESS.md", what: "Congress (timed deliberation) guide" },
  { file: "CUT.md", what: "Cut Lab guide" },
  { file: "STUDIO.md", what: "Studio guide" },
  { file: "REFERENCES.md", what: "91-link OSS reference map" },
  { file: "AGENTS.md", what: "Repo map for coding agents" },
];

// ---------------- helpers ----------------

function str(v: unknown, max = 4000): string {
  return String(v ?? "").slice(0, max);
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function listProjectsSafe(): Promise<unknown> {
  try {
    const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(25);
    return rows.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, description: p.description }));
  } catch {
    return { note: "projects unavailable (no database)" };
  }
}

async function listArtifactsSafe(opts: { q?: string; limit?: number }): Promise<unknown> {
  try {
    const rows = await db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).limit(200);
    const q = (opts.q ?? "").toLowerCase().trim();
    const filtered = q ? rows.filter((r) => `${r.title} ${r.body}`.toLowerCase().includes(q)) : rows;
    return filtered.slice(0, Math.min(opts.limit ?? 10, 25)).map((a) => ({
      id: a.id, kind: a.kind, title: a.title, createdAt: a.createdAt,
    }));
  } catch {
    return { note: "artifacts unavailable (no database)" };
  }
}

async function saveArtifactSafe(args: Record<string, unknown>): Promise<unknown> {
  try {
    const [row] = await db
      .insert(artifacts)
      .values({
        title: str(args.title, 160) || "Archive Assistant note",
        body: str(args.body, 30000),
        kind: str(args.kind, 40) || "research",
        sourceType: "assistant",
        projectId: typeof args.projectId === "string" && args.projectId ? args.projectId : null,
      })
      .returning();
    return { ok: true, id: row?.id };
  } catch {
    return { ok: false, note: "artifact library unavailable (no database)" };
  }
}

// ---------------- the registry ----------------

export const ASSISTANT_TOOLS: AssistantTool[] = [
  // -- understand & browse --
  {
    name: "list_modules",
    description: "List every module in this platform with a one-line description of what it does, plus the guide docs. Use this to answer 'what can you do here' / 'what tools do I have'.",
    parameters: {},
    run: async () => ({ modules: PLATFORM_MODULES, docs: PLATFORM_DOCS }),
  },
  {
    name: "list_projects",
    description: "List the user's projects (name, emoji, description).",
    parameters: {},
    run: async () => listProjectsSafe(),
  },
  {
    name: "list_artifacts",
    description: "Browse the artifact library (optionally filtered by a search query). Returns recent artifacts with kind + title.",
    parameters: { q: { type: "string", description: "optional search text" }, limit: { type: "number", description: "max results (default 10)" } },
    run: async (args) => listArtifactsSafe({ q: typeof args.q === "string" ? args.q : undefined, limit: args.limit != null ? num(args.limit, 10) : undefined }),
  },
  {
    name: "list_spaces",
    description: "List all Spaces (recurring agent tasks) with status, cadence, run counts and whether each is due now.",
    parameters: {},
    run: async () => {
      const spaces = await listSpaces();
      return spaces.map((s) => ({
        id: s.id, title: `${s.emoji} ${s.title}`, status: s.status, intervalMinutes: s.intervalMinutes,
        runCount: s.runCount, due: s.due,
      }));
    },
  },
  {
    name: "list_congress_sessions",
    description: "List recent Congress sessions (timed multi-seat deliberations) with topic, status and turn counts.",
    parameters: {},
    run: async () => {
      const sessions = await listCongresses(10);
      return sessions.map((c) => ({
        id: c.id, topic: c.topic, status: c.status, turns: c.turns.length, sitting: c.sitting,
      }));
    },
  },

  // -- drive Spaces --
  {
    name: "create_space",
    description: "Create a new Space (recurring agent task) from a template id (youtube-copilot, content-repurposer, lead-sweeper, quote-drafter, review-responder, listing-writer, inbox-triage, doc-extractor, csv-cleaner, stock-reconciler, watchlist-digest, content-drip, research-digest, blank) or from a custom prompt.",
    parameters: {
      templateId: { type: "string", description: "template to use (optional if prompt given)" },
      title: { type: "string", description: "space title (optional)" },
      prompt: { type: "string", description: "custom recurring-task prompt (optional if templateId given)" },
      intervalMinutes: { type: "number", description: "cadence in minutes, 5–1440 (optional)" },
      briefcase: { type: "string", description: "initial carry-forward notes (optional)" },
    },
    run: async (args) => {
      const templateId = str(args.templateId, 60);
      const tpl = templateId ? getSpaceTemplate(templateId) : undefined;
      const prompt = str(args.prompt, 8000) || tpl?.prompt || "";
      if (!prompt) return { ok: false, error: "need a templateId or a prompt" };
      const space = await createSpace({
        title: str(args.title, 120) || tpl?.name || "Custom space",
        emoji: tpl?.emoji ?? "🤖",
        prompt,
        intervalMinutes: args.intervalMinutes != null ? num(args.intervalMinutes, 60) : tpl?.intervalMinutes ?? 60,
        briefcase: str(args.briefcase, 8000) || tpl?.briefcaseSeed || "",
      });
      return { ok: true, id: space.id, title: space.title, intervalMinutes: space.intervalMinutes };
    },
  },
  {
    name: "run_space",
    description: "Force-run one Space now (regardless of schedule) and return its latest output and briefcase. This is how you execute a recurring task on demand.",
    parameters: { id: { type: "string", description: "space id", required: true } },
    run: async (args, ctx) => {
      const id = str(args.id, 60);
      const space = await runSpace(id, { keys: ctx.localOnly ? undefined : ctx.keys, localOnly: ctx.localOnly });
      if (!space) return { ok: false, error: "space not found" };
      return {
        ok: true, title: space.title, runCount: space.runCount,
        lastOutput: (space.lastOutput ?? "").slice(0, 4000),
        briefcase: space.briefcase.slice(0, 2000),
      };
    },
  },
  {
    name: "set_space_status",
    description: "Pause or resume a Space.",
    parameters: { id: { type: "string", description: "space id", required: true }, status: { type: "string", description: "\"running\" or \"paused\"", required: true } },
    run: async (args) => {
      const status = str(args.status, 20) === "paused" ? "paused" : "running";
      const space = await updateSpace(str(args.id, 60), { status });
      return space ? { ok: true, status: space.status } : { ok: false, error: "space not found" };
    },
  },

  // -- convene Congress --
  {
    name: "convene_congress",
    description: "Convene a new Congress session: a timed multi-seat deliberation on a topic that produces an Act (resolutions, decisions, open questions). Seats default to 3 diverse roles. The human advances it from /congress.",
    parameters: {
      topic: { type: "string", description: "the question or topic to deliberate", required: true },
      seats: { type: "number", description: "number of seats, 2–8 (default 3)" },
      durationMinutes: { type: "number", description: "sitting length in minutes (default 15)" },
    },
    run: async (args) => {
      const nSeats = Math.min(Math.max(Math.floor(num(args.seats, 3)), 2), 8);
      const roles = ["pragmatist", "visionary", "skeptic", "analyst", "synthesist", "advocate", "historian", "engineer"];
      const seats = Array.from({ length: nSeats }, (_, i) => ({ role: roles[i % roles.length], modelId: "openai" }));
      const congress = await createCongress({
        topic: str(args.topic, 4000),
        seats,
        durationMinutes: args.durationMinutes != null ? num(args.durationMinutes, 15) : undefined,
      });
      return { ok: true, id: congress.id, topic: congress.topic, seats: congress.seats.length, url: `/congress` };
    },
  },

  // -- archive --
  {
    name: "archive_add",
    description: "Register files in the archive index (they are referenced, never moved). Each file: name (required), kind (video|image|audio|doc|data|other, auto-guessed from extension), sizeBytes, path, contentHash, collection.",
    parameters: {
      files: { type: "array", description: "list of {name, kind?, sizeBytes?, path?, contentHash?, collection?}", required: true },
    },
    run: async (args) => {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) return { ok: false, error: "files[] required" };
      const { added, duplicates } = await addArchiveItems(files as Record<string, unknown>[] as never[]);
      return {
        ok: true, added: added.length, duplicates: duplicates.length,
        items: added.slice(0, 25).map((i) => ({ id: i.id, name: i.name, kind: i.kind, status: i.status })),
        duplicateNames: duplicates.slice(0, 10).map((d) => d.name),
      };
    },
  },
  {
    name: "archive_scan",
    description: "Scan inbox items: AI writes descriptions, tags, collections; flags near-duplicates. Run after archive_add. Up to `limit` items per scan (default 8).",
    parameters: { limit: { type: "number", description: "max items to scan (1–20, default 8)" } },
    run: async (args, ctx) => {
      const res = await scanInbox({
        keys: ctx.localOnly ? undefined : ctx.keys,
        localOnly: ctx.localOnly,
        limit: args.limit != null ? num(args.limit, 8) : undefined,
      });
      return {
        ok: true, scanned: res.scanned, described: res.described, flaggedDuplicates: res.flaggedDuplicates, via: res.via,
        items: res.items.slice(0, 25).map((i) => ({ id: i.id, name: i.name, description: i.description.slice(0, 200), tags: i.tags, collection: i.collection })),
      };
    },
  },
  {
    name: "archive_search",
    description: "Search the archive index across names, descriptions, tags and collections. Optionally filter by kind or status.",
    parameters: {
      q: { type: "string", description: "search terms (all must match)", required: true },
      kind: { type: "string", description: "video|image|audio|doc|data|other (optional)" },
      status: { type: "string", description: "inbox|indexed|duplicate (optional)" },
      limit: { type: "number", description: "max results (default 20)" },
    },
    run: async (args) => {
      const items = await listArchiveItems({
        q: str(args.q, 200),
        kind: typeof args.kind === "string" ? args.kind : undefined,
        status: typeof args.status === "string" ? args.status : undefined,
        limit: args.limit != null ? num(args.limit, 20) : 20,
      });
      return {
        n: items.length,
        items: items.map((i) => ({
          id: i.id, name: i.name, kind: i.kind, status: i.status, collection: i.collection,
          description: i.description.slice(0, 200), tags: i.tags,
        })),
      };
    },
  },
  {
    name: "archive_item",
    description: "Get one archive item's full record by id.",
    parameters: { id: { type: "string", description: "item id", required: true } },
    run: async (args) => {
      const item = await getArchiveItem(str(args.id, 60));
      return item ?? { ok: false, error: "not found" };
    },
  },
  {
    name: "archive_update",
    description: "Edit an archive item's description, tags, collection, status or kind.",
    parameters: {
      id: { type: "string", description: "item id", required: true },
      description: { type: "string", description: "new description" },
      tags: { type: "array", description: "new tag list" },
      collection: { type: "string", description: "collection name" },
      status: { type: "string", description: "inbox|indexed|duplicate" },
    },
    run: async (args) => {
      const item = await updateArchiveItem(str(args.id, 60), {
        description: typeof args.description === "string" ? args.description : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        collection: typeof args.collection === "string" ? args.collection : undefined,
        status: typeof args.status === "string" ? args.status : undefined,
      });
      return item ?? { ok: false, error: "not found" };
    },
  },
  {
    name: "archive_stats",
    description: "Archive index totals: items by status and kind, collections.",
    parameters: {},
    run: async () => archiveStats(),
  },

  // -- write back --
  {
    name: "save_artifact",
    description: "Save a note/result into the cross-module artifact library so it shows up in /artifacts.",
    parameters: {
      title: { type: "string", description: "artifact title", required: true },
      body: { type: "string", description: "artifact body (markdown)", required: true },
      kind: { type: "string", description: "e.g. research|decision|answer|plan" },
    },
    run: async (args) =>
      saveArtifactSafe({
        title: args.title, body: args.body,
        kind: typeof args.kind === "string" ? args.kind : undefined,
      }),
  },
];

export function getTool(name: string): AssistantTool | undefined {
  return ASSISTANT_TOOLS.find((t) => t.name === name);
}

// Compact manifest for the system prompt.
export function toolManifest(): string {
  return ASSISTANT_TOOLS.map((t) => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `${k}${v.required ? "*" : ""}:${v.type}`)
      .join(", ");
    return `- ${t.name}(${params}): ${t.description}`;
  }).join("\n");
}
