import test from "node:test";
import assert from "node:assert/strict";
import { createGameCatalog, parseBobeffCatalog, parseTrilarionCatalog, resolveTrilarionDetails } from "./game-catalog";
const bobeff = `# List\n## Puzzle games\n- **[Small game](https://example.org)** - Real game. [[source]](https://github.com/author/game)\n- **Unsafe** - Nope [[source]](javascript:alert)\n- **Same game** [[source]](https://github.com/author/game)\n## Other lists\n- **Not a game** [[source]](https://github.com/author/list)`;
const table = (count = 1) => JSON.stringify({ headings: [], data: [
  ['<a href="frameworks/game engine/A.html#lib">Library</a>', "", "engine", "Windows", "C", "MIT"],
  ...Array.from({ length: count }, (_, index) => [`<a href="games/A.html#game_${index}">Game &amp; ${index}</a><a href="https://wrong-homepage.example/">Home</a>`, "", "puzzle", "Windows, Linux", "C++", "GPL-3.0"]),
] });
test("catalog parsers exclude engines, unsafe links and duplicate source listings", () => {
  const a = parseBobeffCatalog(bobeff);
  assert.equal(a.length, 1); assert.equal(a[0].title, "Small game"); assert.equal(a[0].codeLicense, null);
  const b = parseTrilarionCatalog(table());
  assert.equal(b.length, 1); assert.equal(b[0].title, "Game & 0"); assert.equal(b[0].sourceUrl, null);
  assert.deepEqual(b[0].platforms, ["Windows", "Linux"]);
});
test("resolve uses labelled source repository, not download/homepage or another game", () => {
  const entry = parseTrilarionCatalog(table())[0];
  const html = `<div id="game_0"><a href="https://wrong-homepage.example/">Home</a>Downloads: <a href="https://github.com/wrong/download">Download</a><br>Code repositories: <a href="https://github.com/right/source.git">Source</a><br>Assets license: CC0<br></div><div id="other">Code repositories: <a href="https://github.com/wrong/next">Other</a><br></div>`;
  const result = resolveTrilarionDetails(entry, html);
  assert.equal(result.sourceUrl, "https://github.com/right/source");
  assert.equal(result.assetLicense, "CC0");
  assert.equal(resolveTrilarionDetails(entry, `<div id="game_0">Code repository: <a href="javascript:bad">Bad</a><br></div>`).sourceUrl, null);
  assert.throws(() => resolveTrilarionDetails(entry, '<div id="moved">'), /moved/);
});
test("bounded search is paginated, cached and explicit about a partial outage", async () => {
  let calls = 0, clock = 1;
  const service = createGameCatalog(async url => { calls++; if (url.includes("bobeff")) throw new Error("offline"); return Buffer.from(table(35)); }, () => clock);
  const result = await service.search("game", "all", 0);
  assert.equal(result.entries.length, 30); assert.equal(result.total, 35); assert.equal(result.hasMore, true);
  assert.equal(result.sources.find(source => source.catalog === "bobeff")!.available, false);
  assert.equal((await service.search("game", "all", 30)).entries.length, 5);
  assert.equal(calls, 2);
  await assert.rejects(service.search("a".repeat(81), "all", 0), /80/);
  await assert.rejects(service.search("", "https://attacker/", 0), /valid/);
  await assert.rejects(service.resolve("https://localhost/private"), /Choose/);
  clock += 60_001; await service.search("game", "all", 0);
  assert.equal(calls, 3, "failed source refresh retries are cached without re-fetching the healthy source");
});
test("detail resolution only fetches fixed raw GitHub catalog data and caches it", async () => {
  const urls: string[] = [];
  const service = createGameCatalog(async url => { urls.push(url); return Buffer.from(url.endsWith("entries.json") ? table() : '<div id="game_0">Code repository: <a href="https://github.com/owner/game">Source</a><br></div>'); });
  const entry = (await service.search("", "trilarion", 0)).entries[0];
  assert.equal((await service.resolve(entry.id)).sourceUrl, "https://github.com/owner/game");
  await service.resolve(entry.id);
  assert.equal(urls.length, 2); assert.ok(urls.every(url => url.startsWith("https://raw.githubusercontent.com/Trilarion/opensourcegames/")));
});
