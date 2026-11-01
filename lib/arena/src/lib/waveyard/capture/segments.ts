import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectRf64Recording, Rf64Recorder } from "./rf64";

export interface CaptureTags {
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  /** Local PNG/JPEG bytes only. Never fetch arbitrary artwork URLs. */
  artworkDataUrl?: string;
}

export interface CaptureMarker {
  id: string;
  sampleFrame: number;
  metadata: CaptureTags;
}

export function validateCaptureTags(input: unknown): CaptureTags {
  if (!input || typeof input !== "object") throw new Error("Track metadata is required.");
  const raw = input as Record<string, unknown>;
  const result: CaptureTags = { title: "" };
  for (const key of ["title", "artist", "album"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string" || raw[key].length > 500 || /[\x00-\x08\x0b-\x1f]/.test(raw[key])) {
        throw new Error(`Invalid ${key}; use up to 500 text characters.`);
      }
      result[key] = raw[key].trim();
    }
  }
  if (!result.title) throw new Error("A track title is required.");
  if (raw.trackNumber !== undefined) {
    if (!Number.isInteger(raw.trackNumber) || Number(raw.trackNumber) < 1 || Number(raw.trackNumber) > 99999)
      throw new Error("Track number must be between 1 and 99999.");
    result.trackNumber = Number(raw.trackNumber);
  }
  if (raw.artworkDataUrl !== undefined) {
    const value = raw.artworkDataUrl;
    if (typeof value !== "string" || value.length > 2_800_000
      || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("Artwork must be a local PNG or JPEG smaller than 2 MB.");
    }
    const image = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
    const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (image.length > 2_000_000 || !(value.startsWith("data:image/png;") ? png : jpeg))
      throw new Error("Artwork bytes do not match a supported PNG or JPEG image.");
    result.artworkDataUrl = value;
  }
  return result;
}

function chunk(type: string, body: Buffer) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, ...(body.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function id3Frame(type: string, body: Buffer) {
  const header = Buffer.alloc(10);
  header.write(type);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function metadataChunks(tags: CaptureTags) {
  const texts = [
    ["INAM", "TIT2", tags.title], ["IART", "TPE1", tags.artist],
    ["IPRD", "TALB", tags.album], ["ITRK", "TRCK", tags.trackNumber?.toString()],
  ];
  const info: Buffer[] = [Buffer.from("INFO")];
  const frames: Buffer[] = [];
  for (const [riff, id3, value] of texts) {
    if (!value) continue;
    info.push(chunk(riff!, Buffer.from(`${value}\0`, "utf8")));
    frames.push(id3Frame(id3!, Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from(value, "utf16le")])));
  }
  if (tags.artworkDataUrl) {
    const comma = tags.artworkDataUrl.indexOf(",");
    const mime = tags.artworkDataUrl.slice(5, tags.artworkDataUrl.indexOf(";"));
    frames.push(id3Frame("APIC", Buffer.concat([
      Buffer.from([0]), Buffer.from(`${mime}\0`, "ascii"), Buffer.from([3, 0]),
      Buffer.from(tags.artworkDataUrl.slice(comma + 1), "base64"),
    ])));
  }
  const body = Buffer.concat(frames);
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let index = 0; index < 4; index++) header[9 - index] = (body.length >>> (index * 7)) & 127;
  return Buffer.concat([chunk("LIST", Buffer.concat(info)), chunk("id3 ", Buffer.concat([header, body]))]);
}

async function appendTags(path: string, tags: CaptureTags) {
  const handle = await open(path, "r+");
  try {
    const size = (await handle.stat()).size;
    // RIFF chunks start on even byte boundaries, including odd-width mono PCM.
    const bytes = Buffer.concat([...(size & 1 ? [Buffer.alloc(1)] : []), metadataChunks(tags)]);
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, size + written);
      if (!result.bytesWritten) throw new Error("Could not write capture metadata.");
      written += result.bytesWritten;
    }
    const riffSize = Buffer.alloc(8);
    riffSize.writeBigUInt64LE(BigInt(size + bytes.length - 8));
    await handle.write(riffSize, 0, 8, 20);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Frame-exact RF64 slicing. Bounded memory, unchanged PCM and fmt bytes. */
export async function* iterateCaptureRecording(input: {
  path: string;
  directory: string;
  metadata: CaptureTags;
  markers: CaptureMarker[];
}) {
  const source = await inspectRf64Recording(input.path);
  if (!source.sampleFrames) throw new Error("The recording contains no complete PCM frames.");
  let previous = 0;
  for (const marker of input.markers) {
    if (!Number.isSafeInteger(marker.sampleFrame) || marker.sampleFrame <= previous || marker.sampleFrame > source.sampleFrames)
      throw new Error("Track boundaries must be distinct, increasing captured PCM positions.");
    validateCaptureTags(marker.metadata);
    previous = marker.sampleFrame;
  }
  const boundaries = [{ sampleFrame: 0, metadata: validateCaptureTags(input.metadata) }, ...input.markers]
    .filter((marker) => marker.sampleFrame < source.sampleFrames);
  const directory = join(input.directory, `segments-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const reader = await open(input.path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(source.blockAlign, Math.floor(1_048_576 / source.blockAlign) * source.blockAlign));
    for (const [index, boundary] of boundaries.entries()) {
      const endFrame = boundaries[index + 1]?.sampleFrame ?? source.sampleFrames;
      const path = join(directory, `${String(index + 1).padStart(4, "0")}.wav`);
      const recorder = await Rf64Recorder.create({ partialPath: `${path}.partial.wav`, finalPath: path, format: source.format });
      try {
        let position = source.dataOffset + boundary.sampleFrame * source.blockAlign;
        let remaining = (endFrame - boundary.sampleFrame) * source.blockAlign;
        while (remaining) {
          const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, remaining), position);
          if (!bytesRead) throw new Error("Capture PCM ended before its confirmed boundary.");
          await recorder.writePcm(buffer.subarray(0, bytesRead));
          position += bytesRead;
          remaining -= bytesRead;
        }
        await recorder.finalize();
      } catch (error) {
        await recorder.leaveRecoverable().catch(() => {});
        throw error;
      }
      await appendTags(path, boundary.metadata);
      yield { path, metadata: boundary.metadata, startFrame: boundary.sampleFrame, sampleFrames: endFrame - boundary.sampleFrame };
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await reader.close();
  }
}

export async function splitCaptureRecording(input: Parameters<typeof iterateCaptureRecording>[0]) {
  const outputs = [];
  for await (const segment of iterateCaptureRecording(input)) outputs.push(segment);
  return outputs;
}
