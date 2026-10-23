/** First intentionally narrow upstream adapter: no arbitrary URL, archive,
 * dependency installation or host execution. Downloaded JS is data until an
 * explicitly opened opaque browser preview. Preserve MIT and exact provenance.
 */
import { createHash } from "node:crypto";
import { safeFetch } from "@/lib/security/outbound-url";
export const SOURCE_2048 = {
  repository: "https://github.com/gabrielecirulli/2048",
  revision: "478b6ec346e3787f589e4af751378d06ded4cbbc",
  license: "MIT",
  files: {
    "js/game_manager.js": "b02baa6b75f8c8cad8606e680b6f73b7c843c61e3a643ee48410022499a649f0",
    "js/grid.js": "169428f5ff7f726c38112fcf1c918028cbca3a1d9f9239838fbc7eb4396b9f9a",
    "js/tile.js": "13699e51d62179a6d36874108831a29901a98d6e11329918e64cfb5ee82d58e3",
    "LICENSE.txt": "57e12c39a6ad9d98b2e451065bfdfbd15fc9e0c2ed3bf4dc1d09acab41ff02fc",
  },
} as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export type SpawnRule = "original" | "guaranteed-four";
const spawnAnchor = "    var value = Math.random() < 0.9 ? 2 : 4;";
export function patchGameplay(source: string, count: number, rule: SpawnRule) {
  if (rule !== "original" && rule !== "guaranteed-four") throw new Error("Unsupported spawning rule.");
  const initial = patchInitialTiles(source, count);
  if (rule === "original") return initial;
  const original = source.split("\n"), modified = initial.modified.split("\n");
  if (original.filter(line => line === spawnAnchor).length !== 1) throw new Error("Upstream spawning anchor changed; no speculative replacement was made.");
  const index = original.indexOf(spawnAnchor);
  modified[index] = "    var value = 4;";
  const start = Math.max(0, index - 3), end = Math.min(original.length, index + 4), size = end - start;
  const hunk = original.slice(start, end).map((line, offset) => start + offset === index ? `-${line}\n+${modified[index]}` : ` ${line}`).join("\n");
  return { modified: modified.join("\n"), patch: initial.patch + `@@ -${start + 1},${size} +${start + 1},${size} @@\n${hunk}\n` };
}
export function patchInitialTiles(source: string, count: number) {
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error("Initial tiles must be an integer from 2 to 8.");
  const anchor = "  this.startTiles     = 2;", lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.filter(line => line === anchor).length !== 1) throw new Error("Upstream patch anchor changed; no speculative replacement was made.");
  const index = lines.indexOf(anchor), replacement = `  this.startTiles     = ${count};`;
  const start = Math.max(0, index - 3), end = Math.min(lines.length, index + 4), size = end - start;
  const diff = lines.slice(start, end).map((line, offset) => start + offset === index ? `-${line}\n+${replacement}` : ` ${line}`).join("\n");
  const modified = [...lines]; modified[index] = replacement;
  return {
    modified: modified.join("\n") + (source.endsWith("\n") ? "\n" : ""),
    patch: `--- a/js/game_manager.js\n+++ b/js/game_manager.js\n@@ -${start + 1},${size} +${start + 1},${size} @@\n${diff}\n`,
  };
}
export type Source2048Bundle = Awaited<ReturnType<typeof create2048Mod>>;
export async function create2048Mod(initialTiles: number, fetcher: typeof safeFetch = safeFetch, spawnRule: SpawnRule = "original") {
  // Validate before making any network request.
  patchGameplay(`  this.startTiles     = 2;\n${spawnAnchor}`, initialTiles, spawnRule);
  const entries = await Promise.all(Object.entries(SOURCE_2048.files).map(async ([file, expected]) => {
    const url = `https://raw.githubusercontent.com/gabrielecirulli/2048/${SOURCE_2048.revision}/${file}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(10000) }, { policy: "public", maxRedirects: 0 });
    if (!response.ok || !response.body) throw new Error(`Official upstream source unavailable (${file}, HTTP ${response.status}); no patch was acknowledged.`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 65536) { await reader.cancel(); throw new Error("Upstream file exceeds 64 KiB acquisition bound."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks), content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes) || sha(content) !== expected) throw new Error(`Upstream integrity mismatch (${file}); original pin was preserved.`);
    return { path: file, url, sha256: expected, bytes: size, content };
  }));
  return assemble2048Mod(entries, initialTiles, spawnRule);
}
function assemble2048Mod(entries: { path: string; url: string; sha256: string; bytes: number; content: string }[], initialTiles: number, spawnRule: SpawnRule) {
  const original = entries.find(file => file.path === "js/game_manager.js")!;
  const changed = patchGameplay(original.content, initialTiles, spawnRule);
  return {
    version: 2, adapter: "2048-initial-tiles", upstream: SOURCE_2048.repository, revision: SOURCE_2048.revision,
    license: { spdx: "MIT", text: entries.find(file => file.path === "LICENSE.txt")!.content },
    analysis: [
      { path: "js/game_manager.js", role: "Owns setup/restart, tile spawning, movement, merging, scoring and win/loss. Supported changes: constructor startTiles and optional guaranteed-four spawning." },
      { path: "js/grid.js", role: "Board cells, bounds, insertion/removal, empty-cell discovery and serialization. Unchanged." },
      { path: "js/tile.js", role: "Tile identity, position/value and serialization. Unchanged." },
    ],
    files: entries,
    modification: { path: original.path, initialTiles, spawnRule, originalSha256: sha(original.content), modifiedSha256: sha(changed.modified), content: changed.modified, patch: changed.patch },
    verification: { acquisition: "four exact SHA-256 pins matched", patch: "exact supported anchors; reviewable unified diff", runtime: "not run for this acquisition; CI adapter acceptance is separate, not a per-output execution receipt" },
  };
}
/** Reconstruct from pinned bytes and supported parameters, never trust client
 * HTML, patches, hashes or serialized verification claims. No outbound fetch. */
export function validate2048Bundle(input: unknown): Source2048Bundle {
  if (!input || typeof input !== "object") throw new Error("Invalid source package.");
  const b = input as Source2048Bundle;
  if (![1, 2].includes(b.version) || b.upstream !== SOURCE_2048.repository || b.revision !== SOURCE_2048.revision || b.adapter !== "2048-initial-tiles" || !Array.isArray(b.files) || b.files.length !== 4) throw new Error("Unsupported source identity.");
  for (const [file, expected] of Object.entries(SOURCE_2048.files)) {
    const matches = b.files.filter(item => item.path === file);
    const f = matches[0];
    if (matches.length !== 1 || typeof f?.content !== "string" || f.content.length > 65536 || sha(f.content) !== expected || f.sha256 !== expected || f.bytes !== Buffer.byteLength(f.content) || f.url !== `https://raw.githubusercontent.com/gabrielecirulli/2048/${SOURCE_2048.revision}/${file}`) throw new Error("Source integrity mismatch.");
  }
  const legacy = b.version === 1;
  const rebuilt = assemble2048Mod(b.files, b.modification?.initialTiles, legacy ? "original" : b.modification?.spawnRule);
  const expected: Record<string, unknown> = { ...rebuilt.modification };
  if (legacy) delete expected.spawnRule;
  if (JSON.stringify(b.modification) !== JSON.stringify(expected) || JSON.stringify(b.license) !== JSON.stringify(rebuilt.license)) throw new Error("Modified source, patch or license mismatch.");
  return rebuilt;
}

/** Browser presentation adapter over real upstream GameManager/Grid/Tile.
 * Deliberately not the official UI: memory-only state, our canvas/input/storage
 * adapters. The actual upstream setup/move/merge/restart logic is unchanged
 * except for the explicitly packaged startTiles / spawning modifications.
 */
export function preview2048Mod(bundle: Source2048Bundle, baseline = false) {
  const scripts = ["js/tile.js", "js/grid.js", "js/game_manager.js"].map(file =>
    file === "js/game_manager.js" && !baseline ? bundle.modification.content : bundle.files.find(item => item.path === file)!.content,
  ).join("\n").replace(/<\/script/gi, "<\\/script");
  const escapedLicense = bundle.license.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html><head><title>2048 source workshop</title><style>body{background:#111827;color:white;font:16px sans-serif}canvas{display:block;border:1px solid #777}button{padding:8px}pre{white-space:pre-wrap}</style></head><body>
<h1>2048 · source workshop</h1><p>Gabriele Cirulli · MIT · revision ${SOURCE_2048.revision.slice(0, 12)}. Arena canvas adapter, memory-only board. ${baseline || bundle.modification.spawnRule === "original" ? "Original spawning: 90% two / 10% four." : "Guaranteed four-tile spawning."} Arrows move; R restarts.</p>
<button id="restart">Restart</button> Tiles <span id="tile-count">0</span> Score <span id="score">0</span><span id="state">playing</span>
<details><summary>Observed board values</summary><output id="board-values">[]</output></details>
<canvas id="game" width="360" height="360" tabindex="0"></canvas><details><summary>Upstream MIT notice</summary><pre>${escapedLicense}</pre></details>
<script>${scripts}
function ArenaInput(){this.events={};document.addEventListener('keydown',e=>{const d={ArrowUp:0,ArrowRight:1,ArrowDown:2,ArrowLeft:3}[e.key];if(d!==undefined){e.preventDefault();this.emit('move',d)}if(e.key==='r')this.emit('restart')});document.getElementById('restart').onclick=()=>this.emit('restart')}
ArenaInput.prototype.on=function(n,cb){this.events[n]=cb};ArenaInput.prototype.emit=function(n,v){if(this.events[n])this.events[n](v)};
let board=null,meta={score:0};function ArenaActuator(){}
ArenaActuator.prototype.continueGame=function(){};
ArenaActuator.prototype.actuate=function(g,m){board=g;meta=m;let count=0,values=[];g.eachCell((x,y,t)=>{if(t){count++;values.push({x,y,value:t.value})}});document.getElementById('board-values').textContent=JSON.stringify(values);document.getElementById('tile-count').textContent=count;document.getElementById('score').textContent=m.score;document.getElementById('state').textContent=m.won?'won':m.over?'lost':'playing'};
function ArenaStorage(){this.saved=null;this.best=0}
ArenaStorage.prototype.getGameState=function(){return this.saved};ArenaStorage.prototype.setGameState=function(s){this.saved=s};ArenaStorage.prototype.clearGameState=function(){this.saved=null};
ArenaStorage.prototype.getBestScore=function(){return this.best};ArenaStorage.prototype.setBestScore=function(n){this.best=n};
new GameManager(4,ArenaInput,ArenaActuator,ArenaStorage);
const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');let tick=0;
function loop(){tick++;ctx.fillStyle='#111827';ctx.fillRect(0,0,360,360);if(board)board.eachCell((x,y,t)=>{ctx.fillStyle=t?'#b45309':'#374151';ctx.fillRect(x*88+4,y*88+4,82,82);if(t){ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText(t.value,x*88+24,y*88+50)}});ctx.fillStyle='#64748b';ctx.fillRect(0,356,tick%360,2);requestAnimationFrame(loop)}requestAnimationFrame(loop);
</script></body></html>`;
}
