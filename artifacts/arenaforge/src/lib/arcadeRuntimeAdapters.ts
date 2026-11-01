import type { ButtonKey, NES } from "jsnes";
import { createGameSandboxDocument } from "./arcadeGameSave";
import { Chip8Runtime, type Chip8Dialect } from "./chip8Runtime";
import { ARCADE_EMULATOR_SYSTEMS, EMULATORJS_VERSION, EMULATORJS_DATA_URL, arcadeEmulatorGameKey, type ArcadeEmulatorSystemId } from "./arcadeEmulatorRuntime";
import { assessArcadeRuntime, type ArcadeRuntimeDefinition, type ArcadeGameDescriptor, type ArcadeHost, type ArcadeManifest } from "./arcadeManifest";
import { getNativeBridge, type NativeArcadeBridge } from "../components/nativeArcadeTypes";

export type ArcadeProvisioning = { state: "available" | "delegated" | "unavailable"; detail: string };
/** Concrete sessions retain their native input/render/save interfaces. Their
 * React owner cancels animation/listeners before calling adapter cleanup. */
export type ArcadeRuntimeAdapter<Request, Session> = {
  definition: ArcadeRuntimeDefinition;
  identify: (game: ArcadeGameDescriptor) => boolean;
  provision: (host: ArcadeHost, signal?: AbortSignal) => Promise<ArcadeProvisioning>;
  launch: (request: Request) => Session;
  cleanup: (session: Session) => void | Promise<void>;
  diagnostics: (manifest: ArcadeManifest, host: ArcadeHost) => ReturnType<typeof assessArcadeRuntime>;
};
type DiscoverableAdapter = Pick<ArcadeRuntimeAdapter<never, never>, "definition" | "identify" | "provision" | "diagnostics">;
const registry = new Map<string, DiscoverableAdapter>();
export function registerArcadeRuntimeAdapter(adapter: DiscoverableAdapter) {
  if (!adapter.definition.id || registry.has(adapter.definition.id)) throw new Error("A runtime adapter must have a unique stable ID.");
  registry.set(adapter.definition.id, adapter);
  return () => { if (registry.get(adapter.definition.id) === adapter) registry.delete(adapter.definition.id); };
}
export const discoverArcadeRuntimeAdapters = () => [...registry.values()];
export const findArcadeRuntimeAdapter = (id: string) => registry.get(id);
export const identifyArcadeRuntimeAdapter = (game: ArcadeGameDescriptor) => [...registry.values()].find(adapter => adapter.identify(game));
const localPermissions = { execution: "untrusted restricted iframe", network: "none", allowedOrigins: [] as string[], filesystem: "browser-owned only" };
const requirements = (canvas = false) => [
  { capability: "dom", reason: "A browser DOM host is required.", optional: false },
  ...(canvas ? [{ capability: "canvas2d", reason: "This runtime needs Canvas 2D rendering.", optional: false }] : []),
  { capability: "storage", reason: "Browser storage is unavailable; progress and metadata may not survive closing this page.", optional: true },
];
function definition(id: string, name: string, version: string, mode: ArcadeRuntimeDefinition["provision"]["mode"], interfaces: ArcadeRuntimeDefinition["interfaces"], canvas = false): ArcadeRuntimeDefinition {
  return {
    id, name, version, hosts: ["browser"], architectures: ["browser-managed"],
    provision: { mode, detail: mode === "bundled" ? "Included with Arena; no model or WebGPU required." : mode === "lazy-module" ? "Load the installed JS module on selection; not proof that a ROM is compatible." : "Pinned runtime assets fetched by the existing player; no simulated installation." },
    interfaces, requirements: requirements(canvas), permissions: localPermissions,
    cleanup: "Owner cancels animation, timers and input listeners; adapter releases session-owned resources.",
    recovery: "Reload from existing per-game browser storage or explicitly restore a compatible backup; no automatic source/progress reset.",
  };
}
function contract<Request, Session>(definition: ArcadeRuntimeDefinition, identify: (game: ArcadeGameDescriptor) => boolean,
  launch: (request: Request) => Session, cleanup: (session: Session) => void,
  provision?: ArcadeRuntimeAdapter<Request, Session>["provision"]): ArcadeRuntimeAdapter<Request, Session> {
  return { definition, identify, launch, cleanup,
    provision: provision ?? (async (host, signal) => {
      signal?.throwIfAborted();
      return { state: host.kind === "browser" ? "available" : "unavailable", detail: definition.provision.detail };
    }),
    diagnostics: (manifest, host) => assessArcadeRuntime(definition, manifest, host),
  };
}
export const browserHtmlAdapter = contract(
  definition("arena.browser.html", "Restricted browser game", "1", "bundled", {
    input: "Game-owned keyboard/pointer/touch handlers", audio: "Game-owned Web Audio/media, subject to browser gesture policy",
    graphics: "DOM / Canvas in opaque-origin iframe", persistence: "Existing per-save-slot localStorage bridge, 64 KiB cap",
    mods: "Authorized HTML source revisions; native mod loaders unavailable",
  }),
  game => game.format === "html",
  ({ source, saveId }: { source: string; saveId: string }) => createGameSandboxDocument(source, saveId),
  () => { /* srcDoc owns no external resources; the owner removes its iframe. */ },
);
export const browserNesAdapter = contract(
  definition("arena.browser.jsnes", "JSNES", "2.1.0", "lazy-module", {
    input: "JSNES buttonDown/buttonUp; existing keyboard and touch mapping", audio: "Not connected: existing onAudioSample callback discards audio",
    graphics: "256×240 frame callback to Canvas 2D", persistence: "Existing NES IndexedDB snapshots and browser battery RAM",
    mods: "ROM source editing and patch management not implemented",
  }, true),
  game => game.format === "ines",
  async ({ binary, options }: { binary: string; options: ConstructorParameters<typeof NES>[0] }) => {
    const { NES } = await import("jsnes");
    const machine = new NES(options);
    machine.loadROM(binary);
    return machine;
  },
  (session: Promise<NES>) => { void session.then(machine => {
    for (const player of [1, 2] as const) for (let button = 0; button < 8; button++) machine.buttonUp(player, button as ButtonKey);
  }).catch(() => {}); },
  async (host, signal) => {
    signal?.throwIfAborted();
    if (host.kind !== "browser") return { state: "unavailable", detail: "JSNES requires the browser host." };
    await import("jsnes"); signal?.throwIfAborted();
    return { state: "available", detail: "JSNES module loaded. Per-ROM mapper and gameplay compatibility are still unverified." };
  },
);
export const browserChip8Adapter = contract(
  definition("arena.browser.chip8", "Arena CHIP-8 / Super-CHIP", "1", "bundled", {
    input: "Runtime setKey with existing keyboard/touch bindings", audio: "Sound timer is preserved but beep output is not connected",
    graphics: "64×32 classic or 128×64 Super-CHIP Canvas 2D", persistence: "Existing classic v1 / Super-CHIP v2 snapshots and local portable files",
    mods: "No ROM patch executor; editable-source remakes are a separate workflow",
  }, true),
  game => game.format === "chip8",
  ({ rom, snapshot, dialect }: { rom: Uint8Array; snapshot?: unknown; dialect: Chip8Dialect }) => new Chip8Runtime(rom, snapshot, dialect),
  (machine: Chip8Runtime) => { machine.keys.fill(0); machine.soundTimer = 0; },
);
export const browserEmulatorJsAdapter = contract(
  { ...definition("arena.browser.emulatorjs", "EmulatorJS", EMULATORJS_VERSION, "external-assets", {
    input: "Existing core keyboard/gamepad/touch controls menu", audio: "Runtime-owned browser audio, subject to autoplay permission",
    graphics: "Core-owned Canvas/WebAssembly rendering", persistence: "Delegate to EmulatorJS browser storage; do not register telemetry-only save/load hooks",
    mods: "Core/game-specific capabilities not managed by Arcade yet",
  }, true), requirements: [...requirements(true), { capability: "wasm", reason: "EmulatorJS needs WebAssembly support.", optional: false }],
    permissions: { execution: "Trusted third-party runtime interprets untrusted ROM data", network: "runtime assets", allowedOrigins: ["https://cdn.emulatorjs.org"], filesystem: "Runtime-owned same-origin browser storage" } },
  game => game.format.startsWith("emulatorjs:") && Object.hasOwn(ARCADE_EMULATOR_SYSTEMS, game.format.split(":")[1]),
  ({ system, gameId }: { system: ArcadeEmulatorSystemId; gameId: string }) => ({
    ...ARCADE_EMULATOR_SYSTEMS[system], dataUrl: EMULATORJS_DATA_URL, gameKey: arcadeEmulatorGameKey(gameId),
  }),
  () => { /* Existing player owner revokes its ROM blob and removes the iframe. */ },
  async (host, signal) => {
    signal?.throwIfAborted();
    return { state: host.kind === "browser" && host.capabilities.wasm ? "delegated" : "unavailable",
      detail: "The existing player loads pinned CDN assets. Download/cache success is unknown until that player reports it; no core installation is claimed." };
  },
);
type NativeSession = Promise<{ bridge: NativeArcadeBridge; id: string | null }>;
export const nativeWindowsAdapter: ArcadeRuntimeAdapter<{ key: string; bridge: NativeArcadeBridge }, NativeSession> = {
  definition: {
    id: "arena.desktop.windows-lpac", version: "1", name: "Windows LPAC native host", hosts: ["desktop"], architectures: ["x64"],
    provision: { mode: "external-assets", detail: "Independently pinned native packages; no hosted execution and no host-jail fallback." },
    interfaces: { input: "Game-owned native window", audio: "OS output; per-game compatibility requires real execution",
      graphics: "Game-owned renderer", persistence: "Separate private per-game profile", mods: "No game-specific mod loader in this adapter" },
    cleanup: "Owned supervisor stop/EOF and kill-on-close Job", recovery: "Retry verified packages; logs and profiles retained",
    requirements: [{ capability: "native-lpac-isolation", reason: "A real Windows LPAC/Job probe must pass.", optional: false }],
    permissions: { execution: "Native owner confirmation; LPAC/Job", network: "none", allowedOrigins: [], filesystem: "Managed read-only packages and private writable profile" },
  },
  identify: game => game.format === "windows-native",
  provision: async host => {
    const bridge = getNativeBridge();
    if (!bridge || host.kind !== "desktop" || host.architecture !== "x64") return { state: "unavailable", detail: "Requires the Windows x64 desktop bridge." };
    const status = await bridge.inspect();
    return status.requirements.verified
      ? { state: "available", detail: "Live containment probe passed. Package/startup/gameplay compatibility is separate." }
      : { state: "unavailable", detail: "Run the live containment probe first; imported execution remains blocked." };
  },
  launch: async ({ key, bridge }) => {
    const before = new Set((await bridge.inspect()).runs.map(run => run.id));
    const after = await bridge.launch(key);
    return { bridge, id: after.runs.find(run => run.key === key && !before.has(run.id))?.id ?? null };
  },
  cleanup: async session => { const { bridge, id } = await session; if (id) await bridge.stop(id); },
  diagnostics(manifest, host) { return assessArcadeRuntime(this.definition, manifest, host); },
};
for (const adapter of [browserHtmlAdapter, browserNesAdapter, browserChip8Adapter, browserEmulatorJsAdapter, nativeWindowsAdapter]) registerArcadeRuntimeAdapter(adapter);

let host: ArcadeHost | undefined;
export function currentArcadeHost(): ArcadeHost {
  if (host) return host;
  let token: string = crypto.randomUUID();
  let storage = false;
  try {
    token = localStorage.getItem("arenaforge.arcade-host.v1") || token;
    localStorage.setItem("arenaforge.arcade-host.v1", token); storage = true;
  } catch { /* Ephemeral host ID invalidates durable evidence on next load. */ }
  let canvas2d = false;
  try { canvas2d = !!document.createElement("canvas").getContext("2d"); } catch {}
  host = { id: `${token}:${navigator.userAgent.slice(0, 180)}`, kind: "browser", platform: navigator.platform || "unknown",
    architecture: "browser-managed", capabilities: {
      dom: true, canvas2d, wasm: typeof WebAssembly !== "undefined", storage,
    } };
  return host;
}
