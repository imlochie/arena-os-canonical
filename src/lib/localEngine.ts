// Local-first offline engine: every feature works with ZERO internet.
// No fetch, no external calls, no data egress. Deterministic + seeded so
// parallel minds still feel distinct. This powers Local Mode and is the
// final fallback for cloud mode.

import { getModel } from "./models";
import type { ChatMsg } from "./ai";

// ---------- utilities ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function keyTerms(text: string, n = 8): string[] {
  const stop = new Set(
    "the,a,an,and,or,but,for,with,from,that,this,these,those,into,onto,what,when,where,which,who,whom,how,why,can,could,should,would,will,just,like,than,then,there,their,them,they,you,your,our,are,was,were,been,have,has,had,do,does,did,not,no,yes,please,help,give,make,get,got,thing,things,some,more,most,very,much,many,such,also,only,even,still,already,here,there,its,it's,i'm,i've,don't,doesn't,can't,want,need,using,use,used,about,over,under,between,through,during,before,after,again,once,tell,know,think,feel,find,work,works,working,way,ways,best,good,better,great,well,really,actually,maybe,perhaps,kind,sort,take,taken,come,comes,going,goes,let's,let".split(
      ","
    )
  );
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stop.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function lastUser(messages: ChatMsg[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "Hello";
}

function looksLikeCode(prompt: string): boolean {
  return /code|function|bug|error|python|javascript|typescript|sql|api|debug|component|regex|algorithm|compile|deploy/i.test(prompt);
}

function looksLikeSystem(prompt: string): boolean {
  return /system|workflow|template|process|checklist|notion|automat|publish|archive|track|organize|plan/i.test(prompt);
}

// ---------- per-model offline voices ----------

const VOICES: Record<string, { opener: string; style: string }> = {
  openai: { opener: "Here's a clear, structured take", style: "balanced" },
  mistral: { opener: "Short version first", style: "concise" },
  deepseek: { opener: "Let's reason through this step by step", style: "analytical" },
  claude: { opener: "A careful read of what you're asking", style: "nuanced" },
  gemini: { opener: "The wide-angle view", style: "expansive" },
  llama: { opener: "Got you — let's work through it together", style: "friendly" },
  qwen: { opener: "Practical build-first answer", style: "builder" },
  grok: { opener: "Bold take, no fluff", style: "witty" },
  kimi: { opener: "Thinking it through slowly", style: "deliberative" },
  "offline-sage": { opener: "Structured offline guidance", style: "guide" },
};

export function localTextReply(
  modelId: string,
  messages: ChatMsg[],
  system?: string,
  category = "general"
): string {
  const prompt = lastUser(messages);
  let model = { emoji: "🤖", name: "Local Mind" };
  try {
    const m = getModel(modelId);
    model = { emoji: m.emoji, name: m.name };
  } catch {}
  const voice = VOICES[modelId] ?? VOICES["offline-sage"];
  const terms = keyTerms(prompt);
  const focus = terms.slice(0, 5).join(", ") || "your goal";
  const short = prompt.length > 240 ? prompt.slice(0, 240) + "…" : prompt;
  const rnd = mulberry32(hashStr(modelId + prompt.slice(0, 120)));

  const anglePick = [
    "constraints first, then options",
    "options first, then a recommendation",
    "the simplest version that could work",
    "what to do in the next 30 minutes",
  ];
  const angle = anglePick[Math.floor(rnd() * anglePick.length)];

  const lines: string[] = [];
  lines.push(`**${model.emoji} ${model.name}** · *local mode — no internet used*`);
  lines.push(``);
  lines.push(`> ${voice.opener}, focused on: **${focus}**. Angle: _${angle}_.`);
  lines.push(``);
  lines.push(`## TL;DR`);
  lines.push(
    `Your challenge (“${short}”) breaks into three moves: **clarify the outcome** → **pick the smallest testable step** → **build the repeatable version**. Details below.`
  );
  lines.push(``);
  lines.push(`## What I see in your challenge`);
  if (terms.length) {
    lines.push(...terms.slice(0, 6).map((t) => `- **${t}** — define what “done” means for this before anything else`));
  } else {
    lines.push(`- Restate the goal in one sentence — “done” should be checkable`);
  }
  lines.push(``);
  lines.push(`## Options (ranked)`);
  lines.push(`| # | Option | Effort | Impact |`);
  lines.push(`|---|--------|--------|--------|`);
  lines.push(`| 1 | Do the smallest version manually once | Low | Learns the most |`);
  lines.push(`| 2 | Template it so attempt #2 is 2× faster | Medium | Compounds |`);
  lines.push(`| 3 | Automate only after 3 manual runs | Higher | Pays off later |`);
  lines.push(``);

  if (looksLikeCode(prompt) || category === "coding") {
    lines.push(`## Starter code pattern`);
    lines.push("```python");
    lines.push(`# Smallest testable version — adapt freely`);
    lines.push(`def solve(items):`);
    lines.push(`    """Clarify input/output, handle the empty case first."""`);
    lines.push(`    if not items:`);
    lines.push(`        return []`);
    lines.push(`    result = []`);
    lines.push(`    for item in items:`);
    lines.push(`        # TODO: your core logic for: ${terms[0] ?? "item"}`);
    lines.push(`        result.append(item)`);
    lines.push(`    return result`);
    lines.push("```");
    lines.push(``);
  }
  if (looksLikeSystem(prompt) || category === "general") {
    lines.push(`## Make it repeatable`);
    lines.push(`- [ ] Write the 5-step checklist version of this`);
    lines.push(`- [ ] Save one template / naming convention`);
    lines.push(`- [ ] Review after 3 uses, then automate the boring part`);
    lines.push(``);
  }
  lines.push(`## Next step (30 min)`);
  lines.push(`1. Write the one-sentence outcome for **${terms[0] ?? "this task"}**`);
  lines.push(`2. Do the smallest manual version`);
  lines.push(`3. Bring the result back and I'll help you systematize it`);
  lines.push(``);
  lines.push(`*🔒 Generated fully on-device in Local Mode — nothing left your machine. No training, no retention, no cloud.*`);
  return lines.join("\n");
}

// ---------- local collaboration ----------

const ROLE_LENSES: Record<string, string> = {
  default: "Answer with a distinct, opinionated perspective.",
};

export function localCollabDraft(label: string, role: string, challenge: string, strategyId: string): string {
  const terms = keyTerms(challenge);
  const focus = terms.slice(0, 4).join(", ") || "the core goal";
  const short = challenge.length > 200 ? challenge.slice(0, 200) + "…" : challenge;
  const lens = ROLE_LENSES[role] ?? ROLE_LENSES.default;
  const strategyBlock: Record<string, string[]> = {
    brainstorm: [
      `## 6 options from ${role}`,
      `1. **The Obvious Done Well** — execute the standard approach for ${focus} flawlessly`,
      `2. **The Twist** — same goal, unexpected format or sequence`,
      `3. **The Constraint Flip** — what if you had half the time/budget?`,
      `4. **The Audience Hack** — design for one specific person, not everyone`,
      `5. **The Lore Play** — wrap it in a story or universe people can follow`,
      `6. **The Weird One** — the idea you'd almost discard; prototype it cheapest`,
    ],
    systems: [
      `## ${role}: reusable system`,
      `**Workflow:** 1) Capture → 2) Triage → 3) Produce → 4) Publish → 5) Archive`,
      `**Template:**`,
      "```",
      `Title: [${terms[0] ?? "topic"}] — [hook]`,
      `Status: draft → review → shipped`,
      `Links: source, assets, archive path`,
      "```",
      `**Checklist:** naming ✓ · assets ✓ · archive ✓ · cross-post ✓`,
    ],
    scenarios: [
      `## ${role}: a possible world`,
      `**What happens:** you commit to this path for ${focus} for 90 days.`,
      `**Requires:** one weekly ritual + one measurable outcome.`,
      `**Best case:** compounding results you can point to.`,
      `**Worst case:** a cheap, legible lesson — archive it and pivot.`,
      `**Suits:** builders who prefer signal over noise.`,
    ],
    signal: [
      `## ${role}'s reading`,
      `**What you're really asking:** how to turn “${short}” into something decidable.`,
      `**Signals I see:** ${focus || "intent, constraints, next step"}.`,
      `**The clarifying question:** what would “obviously working” look like in 2 weeks?`,
    ],
    "second-brain": [
      `## ${role}: structure for the mess`,
      `### Entities`, ...(terms.slice(0, 5).map((t) => `- **${t}**`) || ["- (add your items)"]),
      `### Groups`, `- Now / Next / Later`, `- Needs decision vs. needs execution`,
      `### Gaps & contradictions`, `- What's missing: owners, dates, done-definitions`,
    ],
    debate: [
      `## ${role}: my stance`,
      `**Position:** start with the smallest version of ${focus}, measure one thing, then decide.`,
      `**Why:** reversibility beats correctness early; data beats debate.`,
      `**Falsifiable claim:** if the first attempt teaches nothing, the framing — not the effort — is wrong.`,
    ],
  };
  const body = strategyBlock[strategyId] ?? [
    `## ${role}'s take`,
    `On “${short}”:`,
    `- **Core move:** shrink ${focus} to one checkable outcome`,
    `- **Best idea:** run the smallest manual version this week, then template what worked`,
    `- **Watch out:** over-systemizing before the first real attempt`,
  ];
  return [
    `**${label}** · *local draft — no internet used*`,
    ``,
    `> Lens: ${lens}`,
    ``,
    ...body,
    ``,
    `**Best idea:** ${focus} → one outcome, one attempt, one template.`,
  ].join("\n");
}

export function localSynthesis(strategyId: string, challenge: string, drafts: { label: string; text: string }[]): string {
  const terms = keyTerms(challenge);
  const focus = terms.slice(0, 4).join(", ") || "your goal";
  const sources = drafts.map((d) => d.label).join(" · ");
  return [
    `## 💎 Best result (local synthesis)`,
    ``,
    `**Challenge:** ${challenge.length > 300 ? challenge.slice(0, 300) + "…" : challenge}`,
    ``,
    `### The answer`,
    `Focus everything on **${focus}**. The council converged on three moves:`,
    ``,
    `1. **Clarify** — one sentence: what does “done” look like?`,
    `2. **Attempt** — smallest manual version, one sitting, one lesson captured`,
    `3. **Systematize** — checklist + template + archive path so attempt #2 is 2× faster`,
    ``,
    `### Why this wins`,
    `- Combines the strongest point of each draft instead of picking one winner`,
    `- Keeps you in the curator seat: reject, reshape, re-run until it clicks`,
    `- Every step produces an artifact (note, template, checklist) your future self reuses`,
    ``,
    `### Next 3 steps`,
    `1. Write the done-sentence for **${terms[0] ?? "the task"}** (5 min)`,
    `2. Do the smallest version (25 min)`,
    `3. Save what worked as a template in your library`,
    ``,
    `*Sources: ${sources}*`,
    ``,
    `*🔒 Synthesized fully on-device · strategy: ${strategyId} · no cloud, no training, no retention.*`,
  ].join("\n");
}

// ---------- local heuristic judge (transparent rubric, no cloud) ----------

export interface LocalJudge {
  suggestion: "a" | "b" | "tie" | "both-bad";
  scoreA: number;
  scoreB: number;
  reasoning: string;
}

function scoreText(t: string): { score: number; parts: string[] } {
  const parts: string[] = [];
  let s = 4;
  const len = t.length;
  if (len > 400) {
    s += 1;
    parts.push("substantive length");
  }
  if (len > 1500) {
    s += 1;
    parts.push("good depth");
  }
  if (/^#{1,3} |## /m.test(t)) {
    s += 1;
    parts.push("clear structure");
  }
  if (/```/.test(t)) {
    s += 1;
    parts.push("concrete examples/code");
  }
  if (/\|.*\|/.test(t) || /^\d+\./m.test(t)) {
    s += 0.5;
    parts.push("organized comparisons/steps");
  }
  if (/- \[[ x]\]/i.test(t)) {
    s += 0.5;
    parts.push("actionable checklist");
  }
  if (len < 120) {
    s -= 2;
    parts.push("very thin");
  }
  return { score: Math.max(1, Math.min(10, Math.round(s * 2) / 2)), parts };
}

export function localJudge(prompt: string, a: string, b: string): LocalJudge {
  const sa = scoreText(a);
  const sb = scoreText(b);
  const terms = keyTerms(prompt, 6);
  const hit = (t: string) => terms.filter((w) => t.toLowerCase().includes(w)).length;
  const ha = hit(a);
  const hb = hit(b);
  let scoreA = sa.score + Math.min(1.5, ha * 0.3);
  let scoreB = sb.score + Math.min(1.5, hb * 0.3);
  scoreA = Math.round(Math.min(10, scoreA) * 2) / 2;
  scoreB = Math.round(Math.min(10, scoreB) * 2) / 2;
  let suggestion: LocalJudge["suggestion"];
  if (scoreA < 3.5 && scoreB < 3.5) suggestion = "both-bad";
  else if (Math.abs(scoreA - scoreB) < 0.75) suggestion = "tie";
  else suggestion = scoreA > scoreB ? "a" : "b";
  return {
    suggestion,
    scoreA,
    scoreB,
    reasoning: `Local heuristic rubric (no cloud): A scores ${scoreA}/10 (${sa.parts.join(", ") || "basic"}; covers ${ha}/${terms.length} key terms) vs B ${scoreB}/10 (${sb.parts.join(", ") || "basic"}; covers ${hb}/${terms.length} key terms). ${suggestion === "tie" ? "Too close to call — treat as a tie." : suggestion === "both-bad" ? "Both are thin — retry or refine." : suggestion === "a" ? "A is more substantive and on-topic." : "B is more substantive and on-topic."}`,
  };
}

// ---------- local procedural image (SVG data URI, offline) ----------

const PALETTES: [string, string, string][] = [
  ["#7c3aed", "#06b6d4", "#f0abfc"],
  ["#f59e0b", "#ef4444", "#fde68a"],
  ["#10b981", "#3b82f6", "#a7f3d0"],
  ["#ec4899", "#8b5cf6", "#fbcfe8"],
  ["#0ea5e9", "#6366f1", "#bae6fd"],
  ["#f97316", "#a855f7", "#fed7aa"],
];

export function localImageDataURI(prompt: string, seed: number, w: number, h: number, style: "flux" | "turbo" = "flux"): string {
  const rnd = mulberry32(seed);
  const pal = PALETTES[Math.floor(rnd() * PALETTES.length)];
  const words = prompt.split(/\s+/).slice(0, 6).join(" ");
  let shapes = "";
  const n = style === "flux" ? 14 : 22;
  for (let i = 0; i < n; i++) {
    const cx = (rnd() * w).toFixed(0);
    const cy = (rnd() * h).toFixed(0);
    const r = (20 + rnd() * Math.min(w, h) * 0.22).toFixed(0);
    const c = pal[Math.floor(rnd() * 3)];
    const o = (0.25 + rnd() * 0.5).toFixed(2);
    if (style === "flux" && rnd() > 0.5) {
      const w2 = (40 + rnd() * w * 0.3).toFixed(0);
      const h2 = (30 + rnd() * h * 0.25).toFixed(0);
      const rot = (rnd() * 60 - 30).toFixed(0);
      shapes += `<rect x="${cx}" y="${cy}" width="${w2}" height="${h2}" rx="18" fill="${c}" opacity="${o}" transform="rotate(${rot} ${cx} ${cy})"/>`;
    } else {
      shapes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" opacity="${o}"/>`;
    }
  }
  // horizon lines for texture
  for (let i = 0; i < 5; i++) {
    const y = (h * 0.15 + rnd() * h * 0.7).toFixed(0);
    shapes += `<line x1="0" y1="${y}" x2="${w}" y2="${(Number(y) + (rnd() * 40 - 20)).toFixed(0)}" stroke="#ffffff" stroke-opacity="0.14" stroke-width="${(1 + rnd() * 2).toFixed(0)}"/>`;
  }
  const caption = words.replace(/[<>&"]/g, "").slice(0, 48) || "local canvas";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>${shapes}` +
    `<rect x="0" y="${h - 64}" width="${w}" height="64" fill="#000" opacity="0.45"/>` +
    `<text x="20" y="${h - 24}" font-family="system-ui,sans-serif" font-size="20" fill="#fff" opacity="0.92">${caption}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
