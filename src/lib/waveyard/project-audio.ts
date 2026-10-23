/**
 * A Studio project may own audio or reference library audio through persisted
 * remix tracks. Resolve that existing relationship consistently for the
 * workspace, arrangement persistence and renderer; never reparent/copy files.
 * Referenced assets must still belong to the destination project's owner.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { isUuid } from "@/lib/api/ids";
import { normaliseRemixState } from "./remix";
import { db } from "@/db";
import { projects, remixClips, remixSessions, remixTracks, remixVersions, sourceAssets, stemAssets } from "@/db/waveyardSchema";

export async function projectAudio(projectId: string) {
  const [project] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { stems: [], sources: [] };
  const references = await db.select({ id: remixTracks.stemAssetId }).from(remixTracks)
    .innerJoin(remixSessions, eq(remixTracks.remixSessionId, remixSessions.id))
    .where(eq(remixSessions.projectId, projectId));
  const clipReferences = await db.select({ id: remixClips.stemAssetId }).from(remixClips)
    .innerJoin(remixTracks, eq(remixClips.remixTrackId, remixTracks.id))
    .innerJoin(remixSessions, eq(remixTracks.remixSessionId, remixSessions.id))
    .where(eq(remixSessions.projectId, projectId));
  // Saved immutable versions remain reusable even after edits replace their live lanes.
  // Versions are snapshots created from persisted, permission-checked remixes,
  // not arbitrary client-provided grants.
  const versions = await db.select({ snapshot: remixVersions.snapshot }).from(remixVersions)
    .innerJoin(remixSessions, eq(remixVersions.remixSessionId, remixSessions.id))
    .where(eq(remixSessions.projectId, projectId));
  const versionIds = versions.flatMap(({ snapshot }) => {
    try {
      const state = normaliseRemixState(JSON.parse(snapshot));
      return state?.tracks.flatMap((track) => [track.stemAssetId, ...track.clips.map((clip) => clip.stemAssetId)]) ?? [];
    } catch { return []; }
  });
  const referenceIds = [...new Set([...references, ...clipReferences].map((entry) => entry.id).concat(versionIds.filter(isUuid)))];
  const rows = await db.select({ stem: stemAssets }).from(stemAssets)
    .innerJoin(projects, eq(stemAssets.projectId, projects.id))
    .where(and(eq(projects.ownerId, project.ownerId), referenceIds.length
      ? or(eq(stemAssets.projectId, projectId), inArray(stemAssets.id, referenceIds))
      : eq(stemAssets.projectId, projectId)))
    .orderBy(asc(stemAssets.createdAt), asc(stemAssets.id));
  const stems = rows.map((row) => row.stem);
  const sourceIds = [...new Set(stems.map((stem) => stem.sourceAssetId))];
  const sourceRows = await db.select({ source: sourceAssets }).from(sourceAssets)
    .innerJoin(projects, eq(sourceAssets.projectId, projects.id))
    .where(and(eq(projects.ownerId, project.ownerId), sourceIds.length
      ? or(eq(sourceAssets.projectId, projectId), inArray(sourceAssets.id, sourceIds))
      : eq(sourceAssets.projectId, projectId)))
    .orderBy(asc(sourceAssets.createdAt), asc(sourceAssets.id));
  const sources = sourceRows.map((row) => row.source);
  const permittedSources = new Set(sources.map((source) => source.id));
  return { stems: stems.filter((stem) => permittedSources.has(stem.sourceAssetId)), sources };
}
