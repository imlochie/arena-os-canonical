import { and, desc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import {
  CreateLibraryConversionBody,
  GetLibraryConversionOptionsResponse,
} from "@workspace/api-zod";
import { libraryConversionJobs, projects, sourceAcquisitions, sourceAssets, tracks } from "@workspace/db/waveyardSchema";
import {
  CONVERSION_FORMATS,
  conversionCapabilities,
  type ConversionFormat,
} from "@workspace/arena/lib/waveyard/conversion/engine";
import {
  wakeLocalLibraryConversionWorker,
} from "@workspace/arena/lib/waveyard/conversion/jobs";
import { libraryConversionIdempotencyKey } from "@workspace/arena/lib/waveyard/conversion/idempotency";
import { acceptedAudioFilename, MAX_UPLOAD_BYTES } from "@workspace/arena/lib/waveyard/audio";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";
import { serializeLibraryConversionJob } from "./job-response";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(GetLibraryConversionOptionsResponse.parse({
      formats: await conversionCapabilities(),
      sourcePolicy: "Only files uploaded from this device can be converted. Protected subscription audio is not available.",
    }));
  } catch (error) {
    return Response.json(GetLibraryConversionOptionsResponse.parse({
      formats: Object.entries(CONVERSION_FORMATS).map(([id, format]) => ({
        id,
        extension: format.extension,
        mimeType: format.mimeType,
        lossy: format.lossy,
        available: false,
      })),
      error: error instanceof Error ? error.message : "Local audio conversion is unavailable on this device.",
    }));
  }
}
export async function POST(request: Request) {
  try {
    const parsed = CreateLibraryConversionBody.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
    const input = parsed.data;
    const user = await requireUser();
    const [row] = await db
      .select({
        trackId: tracks.id,
        projectId: tracks.projectId,
        title: tracks.title,
        artist: tracks.artist,
        album: tracks.album,
        source: sourceAssets,
      })
      .from(tracks)
      .innerJoin(sourceAssets, and(
        eq(sourceAssets.id, tracks.sourceAssetId),
        eq(sourceAssets.projectId, tracks.projectId),
      ))
      .innerJoin(projects, and(
        eq(projects.id, tracks.projectId),
        eq(projects.ownerId, user.id),
      ))
      .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, user.id)))
      .limit(1);
    if (!row) return Response.json({ error: "A local audio track for this account was not found." }, { status: 404 });

    const [acquisition] = await db
      .select({ method: sourceAcquisitions.method })
      .from(sourceAcquisitions)
      .where(eq(sourceAcquisitions.sourceAssetId, row.source.id))
      .limit(1);
    if (acquisition?.method !== "local-upload") {
      return Response.json({
        error: "Conversion is limited to files uploaded from this device. Authorized links and protected subscription streams are not converted.",
      }, { status: 403 });
    }
    if (
      !acceptedAudioFilename(row.source.originalFilename) ||
      !Number.isSafeInteger(row.source.fileSizeBytes) ||
      row.source.fileSizeBytes < 1 ||
      row.source.fileSizeBytes > MAX_UPLOAD_BYTES ||
      !/^[a-f0-9]{64}$/i.test(row.source.checksumSha256)
    ) {
      return Response.json({ error: "The stored original is not a supported, verified local audio file." }, { status: 415 });
    }
    if (!(await getStorage().exists(row.source.storageKey))) {
      return Response.json({ error: "The original audio is missing from private storage; no conversion was started." }, { status: 410 });
    }

    const format = input.format as ConversionFormat;
    const idempotencyKey = libraryConversionIdempotencyKey({
      ownerId: user.id,
      originalTrackId: row.trackId,
      sourceAssetId: row.source.id,
      checksumSha256: row.source.checksumSha256,
      format,
      bitrate: input.bitrate,
    });
    let [job] = await db.insert(libraryConversionJobs).values({
      ownerId: user.id,
      originalTrackId: row.trackId,
      sourceAssetId: row.source.id,
      format,
      bitrate: input.bitrate,
      idempotencyKey,
    }).onConflictDoNothing({ target: libraryConversionJobs.idempotencyKey }).returning();

    if (!job) {
      [job] = await db.select().from(libraryConversionJobs)
        .where(and(
          eq(libraryConversionJobs.idempotencyKey, idempotencyKey),
          eq(libraryConversionJobs.ownerId, user.id),
        )).limit(1);
      if (!job) throw new Error("The conversion job could not be recovered after submission.");
      if (job.status === "failed") {
        [job] = await db.update(libraryConversionJobs).set({
          status: "queued",
          stage: "queued",
          progress: 0,
          errorMessage: null,
          completedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(libraryConversionJobs.id, job.id),
          eq(libraryConversionJobs.status, "failed"),
        )).returning();
        if (!job) {
          [job] = await db.select().from(libraryConversionJobs)
            .where(and(
              eq(libraryConversionJobs.idempotencyKey, idempotencyKey),
              eq(libraryConversionJobs.ownerId, user.id),
            )).limit(1);
        }
      }
    }

    if (!job) throw new Error("The conversion job was not saved.");
    if (job.status === "queued") wakeLocalLibraryConversionWorker();
    return Response.json(serializeLibraryConversionJob(job), { status: job.status === "complete" ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({
      error: error instanceof Error ? error.message : "Local audio conversion could not be queued.",
    }, { status: 422 });
  }
}
