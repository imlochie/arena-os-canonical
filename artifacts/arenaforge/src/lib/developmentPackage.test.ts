import assert from "node:assert/strict";
import test from "node:test";
import { serializeDevelopmentPackage, hashDevelopment } from "./arcadeDevelopment";
import { composeMods, modKey, parseModPackage } from "@workspace/arena/lib/mod-workshop";

test("development package composes through the real Workshop and retains restricted AI lineage", async () => {
  const original = '<!doctype html><html><body><script>let score=1;</script></body></html>';
  const draft = original.replace("score=1", "score=5"), hash = await hashDevelopment(original);
  const json = await serializeDevelopmentPackage({ developmentId: crypto.randomUUID(), gameId: "fixture", title: "Original",
    original, draft, provenance: "Original authorized fixture", revision: 1, prompt: "Five points", modelId: "configured-fixture-not-inference",
    aiLineage: [{ modelId: "configured-fixture-not-inference", backend: "local-server", missionId: "wiring-only", draftHash: await hashDevelopment(draft) }] },
    { id: "fixture", identity: `html::${hash}`, title: "Original", version: `sha256:${hash}`, kind: "html", files: [{ path: "game.html", bytes: original.length, sha256: hash }] });
  const mod = await parseModPackage(json), files = { "game.html": new TextEncoder().encode(original) };
  const base = { id: `html::${hash}`, version: `sha256:${hash}`, kind: "html", files };
  const profile = { id: "separate-profile", name: "Development", enabled: [modKey(mod)], order: [modKey(mod)], settings: {}, shareSaves: false };
  const changed = await composeMods(base, [mod], profile);
  assert.equal(new TextDecoder().decode(changed.files["game.html"]), draft);
  assert.equal(new TextDecoder().decode(base.files["game.html"]), original);
  assert.equal(mod.manifest.license.redistributable, false);
  assert.match(mod.manifest.name, /AI-derived.*unverified/);
  assert.match(mod.manifest.license.text, /wiring-only/);
  const restored = await composeMods(base, [mod], { ...profile, enabled: [] });
  assert.equal(new TextDecoder().decode(restored.files["game.html"]), original);
});
