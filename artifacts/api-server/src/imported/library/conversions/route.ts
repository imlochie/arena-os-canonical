import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import {
  CreateLibraryConversionBody,
  CreateLibraryConversionResponse,
  GetLibraryConversionOptionsResponse,
} from "@workspace/api-zod";
import { projects, sourceAcquisitions, sourceAssets, tracks } from "@workspace/db/waveyardSchema";
import {
  CONVERSION_FORMATS,
  conversionCapabilities,
  convertLocalAudio,
  type ConversionFormat,
} from "@workspace/arena/lib/waveyard/conversion/engine";
import { addTrackFromAudioFile } from "@workspace/arena/lib/waveyard/library/service";
import { acceptedAudioFilename, checksumFile, MAX_UPLOAD_BYTES, sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { getStorage } from "@workspace/arena/lib/waveyard/storage";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(GetLibraryConversionOptionsResponse.parse({
      formats: await conversionCapabilities(),
      sourcePolicy: "Only audio files uploaded from this device can be converted. Protected subscription streams are not available.",
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
  let temporaryDirectory: string | undefined;
  try {
    const parsed = CreateLibraryConversionBody.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: parsed.error.message }, { status: 400 });
    }
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
        error: "Conversion is limited to audio files uploaded from this device. Authorized links and protected subscription streams are not converted.",
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

    const storage = getStorage();
    if (!(await storage.exists(row.source.storageKey))) {
      return Response.json({ error: "The original audio is missing from private storage; no conversion was started." }, { status: 410 });
    }

    temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-conversion-"));
    const sourcePath = join(temporaryDirectory, `${randomUUID()}${extname(row.source.originalFilename).toLowerCase()}`);
    const format = CONVERSION_FORMATS[input.format];
    const outputPath = join(temporaryDirectory, `${randomUUID()}.${format.extension}`);
    await storage.getToFile(row.source.storageKey, sourcePath);
    if (await checksumFile(sourcePath) !== row.source.checksumSha256.toLowerCase()) {
      return Response.json({ error: "The stored original failed its checksum check; no conversion was started." }, { status: 409 });
    }

    const verification = await convertLocalAudio(
      sourcePath,
      outputPath,
      { format: input.format as ConversionFormat, bitrate: input.bitrate },
      request.signal,
    );
    const outputName = `${sanitizedFilename(row.title)}.converted.${format.extension}`;
    const result = await addTrackFromAudioFile({
      ownerId: user.id,
      filePath: outputPath,
      filename: outputName,
      mimeType: format.mimeType,
      title: row.title,
      artist: row.artist,
      album: row.album,
      prepareSeparation: false,
    });

    return Response.json(CreateLibraryConversionResponse.parse({
      track: result.track,
      created: result.created,
      originalTrackId: row.trackId,
      format: input.format,
      verification,
      notice: "The verified converted copy is in your library. The original was not changed. You can include the new track in a local-audio ZIP backup.",
    }), { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Local audio conversion failed.";
    return Response.json({ error: message }, { status: 422 });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
