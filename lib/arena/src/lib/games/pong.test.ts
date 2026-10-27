import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildPong } from "./classics";

function startPong() {
  const drawing = new Proxy({}, { get: () => () => drawing });
  const canvas = { width: 480, height: 360, getContext: () => drawing, addEventListener() {} };
  const node = { textContent: "", innerHTML: "", classList: { add() {}, remove() {} } };
  const context: any = {
    document: { getElementById: (id: string) => id === "game" ? canvas : node, querySelectorAll: () => [] },
    requestAnimationFrame() {}, addEventListener() {}, console,
  };
  context.window = context;
  vm.createContext(context);
  const script = buildPong().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert(script);
  vm.runInContext(script, context);
  context.__start();
  return context;
}

test("Pong starts and restarts with numeric zero scores", () => {
  const game = startPong();
  assert.equal(game.you.s, 0);
  assert.equal(game.cpu.s, 0);
  game.you.s = 3;
  game.__start();
  assert.equal(game.you.s, 0);
  assert.equal(game.cpu.s, 0);
});

test("Pong reflects the ball away from both paddles", () => {
  const game = startPong();
  Object.assign(game.ball, { x: game.you.x + 8, y: game.you.y, vx: -300, vy: 0 });
  game.update(0);
  assert(game.ball.vx > 0, "the left paddle must return the ball right");
  Object.assign(game.ball, { x: game.cpu.x - 8, y: game.cpu.y, vx: 300, vy: 0 });
  game.update(0);
  assert(game.ball.vx < 0, "the right paddle must return the ball left");
});

test("Pong counts points and reaches a winner", () => {
  const game = startPong();
  Object.assign(game.ball, { x: -30, vx: -300 });
  game.update(0);
  assert.equal(game.cpu.s, 1);
  game.cpu.s = 6;
  Object.assign(game.ball, { x: -30, vx: -300 });
  game.update(0);
  assert.equal(game.cpu.s, 7);
  assert.equal(game.state, "over");
});
