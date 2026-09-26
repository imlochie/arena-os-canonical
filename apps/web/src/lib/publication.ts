import { and, desc, eq } from "drizzle-orm";
import {
  exportAssets,
  getDb,
  projectAuditEvents,
  projects,
  users,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";

export const RIGHTS_ACKNOWLEDGEMENT_VERSION = "waveyard-publication-rights-v1";
export const RIGHTS_ACKNOWLEDGEMENT_STATEMENT =
  "I confirm that I have the rights or permissions needed to publish this project and its selected final render under the stated license.";

export type PublicationState = {
  visibility: string;
  publicationStatus: string;
  moderationStatus: string;
  publishedExportAssetId: string | null;
  licenseCode: string;
  downloadPermission: string;
};

export function publicationState(project: typeof projects.$inferSelect): PublicationState {
  return {
    visibility: project.visibility,
    publicationStatus: project.publicationStatus,
    moderationStatus: project.moderationStatus,
    publishedExportAssetId: project.publishedExportAssetId,
    licenseCode: project.licenseCode,
    downloadPermission: project.downloadPermission,
  };
}

export function isPubliclyReadable(project: typeof projects.$inferSelect) {
  return (
    project.publicationStatus === "published" &&
    (project.visibility === "public" || project.visibility === "unlisted") &&
    (project.moderationStatus === "active" || project.moderationStatus === "reported")
  );
}

export function isDiscoverable(project: typeof projects.$inferSelect) {
  return isPubliclyReadable(project) && project.visibility === "public";
}

export function parseProjectTags(tags: string) {
  try {
    const value = JSON.parse(tags);
    if (!Array.isArray(value)) return [];
    return value
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}

export async function requireModerator() {
  const user = await requireUser();
  if (user.platformRole !== "moderator")
    throw new Response("Moderator access is required.", { status: 403 });
  return user;
}

export async function publicProjectResolution(projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || !isPubliclyReadable(project))
    throw new Response("Public project not found.", { status: 404 });
  if (!project.publishedExportAssetId)
    throw new Response("Public project release is unavailable.", { status: 404 });
  const [asset] = await db
    .select()
    .from(exportAssets)
    .where(eq(exportAssets.id, project.publishedExportAssetId))
    .limit(1);
  if (!asset || asset.projectId !== project.id)
    throw new Response("Public project release is unavailable.", { status: 404 });
  const [creator] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, project.ownerId))
    .limit(1);
  const [published] = await db
    .select({ createdAt: projectAuditEvents.createdAt })
    .from(projectAuditEvents)
    .where(
      and(
        eq(projectAuditEvents.projectId, project.id),
        eq(projectAuditEvents.eventType, "published"),
      ),
    )
    .orderBy(desc(projectAuditEvents.createdAt))
    .limit(1);
  const releaseDate = published?.createdAt ?? project.updatedAt;
  return { project, asset, creator, releaseDate };
}

export function safePublicProject(
  resolution: Awaited<ReturnType<typeof publicProjectResolution>>,
) {
  const { project, asset, creator, releaseDate } = resolution;
  return {
    project: {
      id: project.id,
      title: project.title,
      description: project.description,
      genre: project.genre,
      tags: parseProjectTags(project.tags),
      licenseCode: project.licenseCode,
      visibility: project.visibility,
      creatorDisplayName: creator?.displayName ?? "Waveyard creator",
      releaseDate,
      createdAt: project.createdAt,
    },
    release: {
      filename: asset.filename,
      durationSeconds: asset.durationSeconds,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      codec: asset.codec,
      format: asset.format,
      fileSizeBytes: asset.fileSizeBytes,
      checksumSha256: asset.checksumSha256,
      downloadAllowed: project.downloadPermission === "public",
    },
  };
}
