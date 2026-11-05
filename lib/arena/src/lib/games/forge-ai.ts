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

import { generate } from "@workspace/arena/lib/ai";
import { getModel } from "@workspace/arena/lib/models";
import { extractImportedHtml, importedHtmlSafetyIssue } from "./imported-html";
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
- Persist meaningful game progress—levels, unlocks, options, or a campaign checkpoint when the game has them—using localStorage inside try/catch. Arcade provides an isolated per-game localStorage bridge, so saves remain on this browser.
- Aesthetic: dark theme, one accent color, readable HUD typography, canvas scaled responsively (CSS max-width, aspect kept).
- Robustness: no unbounded arrays (cap particles), no NaN propagation, works at 60fps and 144fps (dt-based).
- A short "how to play" block listing controls.
- Include a <meta name="arena-controls" content="..."> in <head> with concise, accurate, game-specific controls separated by |. Before returning the game, check every listed key and touch action against the event handlers and the gameplay effect they trigger; remove any claim without a working handler. Omit the tag if controls are unknown.

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

export interface RemoteModelTestResult {
  response: string;
  runtime: { backend: string; modelId: string; via?: string; ms: number };
}

const REMOTE_MODEL_TEST_REQUEST =
  "For a tiny HTML5 game, name one thing to draw, one key control, and one way to score. Reply in one short sentence.";

/**
 * Verify only the selected remote text model. This deliberately avoids the
 * game-generation pipeline, fallback routes, validation, preview, and storage.
 */
export async function testRemoteGameModel(
  modelId: string,
  opts: { signal?: AbortSignal } = {},
  deps: { generate?: typeof generate } = {},
): Promise<RemoteModelTestResult> {
  const model = getModel(modelId);
  if (model.id !== modelId || model.level !== "remote" || model.backend !== "pollinations" || model.kind !== "text") {
    throw new Error("The selected model is not a supported remote text model.");
  }

  const result = await (deps.generate ?? generate)({
    modelId,
    messages: [{ role: "user", content: REMOTE_MODEL_TEST_REQUEST }],
    system: "Answer only with one concise sentence. Do not produce code.",
    temperature: 0,
    maxTokens: 48,
    signal: opts.signal,
    strictRoute: true,
    allowPublicFallback: false,
  });

  if (result.fallback || result.runtimeLevel !== "remote" || result.backend !== "pollinations") {
    throw new Error("Pollinations did not run the selected remote model; no fallback was accepted.");
  }
  if (!result.text.trim()) throw new Error("Pollinations returned an empty response.");

  return {
    response: result.text.trim().slice(0, 400),
    runtime: {
      backend: result.backend,
      modelId: result.modelId,
      via: result.via,
      ms: result.ms,
    },
  };
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\b(make|create|build|generate|a|an|the|me|game|please)\b/gi, " ").replace(/\s+/g, " ").trim();
  return (clean.slice(0, 40) || "Custom Game").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function forgeGameWithAI(
  prompt: string,
  opts: { keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string; openai?: string; mistral?: string }; localOnly?: boolean; modelId?: string; priorCode?: string; signal?: AbortSignal } = {},
  deps: { generate?: typeof generate } = {}
): Promise<ForgeAIResult> {
  const gen = deps.generate ?? generate;
  const modelId = opts.modelId ?? "openai";
  const mods: Mods = parseMods(prompt);
  const priorCode = opts.priorCode?.trim();
  if (priorCode && priorCode.length > 50_000) {
    throw new Error("This game file is too large to revise in one pass (limit: 50KB).");
  }

  const userPrompt = priorCode
    ? `Modify the existing game according to this instruction: "${prompt}"\n\n` +
      `Preserve its working controls and mechanics unless the instruction changes them. If a control changes, update the control metadata and how-to-play text to match the new handlers, and remove any obsolete claim. Check the declared controls against the actual input handlers before returning the complete updated game file, not a patch.\n\nEXISTING GAME:\n${priorCode}`
    : `Build this game: "${prompt}"\n\n` +
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
      signal: opts.signal,
      allowPublicFallback: false,
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
    (err as any).draft = {
      code,
      title: titleFromPrompt(prompt),
      gameType: detectGameType(prompt),
      validation,
    };
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

export async function reviseImportedHtmlWithAI(
  instruction: string,
  source: string,
  opts: {
    keys?: { openrouter?: string; groq?: string; gemini?: string; turboagent?: string; openai?: string; mistral?: string };
    localOnly?: boolean;
    modelId?: string;
    signal?: AbortSignal;
  } = {},
  deps: { generate?: typeof generate } = {},
): Promise<{ code: string; runtime: { backend?: string; modelId: string; via?: string; fallback?: boolean; ms: number } }> {
  const prompt = instruction.trim();
  if (!prompt || prompt.length > 1000) throw new Error("Describe one game change in 1–1,000 characters.");
  if (source.length > 50_000) throw new Error("Game source sent for revision is limited to 50 KB after media is removed.");
  const sourceIssue = importedHtmlSafetyIssue(source);
  if (sourceIssue) throw new Error(sourceIssue);

  const gen = deps.generate ?? generate;
  const result = await gen({
    modelId: opts.modelId ?? "openai",
    messages: [{
      role: "user",
      content:
        `Change the existing authorized browser game to implement this gameplay request: "${prompt}"\n\n` +
        `Return only the complete updated HTML document. Do not replace it with a generic template. Preserve existing controls and unrelated mechanics. ` +
        `Keep every data:ARENA_ASSET_TOKEN_NNNN marker exactly once and in its original location; those stand for local bundled media. ` +
        `Do not add network access, external files, imports, or parent-window access.\n\nEXISTING GAME:\n${source}`,
    }],
    system:
      "You modify existing HTML5 games by editing their actual gameplay code. Return complete valid HTML, not a plan or patch. " +
      "Preserve functionality that the change does not target. All required code and assets must remain in this one offline document.",
    temperature: 0.2,
    maxTokens: 16_000,
    keys: opts.localOnly ? undefined : opts.keys,
    localOnly: opts.localOnly,
    signal: opts.signal,
    allowPublicFallback: false,
  });
  if (opts.signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
  if (result.fallback) {
    const error = new Error("No connected code-writing model is available for this imported-game revision.");
    (error as any).noModel = true;
    throw error;
  }

  const code = extractImportedHtml(result.text);
  if (!code) throw new Error("The model did not return a complete HTML game.");
  const outputIssue = importedHtmlSafetyIssue(code);
  if (outputIssue) throw new Error(`The revised game was declined by the import safety checks: ${outputIssue}`);
  return {
    code,
    runtime: { backend: result.backend, modelId: result.modelId, via: result.via, fallback: result.fallback, ms: result.ms },
  };
}
