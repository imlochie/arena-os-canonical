import assert from "node:assert/strict";
import test from "node:test";
import { camelotCodeForKey, camelotCompatibleCodes, CAMELOT_CELLS } from "./camelot-wheel";

test("maps the normalized musical-key vocabulary to Camelot slots", () => {
  assert.equal(CAMELOT_CELLS.length, 24);
  assert.equal(camelotCodeForKey("A minor"), "8A");
  assert.equal(camelotCodeForKey("C major"), "8B");
  assert.equal(camelotCodeForKey("Db major"), "3B");
  assert.equal(camelotCodeForKey("F# minor"), "11A");
  assert.equal(camelotCodeForKey("G# minor"), "1A");
  assert.equal(camelotCodeForKey("not a key"), null);
  assert.equal(camelotCodeForKey(null), null);
});

test("returns same-slot, relative-mode, and adjacent-number Camelot matches", () => {
  assert.deepEqual(camelotCompatibleCodes("8A"), ["8A", "8B", "7A", "9A"]);
  assert.deepEqual(camelotCompatibleCodes("12B"), ["12B", "12A", "11B", "1B"]);
  assert.deepEqual(camelotCompatibleCodes("invalid"), []);
});
