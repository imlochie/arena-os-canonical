import assert from "node:assert/strict";
import test from "node:test";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import { isRepositoryProvenance, withRepositoryAttribution, withoutRepositoryAttribution } from "./importedRepositoryAttribution";

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
  assert.equal(isRepositoryProvenance({ ...provenance, sourceUrl: "javascript:evil()" }), false);
});
