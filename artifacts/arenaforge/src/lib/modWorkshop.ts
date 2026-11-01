import { ModWorkshopEngine } from "@workspace/arena/lib/mod-workshop-engine";
import { modHash, parseModPackage } from "@workspace/arena/lib/mod-workshop";
import { importedHtmlSafetyIssue } from "@workspace/arena/lib/games";
import { commitImportedWorkshop, loadImportedGameRecords, loadImportedGames, readImportedWorkshopRecord } from "./importedGameStorage";
import type { WorkshopChange, WorkshopGame, WorkshopPlayback, WorkshopPreview, WorkshopSnapshot } from "./modWorkshopTypes";
import { getNativeBridge } from "../components/nativeArcadeTypes";

const native = (id: string) => id.startsWith("native:");
async function rpc<T>(op: string, gameId: string, rest: Record<string, unknown> = {}): Promise<T> {
  const bridge = getNativeBridge(); if (!bridge?.workshop) throw new Error("This desktop build does not include Mod Workshop. Update the packaged app.");
  return await bridge.workshop({ op, key: gameId.slice(7), ...rest }) as T;
}
function nativeSnapshot(value: WorkshopSnapshot): WorkshopSnapshot { return { ...value, game: { ...value.game, id: `native:${value.game.id}` } }; }

async function baseGame(id: string) {
  const record = (await loadImportedGameRecords([id]))[0] as { id: string; name: string; kind: string; source: string; system?: string; romData?: ArrayBuffer } | undefined;
  if (!record || !["html", "nes", "chip8", "emulator"].includes(record.kind)) throw new Error("The base game is no longer on the imported shelf.");
  let bytes: Uint8Array;
  if (record.kind === "html") bytes = new TextEncoder().encode(record.source);
  else if (record.romData instanceof ArrayBuffer) bytes = new Uint8Array(record.romData);
  else {
    const binary = atob(record.source); bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  const extension = record.kind === "html" ? "html" : record.kind === "nes" ? "nes" : record.kind === "chip8" ? "ch8" : record.system ?? "rom";
  const digest = await modHash(bytes), path = `game.${extension}`;
  return { id: `${record.kind}:${record.system ?? ""}:${digest}`, version: `sha256:${digest}`, kind: record.kind, title: record.name, gameKey: id,
    files: { [path]: bytes }, guard: record, metadata: [{ path, bytes: bytes.length, sha256: digest }] };
}
const engine = new ModWorkshopEngine({
  base: baseGame,
  read: async key => (await readImportedWorkshopRecord("workshop", key))?.state ?? null,
  package: async digest => { const row = await readImportedWorkshopRecord("mod-packages", digest); if (typeof row?.json !== "string") throw new Error("A required mod package is missing."); return row.json; },
  commit: (key, revision, base, next, packages) => commitImportedWorkshop(key, base.guard, revision, next, packages),
  validate(base, result) {
    const originalPaths = Object.keys(base.files);
    if (Object.keys(result.files).some(path => !originalPaths.includes(path))) throw new Error("Browser games are self-contained. Overlay the declared game file; multi-file filesystem overlays require a native runtime.");
    if (base.kind === "html") {
      const html = new TextDecoder("utf-8", { fatal: true }).decode(result.files[originalPaths[0]]);
      const issue = importedHtmlSafetyIssue(html); if (issue) throw new Error(`Mod output failed the game's offline sandbox policy: ${issue}`);
    }
  },
});
export async function listWorkshopGames(): Promise<WorkshopGame[]> {
  const rows = await loadImportedGames(), result: WorkshopGame[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof (row as any).id !== "string") continue;
    const base = await baseGame((row as any).id);
    result.push({ id: base.gameKey, identity: base.id, title: base.title, kind: base.kind, version: base.version, files: base.metadata });
  }
  const bridge = getNativeBridge();
  if (bridge?.workshop) {
    const games = await bridge.workshop({ op: "list" }) as WorkshopGame[];
    result.push(...games.map(game => ({ ...game, id: `native:${game.id}` })));
  }
  return result;
}
export const inspectWorkshop = async (gameId: string) => native(gameId) ? nativeSnapshot(await rpc<WorkshopSnapshot>("inspect", gameId)) : engine.inspect(gameId);
export const createWorkshopProfile = async (gameId: string, name: string, shareSaves: boolean, expectedRevision: number) => native(gameId) ? nativeSnapshot(await rpc<WorkshopSnapshot>("create", gameId, { name, shareSaves, revision: expectedRevision })) : engine.create(gameId, name, shareSaves, expectedRevision);
export const reviewWorkshopChange = async (gameId: string, profileId: string, change: WorkshopChange, expectedRevision: number) => {
  if (!native(gameId)) return engine.review(gameId, profileId, change, expectedRevision);
  const preview = await rpc<WorkshopPreview>("review", gameId, { profileId, change, revision: expectedRevision }); return { ...preview, id: `native:${preview.id}`, gameId };
};
export const commitWorkshopReview = async (id: string) => native(id) ? nativeSnapshot(await rpc<WorkshopSnapshot>("commit", "", { id: id.slice(7) })) : engine.commit(id);
export const activateWorkshopProfile = async (gameId: string, profileId: string, expectedRevision: number) => native(gameId) ? nativeSnapshot(await rpc<WorkshopSnapshot>("activate", gameId, { profileId, revision: expectedRevision })) : engine.activate(gameId, profileId, expectedRevision);
export const rollbackWorkshopProfile = async (gameId: string, profileId: string, expectedRevision: number) => native(gameId) ? nativeSnapshot(await rpc<WorkshopSnapshot>("rollback", gameId, { profileId, revision: expectedRevision })) : engine.rollback(gameId, profileId, expectedRevision);
export const exportWorkshopProfile = (gameId: string, profileId: string) => native(gameId) ? rpc<{ json: string; excluded: string[] }>("export", gameId, { profileId }) : engine.export(gameId, profileId);
export async function launchWorkshopProfile(gameId: string, profileId: string): Promise<WorkshopPlayback> {
  if (native(gameId)) {
    await rpc("launch", gameId, { profileId });
    return { gameId, profileId, profileName: "Native profile", saveId: "", source: "", modKeys: [], native: true };
  }
  const { base, result, profile } = await engine.play(gameId, profileId), bytes = result.files[Object.keys(base.files)[0]];
  let source: string;
  if (base.kind === "html") source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  else { let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); source = btoa(binary); }
  return { gameId, profileId, profileName: profile.name, saveId: profile.shareSaves ? gameId : `workshop-${gameId}-${profile.id}`, source,
    ...(base.kind === "chip8" || base.kind === "emulator" ? { romData: new Uint8Array(bytes).buffer } : {}), modKeys: result.order };
}
export async function readModPackageFile(file: File) {
  if (file.size > 24 * 1024 * 1024) throw new Error("Mod packages are limited to 24 MiB JSON.");
  const json = await file.text(); await parseModPackage(json); return json;
}
export async function reviewModRepository(url: string) {
  const { reviewArcadeModRepository } = await import("@workspace/api-client-react");
  const response = await reviewArcadeModRepository({ url, authorized: true });
  await parseModPackage(response.packageJson); return response.packageJson;
}
