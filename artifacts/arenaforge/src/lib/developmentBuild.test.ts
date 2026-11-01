import assert from "node:assert/strict";
import test from "node:test";
import { validateDevelopmentSource } from "./developmentBuild";

const source = '<!doctype html><html><body><script>let score=0; score+=1;</script></body></html>';
test("offline development parses scripts without network or execution", () => {
  assert.equal(validateDevelopmentSource(source, source.replace("score+=1", "score+=5")).ok, true);
  assert.match(validateDevelopmentSource(source, source.replace("score+=1", "score+=;;")).diagnostics.join(" "), /syntax/);
  assert.equal(validateDevelopmentSource(source, source).ok, false);
  assert.equal(validateDevelopmentSource(source, source.replace("score+=1", "fetch('https://example.org/')")).ok, false);
  assert.equal(validateDevelopmentSource(source, source.replace("score+=1", 'throw new Error("Would execute if this were not a parser")')).ok, true);
});
