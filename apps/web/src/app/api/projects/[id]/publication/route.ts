import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  exportAssets,
  exportJobs,
  getDb,
  projectAuditEvents,
  projects,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import {
  RIGHTS_ACKNOWLEDGEMENT_STATEMENT,
  RIGHTS_ACKNOWLEDGEMENT_VERSION,
  parseProjectTags,
  publicationState,
} from "@/lib/publication";
import { requireProjectRole } from "@/lib/permissions";

const publicationSchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]),
  publishedExportAssetId: z.string().uuid().optional().nullable(),
  rightsAcknowledged: z.boolean().optional(),
  licenseCode: z.string().trim().min(1).max(80).optional(),
  downloadPermission: z.enum(["owner-only", "public"]).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).optional(),
});

function eventMetadata(
  before: ReturnType<typeof publicationState>,
  after: ReturnType<typeof publicationState>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({ before, after, ...extra });
}

async function completedExports(projectId: string) {
  return getDb()
    .select({
      id: exportAssets.id,
      filename: exportAssets.filename,
      remixVersionId: exportAssets.remixVersionId,
      durationSeconds: exportAssets.durationSeconds,
      format: exportAssets.format,
      sampleRate: exportAssets.sampleRate,
      channels: exportAssets.channels,
      fileSizeBytes: exportAssets.fileSizeBytes,
      createdAt: exportAssets.createdAt,
    })
    .from(exportAssets)
    .innerJoin(exportJobs, eq(exportAssets.exportJobId, exportJobs.id))
    .where(
      and(
        eq(exportAssets.projectId, projectId),
        eq(exportJobs.status, "complete"),
      ),
    );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { project, role } = await requireProjectRole(user.id, id, "viewer");
    const editable = role === "editor" || role === "owner";
    return NextResponse.json({
      role,
      publication: {
        ...publicationState(project),
        rightsAcknowledgementVersion: RIGHTS_ACKNOWLEDGEMENT_VERSION,
        rightsAcknowledgementStatement: RIGHTS_ACKNOWLEDGEMENT_STATEMENT,
        tags: parseProjectTags(project.tags),
      },
      exports: editable ? await completedExports(project.id) : [],
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { project } = await requireProjectRole(user.id, id, "editor");
    const parsed = publicationSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return NextResponse.json(
        { error: "Provide a valid publication state.", code: "invalid_publication_state" },
        { status: 422 },
      );
    const input = parsed.data;
    const publish = input.visibility !== "private";
    const licenseCode = input.licenseCode ?? project.licenseCode;
    const downloadPermission = input.downloadPermission ?? project.downloadPermission;
    let publishedExportAssetId: string | null = null;

    if (publish) {
      if (input.rightsAcknowledged !== true)
        return NextResponse.json(
          { error: "A rights acknowledgement is required before publication.", code: "rights_acknowledgement_required" },
          { status: 422 },
        );
      if (!licenseCode.trim())
        return NextResponse.json(
          { error: "A license is required before publication.", code: "license_required" },
          { status: 422 },
        );
      if (!input.publishedExportAssetId)
        return NextResponse.json(
          { error: "Select a completed export before publication.", code: "published_export_required" },
          { status: 422 },
        );
      if (project.moderationStatus !== "active")
        return NextResponse.json(
          { error: "This project's moderation state does not permit publication.", code: "moderation_status_not_publishable" },
          { status: 409 },
        );
      const [candidate] = await getDb()
        .select({
          id: exportAssets.id,
          projectId: exportAssets.projectId,
          status: exportJobs.status,
        })
        .from(exportAssets)
        .innerJoin(exportJobs, eq(exportAssets.exportJobId, exportJobs.id))
        .where(eq(exportAssets.id, input.publishedExportAssetId))
        .limit(1);
      if (!candidate)
        return NextResponse.json(
          { error: "The selected export does not exist.", code: "published_export_not_found" },
          { status: 422 },
        );
      if (candidate.projectId !== project.id)
        return NextResponse.json(
          { error: "The selected export belongs to another project.", code: "published_export_wrong_project" },
          { status: 422 },
        );
      if (candidate.status !== "complete")
        return NextResponse.json(
          { error: "The selected export has not completed rendering.", code: "published_export_not_complete" },
          { status: 422 },
        );
      publishedExportAssetId = candidate.id;
    }

    const before = publicationState(project);
    const next = {
      visibility: input.visibility,
      publicationStatus: publish ? "published" : "draft",
      moderationStatus: project.moderationStatus,
      publishedExportAssetId,
      licenseCode,
      downloadPermission,
    };
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(projects)
        .set({
          visibility: next.visibility,
          publicationStatus: next.publicationStatus,
          publishedExportAssetId: next.publishedExportAssetId,
          licenseCode: next.licenseCode,
          downloadPermission: next.downloadPermission,
          tags: input.tags ? JSON.stringify(input.tags) : project.tags,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, project.id))
        .returning();
      const after = publicationState(updated);
      const metadata = eventMetadata(before, after, publish
        ? { acknowledgementVersion: RIGHTS_ACKNOWLEDGEMENT_VERSION, acknowledgementStatement: RIGHTS_ACKNOWLEDGEMENT_STATEMENT }
        : {});
      if (publish) {
        await tx.insert(projectAuditEvents).values({
          projectId: project.id,
          actorId: user.id,
          eventType: "rights_acknowledged",
          metadata,
        });
        if (project.publicationStatus !== "published")
          await tx.insert(projectAuditEvents).values({
            projectId: project.id,
            actorId: user.id,
            eventType: "published",
            metadata,
          });
        if (project.visibility !== input.visibility)
          await tx.insert(projectAuditEvents).values({
            projectId: project.id,
            actorId: user.id,
            eventType: "visibility_changed",
            metadata,
          });
      } else if (project.publicationStatus === "published") {
        await tx.insert(projectAuditEvents).values({
          projectId: project.id,
          actorId: user.id,
          eventType: "unpublished",
          metadata,
        });
      }
      return updated;
    });
    return NextResponse.json({
      publication: {
        ...publicationState(result),
        rightsAcknowledgementVersion: RIGHTS_ACKNOWLEDGEMENT_VERSION,
        rightsAcknowledgementStatement: RIGHTS_ACKNOWLEDGEMENT_STATEMENT,
        tags: parseProjectTags(result.tags),
      },
      exports: await completedExports(project.id),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("publication update failed", error);
    return NextResponse.json(
      { error: "Publication could not be updated." },
      { status: 500 },
    );
  }
}
