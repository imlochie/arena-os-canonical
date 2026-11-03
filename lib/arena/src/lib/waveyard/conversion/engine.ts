import { extname } from "node:path";

import { checksumFile, probeAudio } from "../audio";
import { execTool, type FfmpegTool } from "../ffmpeg";

export const CONVERSION_FORMATS = {
  mp3: {
    encoder: "libmp3lame",
    codec: "mp3",
    extension: "mp3",
    mimeType: "audio/mpeg",
    lossy: true,
  },
  aac: {
    encoder: "aac",
    codec: "aac",
    extension: "m4a",
    mimeType: "audio/mp4",
    lossy: true,
  },
  wav: {
    encoder: "pcm_s16le",
    codec: "pcm_s16le",
    extension: "wav",
    mimeType: "audio/wav",
    lossy: false,
  },
  flac: {
    encoder: "flac",
    codec: "flac",
    extension: "flac",
    mimeType: "audio/flac",
    lossy: false,
  },
  alac: {
    encoder: "alac",
    codec: "alac",
    extension: "m4a",
    mimeType: "audio/mp4",
    lossy: false,
  },
} as const;

export type ConversionFormat = keyof typeof CONVERSION_FORMATS;
export type ConversionOptions = {
  format: ConversionFormat;
  bitrate: 128 | 192 | 256 | 320;
};

export const MAX_CONVERSION_OUTPUT_BYTES = 1024 ** 3;

const ARTWORK_CAPABLE_FORMATS = new Set<ConversionFormat>([
  "mp3",
  "aac",
  "flac",
  "alac",
]);

function formatIsAvailable(encoderText: string, encoder: string) {
  return new RegExp(`\\b${encoder}\\b`).test(encoderText);
}

async function embeddedArtworkStreamIndexes(inputPath: string) {
  const { stdout } = await execTool("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=index:stream_disposition=attached_pic",
    "-of", "json",
    inputPath,
  ], { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 });
  const report = JSON.parse(stdout) as {
    streams?: Array<{ index?: number; disposition?: { attached_pic?: number } }>;
  };
  return (report.streams ?? [])
    .filter((stream) => stream.disposition?.attached_pic === 1 && Number.isInteger(stream.index))
    .map((stream) => stream.index as number);
}

export async function conversionCapabilities() {
  const { stdout } = await execTool("ffmpeg", ["-hide_banner", "-encoders"], {
    timeoutMs: 15_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  return Object.entries(CONVERSION_FORMATS).map(([id, format]) => ({
    id,
    extension: format.extension,
    mimeType: format.mimeType,
    lossy: format.lossy,
    available: formatIsAvailable(stdout, format.encoder),
  }));
}

export async function convertLocalAudio(
  inputPath: string,
  outputPath: string,
  options: ConversionOptions,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
) {
  const source = await probeAudio(inputPath);
  const format = CONVERSION_FORMATS[options.format];
  const available = (await conversionCapabilities()).find(
    (item) => item.id === options.format,
  )?.available;
  if (!available) {
    throw new Error(`The ${options.format.toUpperCase()} encoder is not available on this device.`);
  }

  const inputExtension = extname(inputPath).toLowerCase();
  if (!inputExtension) throw new Error("The selected local audio file has no format extension.");
  const artworkStreamIndexes = await embeddedArtworkStreamIndexes(inputPath);
  const retainsArtwork = artworkStreamIndexes.length > 0 && ARTWORK_CAPABLE_FORMATS.has(options.format);

  const args = [
    "-v", "error",
    "-nostdin",
    "-progress", "pipe:1",
    "-nostats",
    "-n",
    "-i", inputPath,
    "-map", "0:a:0",
    ...(retainsArtwork
      ? artworkStreamIndexes.flatMap((index) => ["-map", `0:${index}`])
      : []),
    "-map_metadata", "0",
    "-map_chapters", "-1",
    "-c:a", format.encoder,
  ];
  if (retainsArtwork) {
    args.push("-c:v", "copy");
    artworkStreamIndexes.forEach((_, outputVideoIndex) => {
      args.push(`-disposition:v:${outputVideoIndex}`, "attached_pic");
    });
    if (options.format === "mp3") args.push("-id3v2_version", "3");
  }
  if (format.lossy) args.push("-b:a", `${options.bitrate}k`);
  if (options.format === "flac") args.push("-compression_level", "5");
  if (options.format === "aac" || options.format === "alac") args.push("-movflags", "+faststart");
  args.push("-fs", String(MAX_CONVERSION_OUTPUT_BYTES), outputPath);

  let progressOutput = "";
  let lastProgress = 0;
  await execTool("ffmpeg", args, {
    timeoutMs: 10 * 60_000,
    signal,
    maxOutputBytes: 2 * 1024 * 1024,
    onStdout: (chunk) => {
      progressOutput += chunk;
      const lines = progressOutput.split(/\r?\n/);
      progressOutput = lines.pop() ?? "";
      const reversedLines = [...lines].reverse();
      const timeLine = reversedLines.find((line) => line.startsWith("out_time_us="))
        ?? reversedLines.find((line) => line.startsWith("out_time_ms="));
      const duration = source.durationSeconds;
      const match = timeLine && /^out_time_(?:us|ms)=(\d+)$/.exec(timeLine);
      if (!match || duration <= 0) return;
      const divisor = timeLine.startsWith("out_time_us=") ? 1_000_000 : 1_000_000;
      const percent = Math.max(0, Math.min(100, Math.floor((Number(match[1]) / divisor / duration) * 100)));
      if (percent > lastProgress) {
        lastProgress = percent;
        onProgress?.(percent);
      }
    },
  });

  const converted = await probeAudio(outputPath);
  if (
    converted.codec !== format.codec ||
    converted.sampleRate !== source.sampleRate ||
    converted.channels !== source.channels ||
    Math.abs(converted.durationSeconds - source.durationSeconds) > 0.2 ||
    converted.sizeBytes > MAX_CONVERSION_OUTPUT_BYTES
  ) {
    throw new Error("The converted file failed format, duration, or size verification. No result was added to the library.");
  }

  if (retainsArtwork) {
    const convertedArtworkStreamIndexes = await embeddedArtworkStreamIndexes(outputPath);
    if (convertedArtworkStreamIndexes.length !== artworkStreamIndexes.length) {
      throw new Error(
        `The converted file retained ${convertedArtworkStreamIndexes.length} of ${artworkStreamIndexes.length} embedded cover images. No result was added to the library.`,
      );
    }
  }

  await execTool("ffmpeg", [
    "-v", "error",
    "-xerror",
    "-nostdin",
    "-i", outputPath,
    "-map", "0:a:0",
    "-f", "null",
    "-",
  ], {
    timeoutMs: 10 * 60_000,
    signal,
    maxOutputBytes: 2 * 1024 * 1024,
  });

  const warnings: string[] = [];
  if (artworkStreamIndexes.length > 0 && !ARTWORK_CAPABLE_FORMATS.has(options.format)) {
    const count = artworkStreamIndexes.length;
    warnings.push(
      `The source includes ${count} embedded cover image${count === 1 ? "" : "s"}, but ${options.format.toUpperCase()} cannot retain embedded artwork; all embedded artwork will be omitted from the converted file.`,
    );
  }
  if (format.lossy) {
    warnings.push("This lossy format changes audio quality. Keep the original if you may need it later.");
  } else if (["mp3", "aac", "opus", "vorbis", "ac3", "eac3"].includes(source.codec)) {
    warnings.push(`The source codec (${source.codec}) is lossy; a lossless output cannot restore quality already discarded.`);
  }

  return {
    checksumSha256: await checksumFile(outputPath),
    fileSizeBytes: converted.sizeBytes,
    durationSeconds: converted.durationSeconds,
    codec: converted.codec,
    sampleRate: converted.sampleRate,
    channels: converted.channels,
    warnings,
  };
}
