import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { addTrackFromAudioFile } from "@workspace/arena/lib/waveyard/library/service";
import { sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { iterateCaptureRecording, type CaptureMarker, type CaptureTags } from "@workspace/arena/lib/waveyard/capture/segments";
import type { CaptureSignal } from "@workspace/arena/lib/waveyard/capture/pcm-signal";

/** Keep the master recording until every segment has entered the library. */
export async function importCaptureTracks(input: {
  ownerId: string;
  path: string;
  sessionDirectory: string;
  metadata: CaptureTags;
  markers?: CaptureMarker[];
  signal?: CaptureSignal;
}) {
  const results: Awaited<ReturnType<typeof addTrackFromAudioFile>>[] = [];
  let segmentDirectory: string | undefined;
  try {
    for await (const segment of iterateCaptureRecording({
      path: input.path, directory: input.sessionDirectory, metadata: input.metadata, markers: input.markers ?? [],
    })) {
      segmentDirectory = dirname(segment.path);
      const tags = segment.metadata;
      results.push(await addTrackFromAudioFile({
        ownerId: input.ownerId, filePath: segment.path,
        filename: `${tags.trackNumber ? `${String(tags.trackNumber).padStart(2, "0")} - ` : ""}${sanitizedFilename(tags.title)}.wav`,
        mimeType: "audio/wav", title: tags.title, artist: tags.artist, album: tags.album,
        prepareSeparation: input.signal && input.signal.state !== "unsupported" && !input.signal.signalSeen ? false : undefined,
      }));
      await rm(segment.path);
    }
    return {
      track: results[0]!.track,
      tracks: results.map((result) => result.track),
      created: results.some((result) => result.created),
      separationQueued: results.some((result) => result.separationQueued),
    };
  } catch (error) {
    throw new Error(`${results.length} tracks imported before this failure. The original recording and markers are preserved; retry to finish without duplicating imported audio. ${error instanceof Error ? error.message : "Import failed."}`);
  } finally {
    // Only generated slices are disposable here. Never delete the master on a
    // partial failure; ordinary checksum intake makes the retry idempotent.
    if (segmentDirectory) await rm(segmentDirectory, { recursive: true, force: true });
  }
}
