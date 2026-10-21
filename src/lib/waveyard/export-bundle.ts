/** Portable export delivery over existing immutable versions, acquisitions and
 * verified ZIP writer. Notices are evidence, never a grant of permission. */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { exportAssets, exportJobs, projects, remixVersions, sourceAcquisitions, sourceAssets, stemAssets } from "@/db/waveyardSchema";
import { normaliseRemixState } from "./remix";
import { getStorage } from "./storage";
import { ArchiveInputError, createVerifiedZip, type ArchiveEntry } from "./conversion/archive";

const sourceNotice = z.object({
  sourceAssetId: z.string().uuid(), sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stemAssetIds: z.array(z.string().uuid()), filename: z.string(),
  title: z.string().nullable(), artist: z.string().nullable(), method: z.string(),
  sourceUrl: z.string().nullable(), attribution: z.string().nullable(), rightsNotice: z.string().nullable(),
  status: z.enum(["recorded-not-verified", "unknown"]),
});
const attributionSchema = z.object({
  format: z.literal("waveyard-attribution-v1"), capturedAt: z.string(), sources: z.array(sourceNotice),
});
export type VersionAttribution = z.infer<typeof attributionSchema>;
function portableUrl(value: string | null) {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return null; }
}
function references(snapshot: unknown) {
  const state = normaliseRemixState(snapshot);
  if (!state) throw new ArchiveInputError("The saved version is invalid; no attribution bundle was guessed.");
  return [...new Set(state.tracks.flatMap(track => [track.stemAssetId, ...track.clips.map(clip => clip.stemAssetId)]))];
}

/** Capture before immutable version publication. Reads only source metadata,
 * including muted/unused lanes conservatively; never reads or copies audio. */
export async function captureVersionAttribution(projectId: string, snapshot: unknown, database: Pick<typeof db, "select"> = db, additionalSourceIds: string[] = []): Promise<VersionAttribution> {
  const ids = references(snapshot);
  const [project] = await database.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ArchiveInputError("The export project is unavailable.", 404);
  const stems = ids.length ? await database.select({ id: stemAssets.id, sourceAssetId: stemAssets.sourceAssetId }).from(stemAssets)
    .innerJoin(projects, eq(projects.id, stemAssets.projectId))
    .where(and(inArray(stemAssets.id, ids), eq(projects.ownerId, project.ownerId))) : [];
  if (stems.length !== ids.length) throw new ArchiveInputError("A referenced stem is unavailable for this project's owner. Restore its original source before saving or downloading this version.", 403);
  const sourceIds = [...new Set([...stems.map(stem => stem.sourceAssetId), ...additionalSourceIds])];
  const rows = sourceIds.length ? await database.select({ source: sourceAssets }).from(sourceAssets)
    .innerJoin(projects, eq(projects.id, sourceAssets.projectId))
    .where(and(inArray(sourceAssets.id, sourceIds), eq(projects.ownerId, project.ownerId))) : [];
  if (rows.length !== sourceIds.length) throw new ArchiveInputError("A referenced source is unavailable for this project's owner. No unrelated source attribution was substituted.", 403);
  const acquisitions = sourceIds.length ? await database.select().from(sourceAcquisitions).where(inArray(sourceAcquisitions.sourceAssetId, sourceIds)) : [];
  const sources = rows.map(({ source }) => {
    const acquisition = acquisitions.find(row => row.sourceAssetId === source.id);
    let metadata: Record<string, unknown> = {};
    try { const value = JSON.parse(acquisition?.metadata ?? "{}"); if (value && typeof value === "object" && !Array.isArray(value)) metadata = value; } catch { /* Unknown is not invented permission. */ }
    const attribution = typeof metadata.attribution === "string" && metadata.attribution.trim() ? metadata.attribution : null;
    const rightsNotice = typeof metadata.rightsNotice === "string" && metadata.rightsNotice.trim() ? metadata.rightsNotice : null;
    return { sourceAssetId: source.id, sourceChecksumSha256: source.checksumSha256,
      stemAssetIds: stems.filter(stem => stem.sourceAssetId === source.id).map(stem => stem.id).sort(), filename: source.originalFilename,
      title: acquisition?.title ?? null, artist: acquisition?.artist ?? null, method: acquisition?.method ?? "unknown",
      sourceUrl: portableUrl(acquisition?.sourceUrl ?? null), attribution, rightsNotice,
      status: attribution && rightsNotice ? "recorded-not-verified" as const : "unknown" as const };
  }).sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId));
  return attributionSchema.parse({ format: "waveyard-attribution-v1", capturedAt: new Date().toISOString(), sources });
}

function boundedJson(value: unknown) {
  const result = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (result.length > 4 * 1024 ** 2) throw new ArchiveInputError("The export provenance exceeds the 4 MiB portable notice limit. No incomplete notice was downloaded.", 413);
  return result;
}
export async function createExportBundle(input: {
  job: typeof exportJobs.$inferSelect; asset: typeof exportAssets.$inferSelect;
  version: typeof remixVersions.$inferSelect; signal?: AbortSignal;
  storage?: ReturnType<typeof getStorage>;
}) {
  const { job, asset, version, signal } = input, storage = input.storage ?? getStorage();
  if (asset.exportJobId !== job.id || asset.remixVersionId !== version.id || job.remixVersionId !== version.id || asset.projectId !== job.projectId || asset.format !== job.format || (job.format !== "wav" && job.format !== "midi")) throw new ArchiveInputError("Export media/version provenance does not match.");
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(version.snapshot); } catch { throw new ArchiveInputError("The saved version snapshot cannot be read."); }
  const ids = references(snapshot);
  const saved = snapshot.sourceAttribution;
  let attribution: VersionAttribution;
  const basis = saved === undefined ? "legacy-current-acquisition" : "saved-version";
  if (saved === undefined) attribution = await captureVersionAttribution(job.projectId, snapshot);
  else {
    const parsed = attributionSchema.safeParse(saved);
    if (!parsed.success) throw new ArchiveInputError("The saved source notices are invalid. Restore the immutable version; no current notices were silently substituted.");
    attribution = parsed.data;
    const credited = new Set(attribution.sources.flatMap(source => source.stemAssetIds));
    if (ids.some(id => !credited.has(id))) throw new ArchiveInputError("The saved source notices do not cover every referenced stem. No incomplete attribution bundle was served.");
  }
  // A MIDI analysis target may not be a lane in the saved arrangement. Its
  // immutable job identity must not disappear from the portable notices.
  let midiAttribution: VersionAttribution | null = null;
  if (job.format === "midi" && (!job.midiSourceAssetId || !job.midiSourceChecksumSha256)) throw new ArchiveInputError("The MIDI export has no recorded analysis source identity. Restore its original job provenance; no source was guessed.");
  const savedMidiSource = attribution.sources.find(source => source.sourceAssetId === job.midiSourceAssetId);
  if (job.format === "midi" && savedMidiSource && savedMidiSource.sourceChecksumSha256 !== job.midiSourceChecksumSha256) throw new ArchiveInputError("The MIDI job source differs from the saved version's source identity. No attribution was substituted.");
  if (job.format === "midi" && job.midiSourceAssetId && !savedMidiSource) {
    midiAttribution = await captureVersionAttribution(job.projectId, { tracks: [] }, db, [job.midiSourceAssetId]);
    if (midiAttribution.sources[0]?.sourceChecksumSha256 !== job.midiSourceChecksumSha256) throw new ArchiveInputError("The MIDI source identity changed; restore its original acquisition before downloading.");
  }
  const path = asset.format === "midi" ? "export.mid" : "export.wav";
  const scope = "All sources referenced by the saved arrangement (including muted lanes). MIDI analysis targets are additionally identified. This bundle retains recorded notices; it does not verify licences or grant permission. Review applicable attribution, modification and redistribution requirements before sharing.";
  const notices = [...attribution.sources, ...(midiAttribution?.sources ?? [])].map(source => [
    `Source: ${source.title ?? source.filename}`, `Artist: ${source.artist ?? "unknown"}`,
    `Source asset: ${source.sourceAssetId}`, `SHA-256: ${source.sourceChecksumSha256}`,
    `Acquisition: ${source.method}`, `URL: ${portableUrl(source.sourceUrl) ?? "not recorded"}`,
    `Attribution: ${source.attribution ?? "UNKNOWN — no author/licence attribution recorded"}`,
    `Rights notice: ${source.rightsNotice ?? "UNKNOWN — permission and redistribution rights are not established"}`,
    `Status: ${source.status}`,
  ].join("\n"));
  const rights = Buffer.from(["Waveyard Studio export — source notices", scope, `Notice basis: ${basis}`, "Modifications: saved Studio arrangement/mix; consult its version and applicable source notices. This is not an automatic legal clearance.", ...notices].join("\n\n") + "\n");
  if (rights.length > 4 * 1024 ** 2) throw new ArchiveInputError("The export source notices exceed 4 MiB; no truncated notices were downloaded.", 413);
  const manifest = boundedJson({ format: "waveyard-export-bundle-v1", exportJobId: job.id, remixVersionId: version.id,
    media: { path, format: asset.format, sha256: asset.checksumSha256, bytes: asset.fileSizeBytes },
    attribution: { ...attribution, basis, scope, sources: attribution.sources.map(source => ({ ...source, sourceUrl: portableUrl(source.sourceUrl) })) },
    midiAnalysisSource: midiAttribution ? { ...midiAttribution, basis: "midi-analysis-current-acquisition" } : null,
  });
  const entries: ArchiveEntry[] = [{ name: path, bytes: asset.fileSizeBytes, sha256: asset.checksumSha256, open: async () => (await storage.openReadStream(asset.storageKey)).stream }];
  for (const [name, bytes] of [["RIGHTS.txt", rights], ["export-manifest.json", manifest]] as const) entries.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), open: async () => Readable.from([bytes]) });
  return createVerifiedZip(entries, signal);
}
