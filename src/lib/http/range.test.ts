import test from "node:test";
import assert from "node:assert/strict";
import { parseByteRange } from "./range";

test("HTTP single byte ranges preserve exact offsets including suffixes and large bounds", () => {
  assert.equal(parseByteRange(null, 100), null);
  for (const [value, start, end] of [
    ["bytes=0-0", 0, 0], ["bytes=10-", 10, 99], ["bytes=-10", 90, 99],
    ["bytes=-100", 0, 99], ["bytes=10-999", 10, 99],
    ["BYTES=1-2", 1, 2], [" bytes=01-02 ", 1, 2],
    [`bytes=-${"9".repeat(100)}`, 0, 99], [`bytes=1-${"9".repeat(100)}`, 1, 99],
  ] as const) assert.deepEqual(parseByteRange(value, 100), { start, end }, value);
});

test("malformed, multi-part, zero-length and unsatisfiable ranges never become file offsets", () => {
  for (const value of ["", "bytes=-", "bytes=-0", "bytes=100-", "bytes=100-100", "bytes=3-2", "bytes=0-1,2-3", "items=0-1", "bytes=+1-2", "bytes=1.5-2", "bytes=1-2-3", `bytes=${"9".repeat(100)}-`])
    assert.equal(parseByteRange(value, 100), "invalid", value);
  for (const size of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(parseByteRange("bytes=0-", size), "invalid");
});
