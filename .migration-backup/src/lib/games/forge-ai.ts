/**
 * Generative arcade forge — ANY game, real codegen.
 *
 * The template cores (Snake…2048) are the offline floor. This module is the
 * ceiling: a construction-knowledge prompt that turns any capable model into
 * a game builder. The knowledge base is the "ability and knowledge" — the
 * complete checklist of what makes a single-file game real (loop, input,
 * collision, states, juice, progression, persistence), so the model isn't
 * left guessing.
 *
 * The pipeline is honest about every step: generation → extraction →
 * validation → ONE repair round with the validator's actual complaints →
 * persist with engine "ai-codegen". If no model is reachable, it returns a
 * 503 explaining exactly that (the offline forge remains one click away).
 */

import { generate } from "@/lib/ai";
import { detectGameType, extractGameCode, validateGameCode, type Mods, parseMods } from "./index";

const KNOWLEDGE = `You are a master single-file game developer. You build COMPLETE, PLAYABLE games in ONE HTML file: no imports, no CDNs, no external assets, no network calls — everything inline.

CONSTRUCTION KNOWLEDGE — every game you ship contains all of this, chosen to fit the request:
- Canvas + a fixed-timestep or dt-clamped requestAnimationFrame loop; pause when hidden.
- Input: keyboard (arrows/WASD + space/enter) AND pointer/touch with tap/swipe zones; prevent arrow-key page scroll.
- Game states: title screen → play → pause (P) → game over / win, with overlay panels; restart (R); start button.
- Collision & physics appropriate to the genre: AABB, grid cells, swept/stepped movement, bounce angles, gravity, friction — never "teleport through" bugs (substep fast movers).
- A real scoring/win/lose condition, HUD (score, lives/level/time as fits), and difficulty progression (speed-up, waves, levels).
- Enemy/NPC behavior with actual state (patrol, chase with line-of-sight or aggro radius, flee, spawn pacing).
- Juice: screen shake, particles, hit flashes, easing on menus — at least two.
- WebAudio bleeps via a tiny synth helper (no audio files); mute toggle (M).
- Persistence of the high score via localStorage (guard with try/catch).
- Aesthetic: dark theme, one accent color, readable HUD typography, canvas scaled responsively (CSS max-width, aspect kept).
- Robustness: no unbounded arrays (cap particles), no NaN propagation, works at 60fps and 144fps (dt-based).
- A short "how to play" block listing controls.

HARD REQUIREMENTS for the output:
- One complete <!DOCTYPE html> document, 8KB–120KB.
- Must include: <canvas>, <script>, requestAnimationFrame, keydown handling, a score/HUD.
- Zero external URLs (no http(s) resources at all).
- Pure vanilla JS — no frameworks, no import statements.
- The game must implement the USER'S REQUESTED GAME, not a generic template.`;

export interface ForgeAIResult {
  code: string;
  engine: "ai-codegen";
  gameType: string;
  repairsUsed: number;
  validation: { ok: boolean; issues: string[]; bytes: number };
  runtime: { backend?: string; modelId: string; via?: string; fallback?: boolean; ms: number };
  repairRuntime?: { backend?: string; modelId?: string };
  title: string;
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\b(make|create|build|generate|a|an|the|me|game|please)\b/gi, " ").replace(/\s+/g, " ").trim();
  return (clean.slice(0, 40) || "Custom Game").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function forgeGameWithAI(
  prompt: string,
  opts: { keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string }; localOnly?: boolean; modelId?: string } = {},
  deps: { generate?: typeof generate } = {}
): Promise<ForgeAIResult> {
  const gen = deps.generate ?? generate;
  const modelId = opts.modelId ?? "openai";
  const mods: Mods = parseMods(prompt);

  const userPrompt =
    `Build this game: "${prompt}"\n\n` +
    (Object.keys(mods).length ? `Detected mods to honor: ${JSON.stringify(mods)}\n` : "") +
    `Return ONLY the complete HTML document. No commentary, no fences around anything else.`;

  const call = async (extra?: string) =>
    gen({
      modelId,
      messages: [{ role: "user", content: extra ? userPrompt + "\n\n" + extra : userPrompt }],
      system: KNOWLEDGE,
      temperature: 0.4,
      maxTokens: 16_000,
      keys: opts.localOnly ? undefined : opts.keys,
      localOnly: opts.localOnly,
    });

  const first = await call();
  // Honesty gate: if the request fell back to the deterministic Local
  // Engine, it cannot write an arbitrary game — say so instead of
  // "validating" prose and failing confusingly.
  if (first.fallback) {
    const err = new Error(
      `no capable model is reachable (request fell back to the deterministic Local Engine). ` +
        `Connect a model — free Groq/OpenRouter key in Settings, on-device WebLLM, or a TurboAgent local server — then generate any game.`
    );
    (err as any).noModel = true;
    throw err;
  }
  let code = extractGameCode(first.text) ?? "";
  let validation = validateGameCode(code);
  let repairsUsed = 0;
  let repairRuntime: ForgeAIResult["repairRuntime"] | undefined;

  // One repair round with the validator's real complaints.
  if (!validation.ok && code) {
    repairsUsed = 1;
    const repair = await call(
      `Your previous attempt failed validation with these issues:\n- ${validation.issues.join("\n- ")}\n\nReturn the FIXED complete HTML document.`
    );
    repairRuntime = { backend: repair.backend, modelId: repair.modelId };
    const fixed = extractGameCode(repair.text);
    if (fixed) {
      const fixedValidation = validateGameCode(fixed);
      if (fixedValidation.ok || fixedValidation.issues.length < validation.issues.length) {
        code = fixed;
        validation = fixedValidation;
      }
    }
  }

  if (!validation.ok) {
    const err = new Error(`AI draft failed validation: ${validation.issues.join("; ")}`);
    (err as any).validation = validation;
    throw err;
  }

  return {
    code,
    engine: "ai-codegen",
    gameType: detectGameType(prompt),
    repairsUsed,
    validation,
    runtime: { backend: first.backend, modelId: first.modelId, via: first.via, fallback: first.fallback, ms: first.ms },
    repairRuntime,
    title: titleFromPrompt(prompt),
  };
}
