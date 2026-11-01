import { createHash } from "node:crypto";
export const fixtureHtml = '<!doctype html><html><head><title>Original Workshop Fixture</title></head><body style="background:#163a5f;color:white;font-family:sans-serif;padding:30px"><h1>ORIGINAL FIXTURE</h1><p>This original, authorized fixture is MIT licensed.</p><button id="score">Collect coin</button><p id="count"></p><script>let count=Number(localStorage.getItem("coins")||0);const output=document.getElementById("count");function draw(){output.textContent="Coins: "+count}document.getElementById("score").onclick=function(){count++;localStorage.setItem("coins",String(count));draw()};draw()</script></body></html>';
const sha = value => createHash("sha256").update(value).digest("hex");
/** Original fixture only; no external game assets or commercial ROMs. */
export function workshopFixturePackages(source = fixtureHtml) {
  const original = Buffer.from(source), modified = Buffer.from(source.replace("#163a5f", "#156b3f").replace("ORIGINAL FIXTURE", "MODIFIED FIXTURE"));
  const length = modified.length;
  if (length > 65535) throw new Error("Fixture is too large.");
  const ips = Buffer.concat([Buffer.from("PATCH"), Buffer.from([0, 0, 0, length >> 8, length & 255]), modified, Buffer.from("EOF")]);
  const make = (id, kind, patch) => JSON.stringify({ manifest: {
    schema: "arena.arcade.mod", schemaVersion: 1, id, name: "Green coin fixture", version: "1.0.0",
    license: { spdx: "MIT", text: "Copyright 2026. Original Arena test fixture. Permission is hereby granted to use, copy, modify, merge, publish, distribute, sublicense, and sell this fixture and its original patch payload, without warranty.", redistributable: true },
    source: { kind: "local" }, base: { id: `html::${sha(original)}`, version: `sha256:${sha(original)}`, files: { "game.html": sha(original) } },
    adapter: kind, permissions: ["patch-binary"], requires: [], conflicts: [], after: [], settings: {},
    operations: [{ kind, target: "game.html", payload: `colour.${kind}`, baseSha256: sha(original), resultSha256: sha(modified) }],
    payloads: { [`colour.${kind}`]: sha(patch) },
  }, files: { [`colour.${kind}`]: patch.toString("base64") } });
  const json = make("green-fixture", "ips", ips), bad = JSON.parse(json);
  bad.manifest.operations[0].resultSha256 = "0".repeat(64);
  return { html: source, modified: modified.toString(), json, badJson: JSON.stringify(bad) };
}
