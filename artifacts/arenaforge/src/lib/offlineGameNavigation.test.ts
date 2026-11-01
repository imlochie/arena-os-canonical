import assert from "node:assert/strict";
import test from "node:test";
import { neutralizeOfflineNavigation, prepareOfflineHtml } from "./offlineGameNavigation";

test("offline credits retain text and original URL as inert text, while game fragments remain", () => {
  const element = (attributes: Record<string, string>) => {
    const values = new Map(Object.entries(attributes));
    return { getAttribute: (key: string) => values.get(key) ?? null,
      setAttribute: (key: string, value: string) => { values.set(key, value); },
      removeAttribute: (key: string) => { values.delete(key); }, values };
  };
  const credit = element({ href: "https://author.example/", target: "_blank", ping: "https://tracker.example/" });
  const control = element({ href: "#restart", ping: "https://tracker.example/" });
  neutralizeOfflineNavigation({ querySelectorAll: () => [credit, control] } as unknown as Document);
  assert.equal(credit.values.has("href"), false); assert.equal(credit.values.has("target"), false);
  assert.ok(credit.values.get("title")!.includes("https://author.example/"));
  assert.equal(control.values.get("href"), "#restart");
  assert.equal(control.values.has("ping"), false);
});
test("raw HTML resource/code rejection happens before constructing a DOM parser", () => {
  const global = globalThis as unknown as { DOMParser?: typeof DOMParser };
  const original = global.DOMParser;
  global.DOMParser = class { constructor() { throw new Error("must not parse unsafe source"); } } as typeof DOMParser;
  try {
    for (const html of [
      '<html><a href="https://credits.example/">Credits</a><img src="https://remote.example/pixel"></html>',
      '<html><a href="https://credits.example/">Credits</a><script>fetch("/private")</script></html>',
      '<html><script src="&#104;ttps://remote.example/game.js"></script></html>',
      "Not a complete HTML game",
    ]) assert.equal(prepareOfflineHtml(html), html);
  } finally {
    if (original) global.DOMParser = original; else delete global.DOMParser;
  }
});
