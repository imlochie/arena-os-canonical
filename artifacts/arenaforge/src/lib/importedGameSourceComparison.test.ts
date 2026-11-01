import assert from "node:assert/strict";
import { test } from "node:test";
import { compareImportedGameSource, SOURCE_COMPARISON_CHAR_LIMIT, SOURCE_COMPARISON_ROW_LIMIT } from "./importedGameSourceComparison";

test("unchanged source is identified exactly, including embedded data", () => {
  const source = '<img src="data:image/png;base64,AAAA">';
  const result = compareImportedGameSource(source, source);
  assert.equal(result.identical, true);
  assert.equal(result.embeddedAssets, 1);
  assert.equal(result.added + result.removed, 0);
});

test("line diff shows separate changes, stable context and before/after line numbers", () => {
  const result = compareImportedGameSource("a\nold\nsame\nlast", "a\nnew\nsame\nextra\nlast");
  assert.deepEqual(result.rows.filter(row => row.kind === "removed").map(row => [row.text, row.beforeLine]), [["old", 2]]);
  assert.deepEqual(result.rows.filter(row => row.kind === "added").map(row => [row.text, row.afterLine]), [["new", 2], ["extra", 4]]);
  assert.deepEqual(result.rows.find(row => row.text === "last"), { kind: "same", text: "last", beforeLine: 4, afterLine: 5 });
});

test("deletions and insertions remain readable without modifying or executing markup", () => {
  const previous = '<h1>Before</h1>\n<script>globalThis.notExecuted=1</script>';
  const current = '<h1>After 🎮</h1>';
  const result = compareImportedGameSource(previous, current);
  assert.equal(result.rows.some(row => row.kind === "added" && row.text.includes("After 🎮")), true);
  assert.equal(result.rows.some(row => row.kind === "removed" && row.text.includes("<script>")), true);
  assert.equal((globalThis as Record<string, unknown>).notExecuted, undefined);
  assert.equal(previous.includes("<script>"), true);
});

test("same-size changed media gets a different label; identical media shares one", () => {
  const result = compareImportedGameSource('<img src="data:image/png;base64,AAAA">', '<img src="data:image/png;base64,BBBB">');
  assert.equal(result.identical, false);
  assert.equal(result.displayIdentical, false);
  assert.equal(result.embeddedAssets, 2);
  assert.match(result.rows.find(row => row.kind === "removed")!.text, /embedded data #1/);
  assert.match(result.rows.find(row => row.kind === "added")!.text, /embedded data #2/);
  assert.equal(result.rows.some(row => /AAAA|BBBB/.test(row.text)), false);
});

test("line-ending-only changes are not falsely reported as identical source", () => {
  const result = compareImportedGameSource("one\r\ntwo", "one\ntwo");
  assert.equal(result.identical, false);
  assert.equal(result.displayIdentical, true);
});

test("large minified source is excerpted around its late change, not blindly at the start", () => {
  const prefix = "x".repeat(SOURCE_COMPARISON_CHAR_LIMIT + 1000);
  const result = compareImportedGameSource(`${prefix}old`, `${prefix}new`);
  assert.equal(result.truncated, true);
  assert.match(result.rows.find(row => row.kind === "removed")!.text, /old$/);
  assert.match(result.rows.find(row => row.kind === "added")!.text, /new$/);
  assert.ok(result.rows.every(row => row.text.length <= SOURCE_COMPARISON_CHAR_LIMIT));
});

test("large changed blocks use bounded coarse output and retain both sides", () => {
  const result = compareImportedGameSource(Array.from({ length: 800 }, (_, i) => `old${i}`).join("\n"), Array.from({ length: 800 }, (_, i) => `new${i}`).join("\n"));
  assert.equal(result.coarse, true);
  assert.equal(result.truncated, true);
  assert.ok(result.rows.length <= SOURCE_COMPARISON_ROW_LIMIT);
  assert.equal(result.rows.some(row => row.kind === "removed"), true);
  assert.equal(result.rows.some(row => row.kind === "added"), true);
  assert.equal(result.rows.some(row => row.kind === "gap" && row.text.includes("omitted")), true);
});

test("long unchanged context is collapsed without hiding separated changes", () => {
  const middle = Array.from({ length: 100 }, (_, i) => `same${i}`).join("\n");
  const result = compareImportedGameSource(`old-first\n${middle}\nold-last`, `new-first\n${middle}\nnew-last`);
  assert.equal(result.truncated, false);
  assert.equal(result.rows.some(row => row.kind === "gap" && row.text.includes("unchanged")), true);
  assert.deepEqual(result.rows.filter(row => row.kind === "removed").map(row => row.text), ["old-first", "old-last"]);
  assert.deepEqual(result.rows.filter(row => row.kind === "added").map(row => row.text), ["new-first", "new-last"]);
});

test("source excerpts use a shared start even when only the new side exceeds the limit", () => {
  const prefix = "shared\n".repeat(100);
  const result = compareImportedGameSource(`${prefix}old`, `${prefix}${"added\n".repeat(30_000)}`);
  assert.equal(result.truncated, true);
  assert.equal(result.rows.filter(row => row.kind === "removed").some(row => row.text === "shared"), false);
});
