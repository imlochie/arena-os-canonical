/** Shared data contract: metadata only. Never put source, ROMs or saves here. */
export type ArcadeStage = "downloaded" | "installed" | "built" | "startup" | "gameplay";
export type ArcadeHost = { id: string; kind: string; platform: string; architecture: string; capabilities: Record<string, boolean> };
export type ArcadeEvidence = {
  stage: ArcadeStage; outcome: "passed" | "failed"; origin: "local-record" | "user-observation" | "automated";
  at: number; hostId: string; gameVersion: string; runtimeId: string; runtimeVersion: string; profile: string; detail: string;
};
export type ArcadeManifest = {
  workshop?: { profileId: string; modKeys: string[]; saveScope: "isolated" | "shared"; baseVersion?: string };
  schema: "arena.arcade.game"; schemaVersion: 1; id: string; title: string;
  ownership: "imported-private" | "created"; trust: "imported-code" | "generated-code" | "rom";
  provenance: { origin: string; repository?: string; revision?: string; sourceUrl?: string };
  license: { status: "unknown" | "declared"; details?: unknown };
  installedVersion: string;
  runtime: { id: string; version: string; profile: string };
  requirements: { capability: string; reason: string; optional: boolean }[];
  launch: { entryRef: string; arguments: string[] };
  permissions: { execution: string; network: string; allowedOrigins: string[]; filesystem: string };
  locations: { installation: string; saves: string[]; configuration: string[] };
  profiles: { id: string; name: string; input: string; audio: string; graphics: string; mods: string[] }[];
  history: { at: number; version: string; note: string }[];
  sourceRevisionCopies: number;
  evidence: ArcadeEvidence[];
};
export type ArcadeGameDescriptor = {
  workshop?: ArcadeManifest["workshop"];
  id: string; title: string; source: string | ArrayBuffer; format: string; profile?: string;
  scope: "imported-private" | "created"; trust: ArcadeManifest["trust"]; saveId?: string;
  stored: boolean; addedAt: number; sourceRevisionCopies?: number;
  provenance?: { repository: string; revision: string; sourceUrl: string; license: unknown };
  origin?: string;
};
export type ArcadeRuntimeDefinition = {
  id: string; version: string; name: string; hosts: string[]; architectures: string[];
  provision: { mode: "bundled" | "lazy-module" | "external-assets"; detail: string };
  interfaces: { input: string; audio: string; graphics: string; persistence: string; mods: string };
  cleanup: string; recovery: string;
  requirements: ArcadeManifest["requirements"];
  permissions: ArcadeManifest["permissions"];
};
export type ArcadeCompatibility = { available: boolean; blockers: string[]; warnings: string[] };

export function assessArcadeRuntime(definition: ArcadeRuntimeDefinition | undefined, manifest: ArcadeManifest, host: ArcadeHost): ArcadeCompatibility {
  if (!definition) return { available: false, blockers: [`Runtime ${manifest.runtime.id} is not registered. Install a verified adapter for this runtime; no executor is substituted.`], warnings: [] };
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (definition.version !== manifest.runtime.version) blockers.push(`Requires ${definition.name} ${manifest.runtime.version}; the registered version is ${definition.version}.`);
  if (!definition.hosts.includes(host.kind)) blockers.push(`${definition.name} needs ${definition.hosts.join(" or ")}; this host is ${host.kind}.`);
  if (!definition.architectures.includes("any") && !definition.architectures.includes(host.architecture))
    blockers.push(`${definition.name} requires architecture ${definition.architectures.join(", ")}; this host reports ${host.architecture}. Native CPU compatibility is not inferred from browser support.`);
  const requirements = [...definition.requirements, ...manifest.requirements].filter((item, index, all) =>
    all.findIndex(other => other.capability === item.capability && other.optional === item.optional) === index);
  for (const requirement of requirements) {
    if (host.capabilities[requirement.capability]) continue;
    (requirement.optional ? warnings : blockers).push(requirement.reason);
  }
  if (definition.provision.mode === "external-assets") warnings.push("Runtime assets are fetched separately. Network connectivity and cached-core availability are not proof of a successful launch.");
  return { available: blockers.length === 0, blockers, warnings };
}
export function currentArcadeEvidence(manifest: ArcadeManifest, host: ArcadeHost, stage: ArcadeStage) {
  return [...manifest.evidence].reverse().find(item => item.stage === stage && item.hostId === host.id &&
    item.gameVersion === manifest.installedVersion && item.runtimeId === manifest.runtime.id &&
    item.runtimeVersion === manifest.runtime.version && item.profile === manifest.runtime.profile);
}
export function addArcadeObservation(manifest: ArcadeManifest, host: ArcadeHost, stage: "startup" | "gameplay", detail: string): ArcadeManifest {
  return { ...manifest, evidence: [...manifest.evidence, {
    stage, outcome: "passed", origin: "user-observation", at: Date.now(), hostId: host.id,
    gameVersion: manifest.installedVersion, runtimeId: manifest.runtime.id, runtimeVersion: manifest.runtime.version,
    profile: manifest.runtime.profile, detail: detail.slice(0, 500),
  }].slice(-64) as ArcadeEvidence[] };
}
export async function arcadeContentVersion(source: string | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof source === "string" ? new TextEncoder().encode(source) : source);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function createArcadeManifest(game: ArcadeGameDescriptor, runtime: ArcadeRuntimeDefinition, host: ArcadeHost): Promise<ArcadeManifest> {
  const installedVersion = await arcadeContentVersion(game.source);
  const slot = game.saveId ?? game.id;
  const saveLocations = runtime.id === "arena.browser.html" ? [`localStorage:arenaforge.game-save.v1:${slot}`]
    : runtime.id === "arena.browser.jsnes" ? [`indexeddb:arenaforge-nes-save-states/states/${slot}`, `localStorage:arenaforge.nes-sram.v1:${slot}`]
    : runtime.id === "arena.browser.chip8" ? [`localStorage:arenaforge.${game.profile === "schip" ? "schip-state.v2" : "chip8-state.v1"}:${slot}`]
    : ["Runtime-owned browser storage; preserve the existing game key."];
  const manifest: ArcadeManifest = {
    ...(game.workshop ? { workshop: game.workshop } : {}),
    schema: "arena.arcade.game", schemaVersion: 1, id: game.id, title: game.title, ownership: game.scope, trust: game.trust,
    provenance: game.provenance ? { origin: "repository", repository: game.provenance.repository, revision: game.provenance.revision, sourceUrl: game.provenance.sourceUrl } : { origin: game.origin ?? (game.scope === "created" ? "generated-or-offline" : "local-file") },
    license: game.provenance ? { status: "declared", details: game.provenance.license } : { status: "unknown" },
    installedVersion, runtime: { id: runtime.id, version: runtime.version, profile: game.profile ?? game.format },
    requirements: runtime.requirements, launch: { entryRef: `${game.scope === "imported-private" ? "imported-game" : "created-game"}:${game.id}`, arguments: [] },
    permissions: runtime.permissions,
    locations: { installation: game.scope === "imported-private" ? `indexeddb:arenaforge-imported-games/games/${game.id}` : `existing-created-game:${game.id}`, saves: saveLocations, configuration: [`manifest-profile:${game.scope}:${game.id}/default`] },
    profiles: [{ id: game.workshop?.profileId ?? "default", name: game.workshop ? "Reviewed mod profile" : "Existing controls and settings", ...runtime.interfaces, mods: game.workshop?.modKeys ?? [] }],
    history: [{ at: game.addedAt, version: installedVersion, note: "Existing game identity retained; source and progress were not migrated." }],
    sourceRevisionCopies: game.sourceRevisionCopies ?? 0, evidence: [],
  };
  if (game.stored) manifest.evidence.push({
    stage: "installed", outcome: "passed", origin: "local-record", at: Date.now(), hostId: host.id,
    gameVersion: installedVersion, runtimeId: runtime.id, runtimeVersion: runtime.version, profile: manifest.runtime.profile,
    detail: "Existing game record is saved. This is not a native installation, build, startup or gameplay check.",
  });
  return manifest;
}
export function validArcadeManifest(value: unknown): value is ArcadeManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as ArcadeManifest;
  const text = (v: unknown, max = 500) => typeof v === "string" && v.length > 0 && v.length <= max;
  const strings = (v: unknown, max = 32) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === "string" && x.length < 2000);
  try {
    return JSON.stringify(value).length <= 256 * 1024 && item.schema === "arena.arcade.game" && item.schemaVersion === 1 &&
      text(item.id, 256) && text(item.title, 1000) && ["imported-private", "created"].includes(item.ownership) &&
      ["imported-code", "generated-code", "rom"].includes(item.trust) && /^sha256:[a-f0-9]{64}$/.test(item.installedVersion) &&
      text(item.provenance.origin) && ["unknown", "declared"].includes(item.license.status) &&
      text(item.runtime.id) && text(item.runtime.version) && text(item.runtime.profile) &&
      Array.isArray(item.requirements) && item.requirements.length <= 32 && item.requirements.every(r => text(r.capability) && text(r.reason, 2000) && typeof r.optional === "boolean") &&
      text(item.launch.entryRef, 2000) && strings(item.launch.arguments) &&
      text(item.permissions.execution) && text(item.permissions.network) && text(item.permissions.filesystem) && strings(item.permissions.allowedOrigins) &&
      text(item.locations.installation, 2000) && strings(item.locations.saves) && strings(item.locations.configuration) &&
      Array.isArray(item.profiles) && item.profiles.length > 0 && item.profiles.length <= 16 &&
      item.profiles.every(p => text(p.id) && text(p.name) && text(p.input, 2000) && text(p.audio, 2000) && text(p.graphics, 2000) && strings(p.mods)) &&
      Array.isArray(item.history) && item.history.length <= 32 && item.history.every(h => Number.isFinite(h.at) && text(h.version) && text(h.note, 2000)) &&
      Number.isInteger(item.sourceRevisionCopies) && item.sourceRevisionCopies >= 0 &&
      Array.isArray(item.evidence) && item.evidence.length <= 64 && item.evidence.every(e =>
        ["downloaded", "installed", "built", "startup", "gameplay"].includes(e.stage) && ["passed", "failed"].includes(e.outcome) &&
        ["local-record", "user-observation", "automated"].includes(e.origin) && Number.isFinite(e.at) &&
        text(e.hostId, 1000) && text(e.gameVersion) && text(e.runtimeId) && text(e.runtimeVersion) && text(e.profile) && text(e.detail, 2000));
  } catch { return false; }
}
