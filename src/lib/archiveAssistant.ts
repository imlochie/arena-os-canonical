// Archive Assistant — the chat agent loop.
//
// Protocol: the model replies EITHER with a fenced JSON tool call
//   {"tool": "...", "args": {...}}
// or with plain text (the final answer). The server executes tool calls
// against the registry (src/lib/assistantTools.ts), feeds results back, and
// loops until the model answers or the tool budget (4) is spent.
//
// Local Mode: with no keys / no network, generate() returns fallback text that
// can't drive the loop — so a small deterministic router takes over for the
// browse/search/stats intents. The assistant stays genuinely useful with zero
// setup, and upgrades itself to full reasoning the moment a key exists.

import { generate } from "@/lib/ai";
import { ASSISTANT_TOOLS, getTool, toolManifest, PLATFORM_MODULES, PLATFORM_DOCS, ToolCtx } from "@/lib/assistantTools";
import { preferencesBriefAll } from "@/lib/preferences";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  summary: string;
}

export interface AssistantResult {
  reply: string;
  via: string;
  steps: AssistantStep[];
}

export interface RunAssistantOpts extends ToolCtx {
  messages: AssistantMessage[];
  modelId?: string;
}

const MAX_TOOL_CALLS = 4;
const MAX_STEPS = 6;

function systemPrompt(prefs: string): string {
  return [
    "You are the Archive Assistant — the operator's agent living inside their personal workspace platform (\"arena-os\").",
    "You understand the platform by browsing it, and you act by calling tools. You manage a searchable media archive index and can drive the platform's other modules (Spaces, Congress, artifacts, projects).",
    "",
    "TOOL PROTOCOL — to call a tool, reply with ONLY a fenced JSON block:",
    '```json',
    '{"tool": "<name>", "args": { ... }}',
    "```",
    "After each call you receive a TOOL RESULT message; keep calling tools until you can answer, then reply with plain text (no JSON) as your final answer.",
    `You may make at most ${MAX_TOOL_CALLS} tool calls per turn. Prefer one good call, then answer.`,
    "",
    "RULES:",
    "- You draft and describe; you never claim to have taken outward-facing actions (posting, sending emails, buying). The human always acts.",
    "- Use tools to get real state — never guess at the user's spaces, projects or archive contents.",
    "- Answers are concise and in markdown. When listing things, use compact bullets.",
    "- If asked to do something you lack a tool for, say what you DO have (list_modules) and suggest the closest path.",
    "",
    ...(prefs
      ? [
          "",
          "OWNER PREFERENCES & BOUNDARIES (standing guidance — honor these; boundaries are hard limits, never overstep):",
          prefs,
        ]
      : []),
    "",
    "AVAILABLE TOOLS:",
    toolManifest(),
  ].join("\n");
}

function parseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  const bareStart = text.trim().search(/\{\s*"/);
  if (bareStart === 0) candidates.push(text.trim());
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj.tool === "string") {
        return { tool: obj.tool, args: (obj.args && typeof obj.args === "object" ? obj.args : {}) as Record<string, unknown> };
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

function summarize(result: unknown): string {
  const json = JSON.stringify(result);
  if (json.length <= 900) return json;
  return `${json.slice(0, 900)}… (${json.length} chars)`;
}

export async function runAssistant(opts: RunAssistantOpts): Promise<AssistantResult> {
  const modelId = opts.modelId ?? "openai";
  const steps: AssistantStep[] = [];
  const prefs = await preferencesBriefAll().catch(() => "");
  const convo: { role: "system" | "user" | "assistant"; content: string }[] = [
    ...opts.messages.slice(-14).map((m) => ({ role: m.role, content: m.content })),
  ];
  let via = "local";

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await generate({
      modelId,
      messages: convo,
      system: systemPrompt(prefs),
      temperature: 0.4,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });
    via = res.via;
    const text = res.text.trim();

    const call = parseToolCall(text);
    const isLocalEngine =
      via === "local:text" || via === "offline" || via === "local" ||
      via === "offline-fallback" || via.startsWith("turboagent:unreachable") || via.startsWith("turboagent:not-configured");

    if (!call) {
      // Final answer — or the local engine, which can't tool-call.
      if (isLocalEngine && steps.length === 0 && convo[convo.length - 1]?.role === "user") {
        const routed = await localRoute(convo[convo.length - 1].content, opts);
        if (routed) return { reply: routed.reply, via: `local-route:${routed.via}`, steps: routed.steps };
      }
      return { reply: text, via, steps };
    }

    if (steps.length >= MAX_TOOL_CALLS) {
      convo.push({ role: "user", content: "Tool budget exhausted — answer now with what you have (plain text, no JSON)." });
      continue;
    }

    const tool = getTool(call.tool);
    if (!tool) {
      convo.push({ role: "assistant", content: text });
      convo.push({ role: "user", content: `TOOL RESULT ${call.tool}: error — unknown tool. Valid tools: ${ASSISTANT_TOOLS.map((t) => t.name).join(", ")}` });
      continue;
    }

    const started = Date.now();
    let ok = true;
    let result: unknown;
    try {
      result = await tool.run(call.args, { keys: opts.keys, localOnly: opts.localOnly });
    } catch (e) {
      ok = false;
      result = { error: e instanceof Error ? e.message : "tool failed" };
    }
    steps.push({ tool: tool.name, args: call.args, ok, ms: Date.now() - started, summary: summarize(result) });
    convo.push({ role: "assistant", content: text });
    convo.push({ role: "user", content: `TOOL RESULT ${tool.name}:\n${summarize(result)}` });
  }

  return {
    reply: "I hit my step limit mid-task — here's what I did:\n" +
      steps.map((s) => `- \`${s.tool}\` ${s.ok ? "✓" : "✗"} (${s.ms}ms)`).join("\n"),
    via,
    steps,
  };
}

// ---------------- local deterministic router ----------------

interface RouteResult {
  reply: string;
  via: string;
  steps: AssistantStep[];
}

async function runLocal(toolName: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<{ step: AssistantStep; result: unknown }> {
  const tool = getTool(toolName)!;
  const started = Date.now();
  let ok = true;
  let result: unknown;
  try {
    result = await tool.run(args, ctx);
  } catch (e) {
    ok = false;
    result = { error: e instanceof Error ? e.message : "tool failed" };
  }
  return {
    step: { tool: toolName, args, ok, ms: Date.now() - started, summary: summarize(result) },
    result,
  };
}

function fmtModuleList(): string {
  return [
    "**Local mode** — no model key set, so I'm running my deterministic router. Browsing and tools still work; add a key (🛠 Openrouter/Groq/TurboAgent) for full reasoning.",
    "",
    "**Modules in this workspace:**",
    ...PLATFORM_MODULES.map((m) => `- ${m.path === "/archive" ? "🗂️" : "•"} **${m.name}** — ${m.what}`),
    "",
    "**Docs:** " + PLATFORM_DOCS.map((d) => d.file).join(", "),
    "",
    "Try: `list my spaces` · `archive stats` · `search archive for beethoven` · `scan the inbox`",
  ].join("\n");
}

export async function localRoute(msg: string, ctx: ToolCtx): Promise<RouteResult | null> {
  const m = msg.toLowerCase().trim();
  const ctxKeys: ToolCtx = { keys: ctx.keys, localOnly: ctx.localOnly };

  if (/^(help|what can you|what do you|hi|hello|hey|tools|capabilities)\b/.test(m) || m === "?") {
    return { reply: fmtModuleList(), via: "help", steps: [] };
  }
  if (/(list|show|browse).*(module|tool|platform|workspace|what's here)/.test(m)) {
    return { reply: fmtModuleList(), via: "modules", steps: [] };
  }
  if (/(list|show|my) spaces/.test(m)) {
    const { step, result } = await runLocal("list_spaces", {}, ctxKeys);
    const spaces = (result as { title: string; status: string; intervalMinutes: number; runCount: number; due: boolean }[]) ?? [];
    const reply = spaces.length
      ? `**Spaces (${spaces.length}):**\n` + spaces.map((s) => `- ${s.title} — ${s.status}, every ${s.intervalMinutes}m, ${s.runCount} runs${s.due ? " · **due now**" : ""}`).join("\n")
      : "No spaces yet. I can create one — ask with a model key set, or use /spaces directly.";
    return { reply, via: "spaces", steps: [step] };
  }
  if (/(list|show|my) projects/.test(m)) {
    const { step, result } = await runLocal("list_projects", {}, ctxKeys);
    const projects = (result as { name: string; emoji: string; description: string }[]) ?? [];
    const reply = Array.isArray(projects) && projects.length
      ? `**Projects (${projects.length}):**\n` + projects.map((p) => `- ${p.emoji} **${p.name}** — ${p.description}`).join("\n")
      : "No projects visible (or no database connected).";
    return { reply, via: "projects", steps: [step] };
  }
  if (/(congress|session)/.test(m) && /(list|show|recent)/.test(m)) {
    const { step, result } = await runLocal("list_congress_sessions", {}, ctxKeys);
    const sessions = (result as { topic: string; status: string; turns: number }[]) ?? [];
    const reply = Array.isArray(sessions) && sessions.length
      ? `**Congress sessions (${sessions.length}):**\n` + sessions.map((c) => `- ${c.topic.slice(0, 80)} — ${c.status}, ${c.turns} turns`).join("\n")
      : "No congress sessions yet.";
    return { reply, via: "congress", steps: [step] };
  }
  const rememberMatch = m.match(/^(?:remember|note|always|never)(?: that)?[:,\s]+(.+)/);
  if (rememberMatch) {
    const kind = m.startsWith("never") ? "boundary" : "preference";
    const content = rememberMatch[1].trim();
    const { step } = await runLocal("remember_preference", { content, kind }, ctxKeys);
    return {
      reply:
        `Noted — stored as a standing **${kind}**. Every AI surface in the workspace now sees it:\n\n> ${content}\n\n` +
        "I'll keep referring back to this (and you can manage these in the 🎼 Orchestrator's preferences panel).",
      via: "remember",
      steps: [step],
    };
  }
  if (/(list|show|what are|check).*(preferences|boundaries)/.test(m)) {
    const { step, result } = await runLocal("list_preferences", {}, ctxKeys);
    const r = result as { n: number; preferences: { kind: string; content: string }[] };
    const reply = r.n
      ? `**Your standing guidance (${r.n}):**\n` + r.preferences.map((p) => `- **${p.kind}** — ${p.content}`).join("\n")
      : "No stored preferences yet. Tell me \"remember that…\" and I'll keep it.";
    return { reply, via: "preferences", steps: [step] };
  }
  if (/archive stats|stats/.test(m)) {
    const { step, result } = await runLocal("archive_stats", {}, ctxKeys);
    const r = result as { total: number; inbox: number; indexed: number; duplicates: number; byKind: Record<string, number>; collections: { name: string; n: number }[] };
    const reply = [
      `**Archive:** ${r.total} items — ${r.indexed} indexed, ${r.inbox} in inbox, ${r.duplicates} duplicates.`,
      Object.entries(r.byKind).length ? `By kind: ${Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}` : "",
      r.collections.length ? `Collections: ${r.collections.map((c) => `${c.name} (${c.n})`).join(", ")}` : "",
    ].filter(Boolean).join("\n");
    return { reply, via: "stats", steps: [step] };
  }
  const searchMatch = m.match(/(?:search|find|look up)(?: the)?(?: archive)?(?: for)?\s+(.+)/);
  if (searchMatch && /archive|search|find|look/.test(m)) {
    const q = searchMatch[1].trim();
    const { step, result } = await runLocal("archive_search", { q }, ctxKeys);
    const r = result as { n: number; items: { name: string; kind: string; status: string; description: string; collection: string }[] };
    const reply = r.n
      ? `**${r.n} match${r.n === 1 ? "" : "es"} for “${q}”:**\n` +
        r.items.slice(0, 15).map((i) => `- **${i.name}** (${i.kind}${i.collection ? `, ${i.collection}` : ""}) — ${i.description || "no description yet"}`).join("\n")
      : `No archive matches for “${q}”. \`archive stats\` shows the index totals.`;
    return { reply, via: "search", steps: [step] };
  }
  if (/scan/.test(m)) {
    const { step, result } = await runLocal("archive_scan", {}, ctxKeys);
    const r = result as { scanned: number; described: number; flaggedDuplicates: number; via: string };
    const reply = r.scanned
      ? `Scanned ${r.scanned} inbox item${r.scanned === 1 ? "" : "s"} (${r.described} AI-described, ${r.flaggedDuplicates} near-dupe flag${r.flaggedDuplicates === 1 ? "" : "s"}, via ${r.via}). Descriptions landed in the index — local mode writes placeholders until a model key is set.`
      : "Inbox is empty — nothing to scan.";
    return { reply, via: "scan", steps: [step] };
  }
  return null;
}
