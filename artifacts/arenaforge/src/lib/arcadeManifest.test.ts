import assert from "node:assert/strict";
import { test } from "node:test";
import { addArcadeObservation, arcadeContentVersion, assessArcadeRuntime, createArcadeManifest, currentArcadeEvidence, validArcadeManifest, type ArcadeGameDescriptor, type ArcadeHost } from "./arcadeManifest";
import { browserChip8Adapter, browserHtmlAdapter, browserEmulatorJsAdapter, discoverArcadeRuntimeAdapters, identifyArcadeRuntimeAdapter, registerArcadeRuntimeAdapter } from "./arcadeRuntimeAdapters";
import { arcadeManifestKey } from "./arcadeManifestStorage";
const host: ArcadeHost = { id: "fixture-browser", kind: "browser", platform: "test", architecture: "browser-managed", capabilities: { dom: true, canvas2d: true, wasm: true, storage: true } };
const game: ArcadeGameDescriptor = { id: "keep-identity", title: "Original", source: "<html><body>Original</body></html>", format: "html", scope: "imported-private", trust: "imported-code", stored: true, addedAt: 123, sourceRevisionCopies: 3 };
test("manifest retains identity, trust, provenance, save aliases and bounded legacy history references without source bytes", async () => {
  const manifest = await createArcadeManifest({ ...game, saveId: "retained-save-slot", provenance: { repository: "owner/game", revision: "pinned", sourceUrl: "https://github.com/owner/game", license: { spdx: "MIT", text: "notice" } } }, browserHtmlAdapter.definition, host);
  assert.equal(validArcadeManifest(manifest), true);
  assert.equal(manifest.id, game.id);
  assert.equal(manifest.sourceRevisionCopies, 3);
  assert.match(manifest.locations.saves[0], /retained-save-slot$/);
  assert.equal(manifest.provenance.revision, "pinned");
  assert.equal(manifest.license.status, "declared");
  assert.equal(JSON.stringify(manifest).includes("<html>"), false);
  assert.equal(manifest.evidence[0].stage, "installed");
  assert.equal(manifest.evidence.some(e => e.stage === "startup" || e.stage === "gameplay"), false);
});
test("each stage is independent and evidence cannot survive host, game, profile or runtime version changes", async () => {
  const initial = await createArcadeManifest(game, browserHtmlAdapter.definition, host);
  const observed = addArcadeObservation(initial, host, "startup", "Observed startup");
  assert.equal(currentArcadeEvidence(observed, host, "startup")?.origin, "user-observation");
  assert.equal(currentArcadeEvidence(observed, host, "gameplay"), undefined);
  assert.equal(currentArcadeEvidence(observed, { ...host, id: "another-host" }, "startup"), undefined);
  assert.equal(currentArcadeEvidence({ ...observed, installedVersion: await arcadeContentVersion("edited") }, host, "startup"), undefined);
  assert.equal(currentArcadeEvidence({ ...observed, runtime: { ...observed.runtime, version: "new" } }, host, "startup"), undefined);
  assert.equal(currentArcadeEvidence({ ...observed, runtime: { ...observed.runtime, profile: "different" } }, host, "startup"), undefined);
});
test("runtime absence and host requirements are specific blockers, not fake playable entries", async () => {
  const manifest = await createArcadeManifest(game, browserHtmlAdapter.definition, host);
  assert.equal(assessArcadeRuntime(undefined, manifest, host).available, false);
  assert.match(assessArcadeRuntime(undefined, manifest, host).blockers[0], /not registered/);
  assert.equal(assessArcadeRuntime(browserHtmlAdapter.definition, manifest, { ...host, kind: "native" }).available, false);
  const chip = await createArcadeManifest({ ...game, format: "chip8", profile: "chip8", trust: "rom" }, browserChip8Adapter.definition, host);
  chip.requirements = []; // Imported metadata cannot remove adapter's requirements.
  assert.equal(assessArcadeRuntime(browserChip8Adapter.definition, chip, { ...host, capabilities: { dom: true } }).available, false);
  assert.equal(assessArcadeRuntime(browserHtmlAdapter.definition, manifest, { ...host, capabilities: { dom: true } }).available, true);
});
test("discovery is extensible rather than a console enumeration; registration alone supplies no game evidence", async () => {
  const before = discoverArcadeRuntimeAdapters().length;
  const unregister = registerArcadeRuntimeAdapter({
    definition: { ...browserHtmlAdapter.definition, id: "test.custom-runtime", name: "Custom runtime", hosts: ["test-host"] },
    identify: descriptor => descriptor.format === "test-format",
    provision: async () => ({ state: "unavailable", detail: "Test contract only, no executable provisioned" }),
    diagnostics: () => ({ available: false, blockers: ["No executable"], warnings: [] }),
  });
  assert.equal(identifyArcadeRuntimeAdapter({ ...game, format: "test-format" })?.definition.id, "test.custom-runtime");
  assert.equal(discoverArcadeRuntimeAdapters().length, before + 1);
  unregister();
  assert.equal(identifyArcadeRuntimeAdapter({ ...game, format: "test-format" }), undefined);
});
test("concrete adapters execute existing sandbox and interpreter; external cores remain delegated", async () => {
  const document = browserHtmlAdapter.launch({ source: "<html><head></head><body>Original</body></html>", saveId: "same-slot" });
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /same-slot/);
  const runtime = browserChip8Adapter.launch({ rom: new Uint8Array([0x60, 0x2a]), dialect: "chip8" });
  runtime.step();
  assert.equal(runtime.registers[0], 42);
  runtime.setKey(1, true); browserChip8Adapter.cleanup(runtime);
  assert.equal(runtime.keys[1], 0);
  assert.equal((await browserEmulatorJsAdapter.provision(host)).state, "delegated");
  assert.equal(browserEmulatorJsAdapter.launch({ system: "gb", gameId: "original-id" }).dataUrl, "https://cdn.emulatorjs.org/4.2.3/data/");
});
test("schema rejects malformed metadata and version keys cannot alias source versions or ownership", async () => {
  const manifest = await createArcadeManifest(game, browserHtmlAdapter.definition, host);
  for (const invalid of [null, [], { ...manifest, schemaVersion: 2 }, { ...manifest, runtime: null }, { ...manifest, installedVersion: "claimed-ready" },
    { ...manifest, evidence: [{ stage: "ready" }] }, { ...manifest, profiles: [] }]) assert.equal(validArcadeManifest(invalid), false);
  const changed = await createArcadeManifest({ ...game, source: "new source" }, browserHtmlAdapter.definition, host);
  assert.notEqual(arcadeManifestKey(manifest), arcadeManifestKey(changed));
  assert.notEqual(arcadeManifestKey(manifest), arcadeManifestKey({ ...manifest, ownership: "created" }));
});
