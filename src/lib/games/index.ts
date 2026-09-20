// Offline game orchestrator: detect → verified core → remix → validate.
// Pure functions, zero network. Used server-side (local generation) and
// client-side (instant, even with no server round-trip).

import { buildPacman } from "./pacman";
import { buildInvaders } from "./invaders";
import { buildSnake, buildBreakout, buildPong } from "./classics";
import { buildArena, themeFromPrompt } from "./arena";

export type GameType = "pacman" | "invaders" | "snake" | "breakout" | "pong" | "arena";
export type GameEngine = "verified" | "remix" | "on-device-ai";

export interface GameMeta {
  id: GameType;
  name: string;
  emoji: string;
  desc: string;
}

export const GAME_TYPES: GameMeta[] = [
  { id: "pacman", name: "Maze Chase", emoji: "👻", desc: "Pac-Man-classic: pellets, power-ups, 4 ghost brains" },
  { id: "invaders", name: "Space Invaders", emoji: "👾", desc: "Hold the line: shields, UFO bonus, endless waves" },
  { id: "snake", name: "Snake", emoji: "🐍", desc: "Eat, grow, don't bite yourself" },
  { id: "breakout", name: "Breakout", emoji: "🧱", desc: "Bricks, angles, 2-hit armored rows" },
  { id: "pong", name: "Pong", emoji: "🏓", desc: "You vs the machine, first to 7" },
  { id: "arena", name: "Neon Arena", emoji: "🚀", desc: "Parametric survival — themed from ANY words" },
];

export function detectGameType(prompt: string): GameType {
  const p = prompt.toLowerCase();
  const has = (...ks: string[]) => ks.some((k) => p.includes(k));
  if (has("pacman", "pac-man", "pac man", "maze chase", "chomp", "pellet", "ghost maze")) return "pacman";
  if (has("invader", "space shooter", "alien shooter", "galaga", "galaxian", "defender")) return "invaders";
  if (has("snake", "worm", "slither", "nokia")) return "snake";
  if (has("breakout", "brick", "breaker", "arkanoid", "paddle ball")) return "breakout";
  if (has("pong", "table tennis", "ping pong")) return "pong";
  if (has("shooter", "shoot", "alien", "space", "invad")) return "invaders";
  if (has("maze", "chase", "ghost", "eat the dots", "dots")) return "pacman";
  if (has("paddle", "bounce", "blocks")) return "breakout";
  if (has("surviv", "arena", "waves", "horde", "vampire")) return "arena";
  return "arena"; // parametric fallback: every prompt yields a game
}

export interface Mods {
  lives?: number;
  speed?: "slow" | "normal" | "fast" | "turbo";
  theme?: string;
  accent?: string;
  difficulty?: "easy" | "normal" | "hard";
  extra?: string[];
}

const THEME_ACCENTS: Record<string, string> = {
  neon: "#22d3ee",
  matrix: "#7CFC00",
  retro: "#ff9f43",
  sunset: "#fb7185",
  ocean: "#38bdf8",
  lava: "#ef4444",
  gold: "#fbbf24",
  candy: "#f9a8d4",
  violet: "#a78bfa",
};

export function parseMods(prompt: string): Mods {
  const p = prompt.toLowerCase();
  const mods: Mods = { extra: [] };
  const lives = p.match(/(\d+)\s*lives?/);
  if (lives) mods.lives = Math.min(9, Math.max(1, Number(lives[1])));
  else if (p.includes("one life") || p.includes("hardcore")) mods.lives = 1;
  if (p.includes("turbo") || p.includes("insane") || p.includes("lightning")) mods.speed = "turbo";
  else if (p.includes("fast") || p.includes("quick") || p.includes("speedy")) mods.speed = "fast";
  else if (p.includes("slow") || p.includes("chill") || p.includes("relax")) mods.speed = "slow";
  else mods.speed = "normal";
  for (const t of Object.keys(THEME_ACCENTS)) {
    if (p.includes(t)) {
      mods.theme = t;
      mods.accent = THEME_ACCENTS[t];
      break;
    }
  }
  if (p.includes("hard mode") || p.includes("difficult") || p.includes("brutal")) mods.difficulty = "hard";
  else if (p.includes("easy mode") || p.includes("easy")) mods.difficulty = "easy";
  return mods;
}

function speedScale(mods: Mods): number {
  const base = mods.speed === "turbo" ? 1.45 : mods.speed === "fast" ? 1.22 : mods.speed === "slow" ? 0.78 : 1;
  if (mods.difficulty === "hard") return base * 1.12;
  if (mods.difficulty === "easy") return base * 0.88;
  return base;
}

export interface OfflineGame {
  code: string;
  gameType: GameType;
  engine: GameEngine;
  title: string;
  ms: number;
  mods: Mods;
}

export function generateGameOffline(prompt: string, forceType?: GameType): OfflineGame {
  const started = Date.now();
  const gameType = forceType ?? detectGameType(prompt);
  const mods = parseMods(prompt);
  const s = speedScale(mods);
  const hasRemix =
    mods.lives !== undefined || mods.speed !== "normal" || mods.accent !== undefined || mods.difficulty !== undefined;

  let code = "";
  let title = "";
  switch (gameType) {
    case "pacman":
      code = buildPacman({
        lives: mods.lives,
        pacSpeed: Math.round(118 * s),
        ghostSpeed: Math.round(94 * s),
        frightTime: mods.difficulty === "easy" ? 8 : mods.difficulty === "hard" ? 4 : undefined,
        accent: mods.accent,
      });
      title = "Maze Chase";
      break;
    case "invaders":
      code = buildInvaders({
        lives: mods.lives,
        fireRate: mods.speed === "slow" ? 340 : mods.speed === "turbo" ? 170 : undefined,
        invaderSpeed: Math.round(28 * s),
        shields: mods.difficulty === "hard" ? 2 : mods.difficulty === "easy" ? 4 : undefined,
        accent: mods.accent,
      });
      title = "Space Invaders";
      break;
    case "snake":
      code = buildSnake({ speed: Math.round(9 * s), wrap: /wrap|portal|no walls/.test(prompt.toLowerCase()) || undefined, goal: undefined, accent: mods.accent });
      title = "Snake";
      break;
    case "breakout":
      code = buildBreakout({
        lives: mods.lives,
        ballSpeed: Math.round(340 * s),
        rows: mods.difficulty === "hard" ? 7 : mods.difficulty === "easy" ? 4 : undefined,
        accent: mods.accent,
      });
      title = "Breakout";
      break;
    case "pong":
      code = buildPong({
        aiSpeed: Math.round((mods.difficulty === "hard" ? 380 : mods.difficulty === "easy" ? 220 : 300) * s),
        ballSpeed: Math.round(360 * s),
        accent: mods.accent,
      });
      title = "Pong";
      break;
    case "arena": {
      const theme = themeFromPrompt(prompt);
      code = buildArena({
        title: theme.title,
        accent: mods.accent ?? theme.accent,
        enemyColor: theme.enemy,
        bg: theme.bg,
        playerSpeed: Math.round(250 * s),
        enemyRate: mods.difficulty === "hard" ? 1.5 : mods.difficulty === "easy" ? 0.7 : 1,
        lives: mods.lives,
      });
      title = theme.title;
      break;
    }
  }
  return { code, gameType, engine: hasRemix || gameType === "arena" ? "remix" : "verified", title, ms: Date.now() - started, mods };
}

// ---------- validation + LLM output handling ----------

export interface Validation {
  ok: boolean;
  issues: string[];
  bytes: number;
}

export function validateGameCode(html: string): Validation {
  const issues: string[] = [];
  const bytes = html.length;
  if (!html || bytes < 1500) issues.push("too short to be a complete game");
  if (bytes > 400000) issues.push("unusually large (>400KB)");
  if (!/<canvas/i.test(html)) issues.push("missing <canvas>");
  if (!/<script/i.test(html)) issues.push("missing <script>");
  if (!/requestAnimationFrame/i.test(html)) issues.push("missing game loop (requestAnimationFrame)");
  if (!/keydown|touchstart|pointerdown/i.test(html)) issues.push("no input handling detected");
  if (/https?:\/\//i.test(html.replace(/https?:\/\/www\.w3\.org/g, ""))) issues.push("external URLs (must be fully offline)");
  if (!/__hud|score/i.test(html)) issues.push("no score/HUD detected");
  return { ok: issues.length === 0, issues, bytes };
}

/** Extract a single HTML doc from raw LLM output (fences, doctype scan). */
export function extractGameCode(raw: string): string | null {
  if (!raw) return null;
  const fence = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().length > 800) return fence[1].trim();
  const start = raw.search(/<!DOCTYPE html|<html/i);
  const end = raw.lastIndexOf("</html>");
  if (start >= 0 && end > start) {
    const doc = raw.slice(start, end + 7);
    if (doc.length > 800) return doc;
  }
  // Bare JS? wrap into the shell so it still plays.
  if (/requestAnimationFrame/.test(raw) && raw.length > 2000 && !/<html/i.test(raw)) {
    return wrapBareJS(raw);
  }
  return null;
}

function wrapBareJS(js: string): string {
  const clean = js.replace(/```[a-z]*|```/gi, "").slice(0, 60000);
  // Minimal canvas shell for raw JS experiments.
  return (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<style>body{margin:0;background:#05070f;display:flex;flex-direction:column;align-items:center;font-family:system-ui;color:#fff}canvas{max-width:100%;border:1px solid #333;border-radius:8px}p{font-size:12px;color:#888}</style></head><body>" +
    "<canvas id='game' width='480' height='480'></canvas><p>on-device AI experiment · offline</p>" +
    "<script>function __hud(){} function __overlay(h){document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-size:20px\">'+h+'</div>');} function __hideOverlay(){} var __store={get:function(k,d){return d;},set:function(){}}; var __muted=false; function __sfx(){}\n" +
    clean +
    "\n</script></body></html>"
  );
}

export const LLM_GAME_SYSTEM = [
  "You generate complete, playable, single-file HTML5 arcade games. Zero network: no external URLs, fonts, images, or CDNs.",
  "OUTPUT ONLY the HTML file. No explanations, no markdown fences if avoidable.",
  "Requirements: <canvas> rendering, requestAnimationFrame loop, keyboard (arrows/WASD/space) AND touch controls, score + lives + levels, start screen, pause (P), game-over and win states, restart (R), WebAudio bleeps with an M mute toggle, no localStorage crashes (wrap in try/catch).",
  "Keep it under ~1500 lines. Make it genuinely playable and fun, with real collision, difficulty ramp, and juice (particles, screen shake, floating text).",
].join(" ");
