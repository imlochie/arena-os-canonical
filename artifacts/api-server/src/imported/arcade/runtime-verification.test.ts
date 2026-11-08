import assert from "node:assert/strict";
import test from "node:test";
import { generateGameOffline, validateGameCode, type GameType } from "@workspace/arena/lib/games";
import { verifyArcadeRuntime } from "./runtime-verification";

test("isolated browser check reports an animation-loop canvas startup", async () => {
  const code = generateGameOffline("Pong", "pong").code;
  const report = await verifyArcadeRuntime(code);

  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.scope, "startup-render-only");
  assert.ok((report.canvas?.width ?? 0) >= 32);
  assert.ok((report.animationFrames ?? 0) >= 2);
  assert.equal(report.blockedRequests, 0);
});

test("isolated browser check catches uncaught startup errors without publishing", async () => {
  const code = generateGameOffline("Pong", "pong").code.replace(
    "</body>",
    `<script>document.addEventListener("DOMContentLoaded",function(){throw new Error("intentional startup failure")});</script></body>`,
  );
  const report = await verifyArcadeRuntime(code);

  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.match(report.issues.join(" "), /intentional startup failure/);
});

test("cancelled checks return without launching the browser", async () => {
  const controller = new AbortController();
  controller.abort();
  const code = generateGameOffline("Pong", "pong").code;
  const report = await verifyArcadeRuntime(code, controller.signal);

  assert.equal(report.status, "unavailable", JSON.stringify(report));
  assert.match(report.issues.join(" "), /cancelled/i);
});

const ALL_TYPES: GameType[] = ["pacman", "invaders", "snake", "breakout", "pong", "tetris", "2048", "arena", "platformer"];

for (const type of ALL_TYPES) {
  test(`every built-in game passes the publication gate: ${type}`, async () => {
    const report = await verifyArcadeRuntime(generateGameOffline(type, type).code);
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.rendered, true);
  });
}

// Minimal documents that satisfy validateGameCode so the BROWSER check is what rejects them.
function shell(script: string, canvas = `<canvas id="c" width="320" height="240"></canvas>`): string {
  const filler = "/* " + "padding ".repeat(1200) + "*/";
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${canvas}<div id="score">Score 0</div>` +
    `<script>${filler}\ndocument.addEventListener("keydown",function(){});\n${script}</script></body></html>`;
}

test("a running loop over a blank canvas is not published", async () => {
  const code = shell(`(function loop(){requestAnimationFrame(loop)})();`);
  assert.equal(validateGameCode(code).ok, true, JSON.stringify(validateGameCode(code)));
  const report = await verifyArcadeRuntime(code);
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.equal(report.rendered, false);
  assert.match(report.issues.join(" "), /uniform|nothing was drawn/);
});

test("a game that draws but never advances its loop is not published", async () => {
  const code = shell(`var x=document.getElementById("c").getContext("2d");x.fillStyle="red";x.fillRect(10,10,50,50);function unused(){requestAnimationFrame(unused)}`);
  assert.equal(validateGameCode(code).ok, true, JSON.stringify(validateGameCode(code)));
  const report = await verifyArcadeRuntime(code);
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.match(report.issues.join(" "), /animation loop/);
});

test("a game that reaches for the network is not published", async () => {
  const code = shell(
    `var x=document.getElementById("c").getContext("2d");(function loop(){x.fillStyle="#"+(Math.random()*0xffffff|0).toString(16).padStart(6,"0");x.fillRect(0,0,50,50);requestAnimationFrame(loop)})();` +
    `try{self["fe"+"tch"]("ht"+"tp://127.0.0.1:9/leak")}catch(e){}`,
  );
  assert.equal(validateGameCode(code).ok, true, JSON.stringify(validateGameCode(code)));
  const report = await verifyArcadeRuntime(code);
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.ok(report.browser, "rejection must come from the browser check, not static validation");
});

test("an unavailable browser is reported as unavailable, never as a pass", async () => {
  const previous = process.env.ARENA_ARCADE_CHROMIUM_PATH;
  process.env.ARENA_ARCADE_CHROMIUM_PATH = process.platform === "win32" ? "C:\\no\\such\\chrome.exe" : "/no/such/chrome";
  try {
    const report = await verifyArcadeRuntime(generateGameOffline("Pong", "pong").code);
    assert.equal(report.status, "unavailable", JSON.stringify(report));
    assert.notEqual(report.status, "passed");
  } finally {
    if (previous === undefined) delete process.env.ARENA_ARCADE_CHROMIUM_PATH;
    else process.env.ARENA_ARCADE_CHROMIUM_PATH = previous;
  }
});

test("code that fails static validation never reaches the browser", async () => {
  const report = await verifyArcadeRuntime("<html>not a game</html>");
  assert.equal(report.status, "failed");
  assert.equal(report.browser, undefined);
});

const CONTRACT = {
  version: 1,
  scenarios: [
    { kind: "controls", name: "Move", steps: [{ press: "ArrowRight", holdMs: 80 }], checks: [{ selector: "#pos", mode: "change" }] },
    { kind: "progress", name: "Score", steps: [{ press: "Space" }], checks: [{ selector: "#pts", mode: "increase" }] },
    { kind: "terminal", name: "Win", steps: [{ press: "Space" }], checks: [{ selector: "#state", mode: "equals", value: "won" }] },
    { kind: "restart", name: "Reset", steps: [{ press: "Space" }, { press: "r" }], checks: [{ selector: "#pts", mode: "equals", value: "0" }, { selector: "#state", mode: "equals", value: "playing" }] },
  ],
};

function playable(options: { brokenScore?: boolean; contract?: unknown } = {}): string {
  const script =
    `var c=document.getElementById("c"),x=c.getContext("2d"),px=0,pts=0,st="playing";` +
    `function hud(){document.getElementById("pos").textContent=String(px);document.getElementById("pts").textContent=String(pts);document.getElementById("state").textContent=st}` +
    `document.addEventListener("keydown",function(e){` +
    `if(e.key==="ArrowRight")px+=20;` +
    `if(e.key===" "${options.brokenScore ? "&&false" : ""}){pts++;if(pts>=1)st="won"}` +
    `if(e.key==="r"){pts=0;st="playing";px=0}hud()});` +
    `(function loop(){x.fillStyle="#102030";x.fillRect(0,0,320,240);x.fillStyle="#f80";x.fillRect(10+px%280,100,24,24);requestAnimationFrame(loop)})();hud();`;
  const contract = options.contract === undefined ? CONTRACT : options.contract;
  const hud = `<div id="pos">0</div><div id="pts">0</div><div id="state">playing</div>`;
  const json = contract ? `<script id="arena-gameplay" type="application/json">${JSON.stringify(contract)}</script>` : "";
  return shell(script, `<canvas id="c" width="320" height="240" tabindex="0"></canvas>${hud}`).replace("</body>", `${json}</body>`);
}

test("a game whose declared gameplay scenarios hold passes with the wider scope", async () => {
  const code = playable();
  assert.equal(validateGameCode(code).ok, true, JSON.stringify(validateGameCode(code)));
  const report = await verifyArcadeRuntime(code, undefined, { requireGameplay: true });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.scope, "startup-render-and-declared-gameplay");
  assert.equal(report.gameplay?.status, "passed");
  assert.equal(report.gameplay?.scenarios.length, 4);
});

test("a game whose HUD does not respond to the declared input fails with the scenario named", async () => {
  const report = await verifyArcadeRuntime(playable({ brokenScore: true }), undefined, { requireGameplay: true });
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.match(report.issues.join(" "), /progress\/Score/);
});

test("generated games must declare gameplay; a missing contract is not a pass", async () => {
  const report = await verifyArcadeRuntime(playable({ contract: null }), undefined, { requireGameplay: true });
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.match(report.issues.join(" "), /arena-gameplay/);
  const smokeOnly = await verifyArcadeRuntime(playable({ contract: null }));
  assert.equal(smokeOnly.status, "passed", JSON.stringify(smokeOnly));
  assert.equal(smokeOnly.scope, "startup-render-only");
});
