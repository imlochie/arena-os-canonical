import assert from "node:assert/strict";
import test from "node:test";
import { archiveStylesheetImports } from "./offlineGameStyles";
test("CSS imports include unquoted url fonts and preserve media qualifiers", () => {
  const css = '@import url(fonts/clear-sans.css); @import "mobile.css" screen and (max-width: 600px); @import url(\'print.css\') print;';
  assert.deepEqual(archiveStylesheetImports(css).map(({ reference, media }) => ({ reference, media })), [
    { reference: "fonts/clear-sans.css", media: "" },
    { reference: "mobile.css", media: "screen and (max-width: 600px)" },
    { reference: "print.css", media: "print" },
  ]);
});
