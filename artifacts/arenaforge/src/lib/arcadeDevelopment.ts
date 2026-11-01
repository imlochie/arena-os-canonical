import { runArcadeDevelopment } from "@workspace/api-client-react";
import { modHash, parseModPackage, type ModManifest } from "@workspace/arena/lib/mod-workshop";
import { loadImportedGameRecords } from "./importedGameStorage";
import { listWorkshopGames, inspectWorkshop, createWorkshopProfile, reviewWorkshopChange,
  commitWorkshopReview, launchWorkshopProfile, rollbackWorkshopProfile } from "./modWorkshop";
import type { WorkshopPlayback, WorkshopPreview, WorkshopGame } from "./modWorkshopTypes";
import { validateDevelopmentSource } from "./developmentBuild";

export type DevelopmentDocument = {
  developmentId: string; gameId: string; title: string; original: string; draft: string;
  provenance: string; revision: number; modelId: string; prompt: string; spaceId?: string;
  mission?: { id: string; status: string; statusDetail: string; journal: any[]; agentPlan: any[] };
  approvals?: { id: string; summary: string }[]; approvedHash?: string;
  profileId?: string; installedHash?: string; assessment?: string;
  proposalHash?: string;
  aiLineage?: { modelId: string; backend?: string; missionId: string; draftHash: string }[];
  assessmentResult?: "working" | "failed";
};
export type DevelopmentModel = { id: string; name: string; backend: string };
export const hashDevelopment = (source: string) => modHash(new TextEncoder().encode(source));
const DB = "arenaforge-private-development";
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "gameId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open private development storage."));
  });
}
async function readDocument(gameId: string): Promise<DevelopmentDocument | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readonly"), request = tx.objectStore("drafts").get(gameId);
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export async function saveDevelopment(doc: DevelopmentDocument): Promise<DevelopmentDocument> {
  if (new TextEncoder().encode(doc.draft).length > 50_000) throw new Error("Development source is limited to 50 KB.");
  const next = { ...doc, revision: doc.revision + 1 }, db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"), current = store.get(doc.gameId);
    let failure: Error | undefined;
    current.onsuccess = () => {
      if ((current.result?.revision ?? 0) !== doc.revision) {
        failure = new Error("This development copy changed in another tab. Reopen it before saving."); tx.abort(); return;
      }
      const count = store.count();
      count.onsuccess = () => {
        if (!current.result && count.result >= 8) { failure = new Error("Eight private development copies are already stored."); tx.abort(); return; }
        store.put(next);
      };
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error("Could not save the development checkpoint.")); };
  });
  return next;
}
export async function listDevelopmentGames() { return (await listWorkshopGames()).filter(game => game.kind === "html" && !game.id.startsWith("native:")); }
async function verifyBase(doc: DevelopmentDocument) {
  const [base] = await loadImportedGameRecords([doc.gameId]) as { kind?: string; source?: string }[];
  if (base?.kind !== "html" || base.source !== doc.original) throw new Error("The immutable base changed or was removed. Nothing was installed; reopen the game to review its source.");
}
export async function openDevelopment(gameId: string): Promise<DevelopmentDocument> {
  const existing = await readDocument(gameId);
  if (existing) { await verifyBase(existing); return existing; }
  const [base] = await loadImportedGameRecords([gameId]) as { name: string; source: string; kind: string; provenance?: unknown }[];
  if (!base || base.kind !== "html" || new TextEncoder().encode(base.source).length > 50_000)
    throw new Error("Development currently supports authorized offline HTML games up to 50 KB; ROM and native engine editors are not supported.");
  return saveDevelopment({ developmentId: crypto.randomUUID(), gameId, title: base.name, original: base.source, draft: base.source,
    provenance: base.provenance ? JSON.stringify(base.provenance).slice(0, 1000) : "Local authorized import; upstream provenance unverified.",
    revision: 0, modelId: "", prompt: "" });
}
export async function listDevelopmentModels(): Promise<DevelopmentModel[]> {
  const response = await fetch("/api/models"); if (!response.ok) throw new Error("Model Hub could not be loaded.");
  const body = await response.json();
  return (body.models ?? []).filter((model: any) => model.kind === "text" && ["local-server", "turboagent"].includes(model.backend));
}
export async function runDevelopment(doc: DevelopmentDocument, op: "start" | "resume" | "approve" | "deny", signal: AbortSignal, approvalId?: string) {
  await verifyBase(doc);
  const result = await runArcadeDevelopment({ authorized: true, op,
    snapshot: { developmentId: doc.developmentId, gameId: doc.gameId, title: doc.title, original: doc.original, draft: doc.draft, provenance: doc.provenance },
    spaceId: doc.spaceId, modelId: doc.modelId, prompt: doc.prompt, approvalId }, { signal }) as any;
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const runtime = result.mission?.journal?.map((step: any) => step.runtime).find((runtime: any) => runtime?.backend && !runtime.fallback && runtime.backend !== "arena-local-engine");
  const changedByModel = runtime && result.snapshot?.draft !== doc.draft;
  const proposalHash = changedByModel ? await hashDevelopment(result.snapshot.draft) : doc.proposalHash;
  const next = await saveDevelopment({ ...doc, ...result.snapshot, spaceId: result.spaceId,
    mission: result.mission, approvals: result.approvals,
    proposalHash,
    aiLineage: changedByModel ? [...(doc.aiLineage ?? []).slice(-15), { modelId: runtime.modelId, backend: runtime.backend,
      missionId: result.mission.id, draftHash: proposalHash! }] : doc.aiLineage,
    approvedHash: result.handoff === "install" ? result.metadata?.draftHash : undefined });
  return next;
}
export async function checkDevelopment(doc: DevelopmentDocument) {
  await verifyBase(doc);
  const build = validateDevelopmentSource(doc.original, doc.draft);
  if (!build.ok) throw new Error(build.diagnostics.join(" "));
  return { draftHash: await hashDevelopment(doc.draft), baseHash: await hashDevelopment(doc.original), path: "game.html",
    bytes: new TextEncoder().encode(doc.draft).length, built: true,
    evidence: "Local static parsing only; no execution or gameplay verification." };
}
export async function packageDevelopment(doc: DevelopmentDocument): Promise<string> {
  await checkDevelopment(doc);
  return serializeDevelopmentPackage(doc, (await inspectWorkshop(doc.gameId)).game);
}
/** Pure serializer, also used to check the real Workshop contract in tests. */
export async function serializeDevelopmentPackage(doc: DevelopmentDocument, base: WorkshopGame): Promise<string> {
  const hash = await hashDevelopment(doc.draft), input = await hashDevelopment(doc.original);
  const runtime = doc.mission?.journal.map(step => step.runtime).filter(Boolean) ?? [];
  const bytes = new TextEncoder().encode(doc.draft);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  const manifest: ModManifest = {
    schema: "arena.arcade.mod", schemaVersion: 1, id: `dev-${doc.developmentId.slice(0, 12)}-${hash.slice(0, 12)}`,
    name: `${doc.aiLineage?.length ? "AI-derived draft" : "Manual draft"} — unverified`.slice(0, 100), version: "1.0.0",
    license: { spdx: "LicenseRef-Local-Development-Unverified", redistributable: false,
      text: JSON.stringify({ trust: "Local derivative; not an upstream release or gameplay-verified package. Distribution rights are not established.",
        source: doc.provenance, model: doc.aiLineage?.length ? doc.modelId : "manual", runtime, lineage: doc.aiLineage, mission: doc.mission?.id,
        recipe: { adapter: "offline-html-replacement", version: 1, input, output: hash } }, null, 2) },
    source: { kind: "local" }, base: { id: base.identity, version: base.version, files: { "game.html": input } },
    adapter: "files", permissions: ["scripts"], requires: [], conflicts: [], after: [], settings: {},
    operations: [{ kind: "replace", target: "game.html", payload: "modified.html", baseSha256: input, resultSha256: hash }],
    payloads: { "modified.html": hash },
  };
  const json = JSON.stringify({ manifest, files: { "modified.html": btoa(binary) } });
  await parseModPackage(json); return json;
}
export async function reviewDevelopment(doc: DevelopmentDocument): Promise<{ document: DevelopmentDocument; preview: WorkshopPreview }> {
  const hash = await hashDevelopment(doc.draft);
  if (doc.proposalHash === hash && doc.approvedHash !== hash) throw new Error("Approve the exact model-produced artifact before preparing its installation.");
  const json = await packageDevelopment(doc);
  let state = await inspectWorkshop(doc.gameId);
  const name = `Development ${doc.developmentId.slice(0, 8)}`;
  let profile = state.profiles.find(item => item.id === doc.profileId || item.name === name);
  if (!profile) {
    state = await createWorkshopProfile(doc.gameId, name, false, state.revision);
    profile = state.profiles.find(item => item.name === name);
  }
  if (!profile || profile.shareSaves) throw new Error("An independent-save development profile is required.");
  const parsed = JSON.parse(json), key = `${parsed.manifest.id}@1.0.0`;
  const preview = await reviewWorkshopChange(doc.gameId, profile.id, { packageJson: json, enabled: [key], order: [key] }, state.revision);
  const document = await saveDevelopment({ ...doc, profileId: profile.id });
  return { document, preview };
}
export async function commitDevelopment(doc: DevelopmentDocument, previewId: string) {
  await verifyBase(doc);
  const result = await commitWorkshopReview(previewId);
  if (!result.profiles.some(profile => profile.id === doc.profileId)) throw new Error("The installed profile could not be found.");
  const next = { ...doc, installedHash: await hashDevelopment(doc.draft) };
  try { return saveDevelopment(await recordDevelopmentEvent(next, "installed", next.installedHash)); }
  catch { throw new Error("The profile was installed, but its development checkpoint or mission evidence could not be saved. Reopen Mod Workshop; the original is unchanged."); }
}
export async function recordDevelopmentEvent(doc: DevelopmentDocument,
  type: "installed" | "launched" | "stopped" | "rolled-back" | "owner-assessed-working" | "owner-assessed-failed", draftHash: string) {
  if (!doc.spaceId || !doc.mission || !doc.profileId) return doc;
  const response = await runArcadeDevelopment({ authorized: true, op: "event", spaceId: doc.spaceId, developmentId: doc.developmentId,
    event: { type, draftHash, profileId: doc.profileId } }) as any;
  return { ...doc, mission: response.mission };
}
export async function playDevelopment(doc: DevelopmentDocument): Promise<WorkshopPlayback> {
  await verifyBase(doc); if (!doc.profileId) throw new Error("Install a reviewed development profile first.");
  const playback = await launchWorkshopProfile(doc.gameId, doc.profileId);
  await saveDevelopment(await recordDevelopmentEvent(doc, "launched", await hashDevelopment(playback.source)));
  return playback;
}
export async function rollbackDevelopment(doc: DevelopmentDocument): Promise<WorkshopPlayback> {
  await verifyBase(doc); if (!doc.profileId) throw new Error("No installed profile to roll back.");
  const state = await inspectWorkshop(doc.gameId);
  await rollbackWorkshopProfile(doc.gameId, doc.profileId, state.revision);
  const playback = await launchWorkshopProfile(doc.gameId, doc.profileId);
  const hash = await hashDevelopment(playback.source);
  await saveDevelopment(await recordDevelopmentEvent({ ...doc, installedHash: hash }, "rolled-back", hash));
  return playback;
}
export async function assessDevelopment(doc: DevelopmentDocument, result: "working" | "failed", notes: string) {
  if (!doc.installedHash || !doc.profileId) throw new Error("Play an installed profile before recording a gameplay assessment.");
  const next = await recordDevelopmentEvent({ ...doc, assessment: notes, assessmentResult: result },
    result === "working" ? "owner-assessed-working" : "owner-assessed-failed", doc.installedHash);
  return saveDevelopment(next);
}
