import test from "node:test";
import assert from "node:assert/strict";
import { parseArtifactReference } from "./handoffs";
test("immutable Artifact references require two valid IDs and never reinterpret bare, mutable or foreign-kind references", () => {
  const id = "12345678-1234-1234-1234-123456789abc", revisionId = "abcdef12-1234-1234-1234-123456789abc";
  assert.deepEqual(parseArtifactReference(`artifact:${id}@${revisionId}`), { artifactId: id, revisionId });
  for (const input of [id, `artifact:${id}`, `artifact:${id}@latest`, `artifact:bad@${revisionId}`, `battle:${id}@${revisionId}`, `artifact:${id}@${revisionId}@extra`, ""]) assert.equal(parseArtifactReference(input), null);
});
