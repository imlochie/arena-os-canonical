import assert from "node:assert/strict";
import test from "node:test";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import { isRepositoryProvenance, readRepositoryAttribution, resolveRepositoryAttribution, withRepositoryAttribution, withoutRepositoryAttribution } from "./importedRepositoryAttribution";

const origin = { repository: "author/game", revision: "a".repeat(40), sourceUrl: `https://github.com/author/game/tree/${"a".repeat(40)}`,
  license: { spdx: "MIT", path: "LICENSE", text: "Copyright original game author" } };

test("source and edited-source exports keep one inert attribution record without replacement expansion", () => {
  const provenance = { repository: "author/game", revision: "a".repeat(40), sourceUrl: `https://github.com/author/game/tree/${"a".repeat(40)}`,
    license: { spdx: "MIT", path: "LICENSE", text: 'Copyright $& $1 </script><script>evil()</script>' } };
  const source = "<!doctype html><html><body><canvas></canvas></body></html>";
  const result = withRepositoryAttribution(source, provenance);
  assert.equal(importedHtmlSafetyIssue(result), null);
  const payload = JSON.parse(result.match(/id="arena-repository-attribution">([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(payload, provenance);
  assert.equal(withoutRepositoryAttribution(result), source);
  assert.equal((withRepositoryAttribution(result, provenance).match(/id="arena-repository-attribution"/g) ?? []).length, 1);
  assert.equal(isRepositoryProvenance(provenance), true);
  assert.equal(isRepositoryProvenance({ ...provenance, sourceUrl: `https://codeberg.org/author/game/src/commit/${"a".repeat(40)}` }), true);
  assert.equal(isRepositoryProvenance({ ...provenance, sourceUrl: "javascript:evil()" }), false);
});

test("exported HTML recovers its origin before reimport and retains it through a later edit", () => {
  const exported = withRepositoryAttribution("<html><body>Original</body></html>", origin);
  const recovered = resolveRepositoryAttribution(exported);
  assert.deepEqual(recovered, origin);
  const imported = withRepositoryAttribution(exported, recovered);
  const edited = withRepositoryAttribution("<html><body>New gameplay</body></html>", recovered);
  assert.deepEqual(readRepositoryAttribution(imported), origin);
  assert.deepEqual(readRepositoryAttribution(edited), origin);
  assert.match(edited, /New gameplay/);
  assert.equal((imported.match(/id="arena-repository-attribution"/g) ?? []).length, 1);
});

test("invalid and conflicting notices cannot silently replace the source or license", () => {
  const exported = withRepositoryAttribution("<html><body>Game</body></html>", origin);
  assert.throws(() => resolveRepositoryAttribution(exported, { ...origin, license: { ...origin.license, text: "Different notice" } }), /not be overwritten/i);
  assert.throws(() => readRepositoryAttribution(exported + exported), /multiple/i);
  assert.throws(() => readRepositoryAttribution('<script type="application/json" id="arena-repository-attribution">{broken</script>'), /malformed/i);
  assert.throws(() => readRepositoryAttribution(`<script id="arena-repository-attribution">${JSON.stringify(origin)}</script>`), /inert JSON/i);
  const unsafe = { ...origin, sourceUrl: "javascript:alert(1)" };
  assert.throws(() => readRepositoryAttribution(`<script type="application/json" id="arena-repository-attribution">${JSON.stringify(unsafe)}</script>`), /invalid source/i);
  assert.deepEqual(resolveRepositoryAttribution(exported, origin), origin);
});

test("unrelated scripts and marker-like strings in attributes remain intact", () => {
  const unrelated = `<script data-id="arena-repository-attribution">window.game=1;</script><script title=' id="arena-repository-attribution" '>window.other=2;</script>`;
  assert.equal(readRepositoryAttribution(unrelated), undefined);
  assert.equal(withoutRepositoryAttribution(unrelated), unrelated);
  const reordered = `<script id='arena-repository-attribution' data-note="a > b" type='application/json'>${JSON.stringify(origin)}</script>`;
  assert.deepEqual(readRepositoryAttribution(reordered), origin);
  assert.equal(withoutRepositoryAttribution(reordered), "");
});
