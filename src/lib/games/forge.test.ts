/**
 * Game forge contract tests — Tetris + 2048 engines.
 *
 * These guard the "generated games are real games" promise: the emitted
 * single-file HTML must pass the same validator the Arcade uses for LLM
 * output, contain the required gameplay subsystems, be fully offline, parse
 * as JavaScript, and actually change when mods change (remix, not one
 * hardcoded file).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildTetris } from "./tetris";
import { build2048 } from "./twenty48";
import { detectGameType, generateGameOffline, validateGameCode } from "./index";

/** Parse-only syntax gate: the game's <script> must be valid JavaScript. */
function scriptParses(html: string): boolean {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(m[1]);
    return true;
  } catch {
    return false;
  }
}

test("prompt detection routes tetris and 2048", () => {
  assert.equal(detectGameType("make me a tetris game"), "tetris");
  assert.equal(detectGameType("falling blocks please"), "tetris");
  assert.equal(detectGameType("stack the falling pieces neon"), "tetris");
  assert.equal(detectGameType("2048"), "2048");
  assert.equal(detectGameType("a merge numbers game"), "2048");
  assert.equal(detectGameType("twenty forty eight"), "2048");
  // existing detections must not regress
  assert.equal(detectGameType("snake game"), "snake");
  assert.equal(detectGameType("breakout with bricks"), "breakout");
});

test("tetris core is a complete, valid, offline game", () => {
  const code = buildTetris();
  const v = validateGameCode(code);
  assert.ok(v.ok, `validator issues: ${v.issues.join("; ")}`);
  assert.ok(scriptParses(code), "emitted script must parse as JavaScript");
  // required subsystems, not a stub
  assert.match(code, /SHAPES/); // 7 pieces × 4 rotations
  assert.match(code, /refill/); // 7-bag randomizer
  assert.match(code, /tryRotate/); // rotation with wall kicks
  assert.match(code, /clearLines/); // line clearing + scoring
  assert.match(code, /doHold/); // hold piece
  assert.match(code, /ghostY/); // ghost piece
  assert.match(code, /hardDrop/); // hard drop
  assert.match(code, /af_tetris_high/); // persistent high score
});

test("tetris mods actually change the game (remix, not a fixed file)", () => {
  const a = buildTetris();
  const b = buildTetris();
  assert.equal(a, b, "generation is deterministic for identical options");
  const turbo = buildTetris({ gravityMs: 400, startLevel: 7, cols: 8, hold: false, ghost: false });
  assert.notEqual(a, turbo);
  assert.match(turbo, /gravityMs:400/);
  assert.match(turbo, /startLevel:7/);
  assert.match(turbo, /hold:false/);
  assert.match(turbo, /ghost:false/);
  assert.ok(validateGameCode(turbo).ok);
});

test("2048 core is a complete, valid, offline game", () => {
  const code = build2048();
  const v = validateGameCode(code);
  assert.ok(v.ok, `validator issues: ${v.issues.join("; ")}`);
  assert.ok(scriptParses(code), "emitted script must parse as JavaScript");
  assert.match(code, /slide/); // merge logic
  assert.match(code, /rotateGrid/); // four-direction sliding
  assert.match(code, /addTile/); // 2/4 spawn
  assert.match(code, /KEEP GOING/); // win state with continue
  assert.match(code, /NO MOVES LEFT/); // dead-end detection
});

test("2048 grid-size variants are real variants", () => {
  const normal = build2048({ size: 4 });
  const brutal = build2048({ size: 3 });
  const roomy = build2048({ size: 5 });
  assert.match(normal, /size:4/);
  assert.match(brutal, /size:3/);
  assert.match(roomy, /size:5/);
  assert.ok(validateGameCode(brutal).ok && validateGameCode(roomy).ok);
  assert.ok(scriptParses(brutal) && scriptParses(roomy));
});

test("generateGameOffline forges tetris and 2048 end to end", () => {
  const t = generateGameOffline("tetris but turbo and hard mode, matrix theme");
  assert.equal(t.gameType, "tetris");
  assert.ok(validateGameCode(t.code).ok);
  assert.equal(t.engine, "remix", "mods must be labeled as a remix, not a stock verified core");

  const g = generateGameOffline("2048 easy mode");
  assert.equal(g.gameType, "2048");
  assert.ok(validateGameCode(g.code).ok);
  assert.match(g.code, /size:5/, "easy mode widens the grid");
});
