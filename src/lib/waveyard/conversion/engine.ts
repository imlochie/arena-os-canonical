/** Native local-file conversion. No URLs, shells, protected playback or downloads. */
import { z } from "zod";
import { execTool, type FfmpegTool } from "../ffmpeg";
import { checksumFile, probeAudio, localAudioInputOptions } from "../audio";

export const formats = {
  mp3: { encoder: "libmp3lame", codec: "mp3", ext: "mp3", mime: "audio/mpeg", lossy: true },
  aac: { encoder: "aac", codec: "aac", ext: "m4a", mime: "audio/mp4", lossy: true },
  wav: { encoder: "pcm_s16le", codec: "pcm_s16le", ext: "wav", mime: "audio/wav", lossy: false },
  flac: { encoder: "flac", codec: "flac", ext: "flac", mime: "audio/flac", lossy: false },
  aiff: { encoder: "pcm_s16be", codec: "pcm_s16be", ext: "aiff", mime: "audio/aiff", lossy: false },
  alac: { encoder: "alac", codec: "alac", ext: "m4a", mime: "audio/mp4", lossy: false },
} as const;
export const tagNames = ["title", "artist", "album", "album_artist", "track", "disc", "date", "genre", "lyrics"] as const;
export const tagsSchema = z.record(z.enum(tagNames), z.string().max(64_000)).default({});
export type Tags = z.infer<typeof tagsSchema>;
export const settingsSchema = z.object({
  format: z.enum(["mp3", "aac", "wav", "flac", "aiff", "alac"]),
  bitrate: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320)]).default(192),
  sampleRate: z.union([z.literal(22050), z.literal(44100), z.literal(48000), z.literal(96000)]).optional(),
  channels: z.union([z.literal(1), z.literal(2)]).optional(),
  pcmBits: z.union([z.literal(16), z.literal(24)]).default(24),
  compression: z.number().int().min(0).max(12).default(5),
  template: z.string().min(1).max(240).default("{artist}/{album}/{track} - {title}"),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export async function runTool(tool: FfmpegTool, args: string[], signal?: AbortSignal) {
  return (await execTool(tool, args, { timeoutMs: 600_000, signal, maxOutputBytes: 2 * 1024 * 1024 })).stdout;
}
export async function capabilities() {
  const text = await runTool("ffmpeg", ["-hide_banner", "-encoders"]);
  return Object.entries(formats).map(([id, format]) => ({ id, ...format, available: new RegExp(`\\b${format.encoder}\\b`).test(text) }));
}
export async function inspect(filename: string) {
  const raw = JSON.parse(await runTool("ffprobe", [...localAudioInputOptions, "-v", "error", "-show_format", "-show_streams", "-of", "json", filename]));
  const audio = raw.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  if (!audio) throw new Error("No readable audio stream. Protected, unsupported or corrupt files cannot be converted.");
  const merged = Object.fromEntries(Object.entries({ ...raw.format?.tags, ...audio.tags }).map(([k, v]) => [k.toLowerCase().replace(/ /g, "_"), String(v)]));
  const tags: Tags = {};
  for (const name of tagNames) {
    const value = merged[name] ?? (name === "date" ? merged.year : name === "album_artist" ? merged.albumartist : name === "lyrics" ? merged["lyrics-eng"] : undefined);
    if (value !== undefined) tags[name] = value.slice(0, 64_000);
  }
  const known = new Set<string>([...tagNames, "year", "albumartist", "lyrics-eng", "encoder", "major_brand", "compatible_brands", "minor_version", "vendor_id", "handler_name", "language", "duration"]);
  const unreviewedTags = Object.fromEntries(Object.entries(merged).filter(([key]) => !known.has(key)));
  const channelLayout = String(audio.channel_layout || ({ 1: "mono", 2: "stereo" } as Record<number,string>)[Number(audio.channels)] || "unknown");
  const artwork = raw.streams?.find((s: { disposition?: { attached_pic?: number } }) => s.disposition?.attached_pic === 1);
  return { ...await probeAudio(filename), channelLayout, unreviewedTags, bitsPerSample: Number(audio.bits_per_raw_sample || audio.bits_per_sample || 0), tags, artwork: artwork ? { index: Number(artwork.index), codec: String(artwork.codec_name) } : null };
}
export function outputName(settings: Settings, tags: Tags, suffix: string) {
  if (!/^[a-f0-9-]{8,36}$/.test(suffix)) throw new Error("Invalid output identity.");
  const template = settings.template;
  if (template.startsWith("/") || /[\\:\0]/.test(template) || template.split("/").some(s => s === ".." || s === "." || !s) || /\{(?!artist\}|album\}|title\}|track\}|disc\})/.test(template)) throw new Error("Unsafe naming template. Use relative artist/album/title/track/disc tokens, not filesystem paths.");
  const safe = (value: string) => value.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 100) || "Unknown";
  const name = template.split("/").map(segment => safe(segment.replace(/\{(artist|album|title|track|disc)\}/g, (_, key: keyof Tags) => {
    const value = tags[key] || (key === "title" ? "Untitled" : "Unknown");
    return safe(key === "track" && /^\d+(\/\d+)?$/.test(value) ? value.split("/")[0].padStart(2, "0") : value);
  }))).join("/");
  return `${name} - ${suffix.slice(0, 8)}.${formats[settings.format].ext}`;
}
function encoder(settings: Settings) {
  if (settings.format === "wav") return `pcm_s${settings.pcmBits}le`;
  if (settings.format === "aiff") return `pcm_s${settings.pcmBits}be`;
  return formats[settings.format].encoder;
}
export async function convert(input: string, output: string, settings: Settings, tags: Tags, signal?: AbortSignal) {
  const source = await inspect(input), format = formats[settings.format];
  if (!(await capabilities()).find(c => c.id === settings.format)?.available) throw new Error(`Encoder unavailable: ${format.encoder}. No extension-only conversion performed.`);
  const args = ["-v", "error", "-nostdin", "-n", ...localAudioInputOptions, "-i", input, "-map", "0:a:0", "-map_metadata", "0", "-map_chapters", "-1", "-c:a", encoder(settings)];
  if (format.lossy) args.push("-b:a", `${settings.bitrate}k`);
  if (["flac", "alac"].includes(settings.format)) args.push("-sample_fmt", (settings.pcmBits === 24 ? "s32" : "s16") + (settings.format === "alac" ? "p" : ""), "-bits_per_raw_sample", String(settings.pcmBits));
  if (settings.format === "flac") args.push("-compression_level", String(settings.compression));
  if (settings.sampleRate) args.push("-ar", String(settings.sampleRate));
  if (settings.channels) args.push("-ac", String(settings.channels));
  if (source.artwork && !["wav", "aiff"].includes(settings.format) && ["mjpeg", "png"].includes(source.artwork.codec)) args.push("-map", `0:${source.artwork.index}`, "-c:v", "copy", "-disposition:v:0", "attached_pic");
  if (["aac", "alac"].includes(settings.format)) args.push("-movflags", "+faststart");
  if (settings.format === "aiff") args.push("-write_id3v2", "1");
  for (const [key, value] of Object.entries(tags)) args.push("-metadata", `${key}=${value}`);
  // Bounded on-disk output; a truncated encode must fail duration/decode verification.
  args.push("-fs", "524288000", output);
  await runTool("ffmpeg", args, signal);
}
export async function verify(output: string, source: Awaited<ReturnType<typeof inspect>>, settings: Settings, tags: Tags, signal?: AbortSignal) {
  const actual = await inspect(output), format = formats[settings.format];
  if (actual.codec !== (["wav", "aiff"].includes(settings.format) ? encoder(settings) : format.codec) || actual.sampleRate !== (settings.sampleRate ?? source.sampleRate) || actual.channels !== (settings.channels ?? source.channels) || Math.abs(actual.durationSeconds - source.durationSeconds) > 0.15) throw new Error("Output codec, duration, sample rate or channel verification failed. No completion certified.");
  if (!settings.channels && source.channelLayout !== "unknown" && actual.channelLayout !== source.channelLayout) throw new Error("Output channel layout changed without an explicit channel override. No completion certified.");
  await runTool("ffmpeg", ["-v", "error", "-xerror", "-nostdin", ...localAudioInputOptions, "-i", output, "-map", "0:a:0", "-f", "null", "-"], signal);
  const warnings = Object.entries(tags).filter(([key, value]) => (actual.tags[key as keyof Tags] ?? "") !== value).map(([key]) => `Tag not preserved exactly by ${settings.format}: ${key}`);
  for (const [key,value] of Object.entries(source.unreviewedTags)) if (actual.unreviewedTags[key] !== value) warnings.push(`Additional embedded tag not preserved exactly by ${settings.format}: ${key}`);
  if (source.channelLayout === "unknown") warnings.push("Source channel layout is unknown; channel count was checked, exact speaker positions cannot be certified.");
  if (!format.lossy && ["mp3","mp2","aac","opus","vorbis","ac3","eac3","wmav1","wmav2","amr_nb","amr_wb","atrac3","atrac3p","cook"].includes(source.codec)) warnings.push(`Lossy source codec ${source.codec}: lossless output cannot restore previously discarded audio.`);
  if (source.artwork && !actual.artwork) warnings.push("Embedded cover artwork was not preserved in this container/codec.");
  if (!format.lossy && source.bitsPerSample > settings.pcmBits) warnings.push(`Source precision ${source.bitsPerSample} bits exceeds requested ${settings.pcmBits} bits; this is not lossless restoration.`);
  if (format.lossy) warnings.push("Lossy encoding changes audio; converting back to lossless cannot restore discarded quality.");
  return { checksumSha256: await checksumFile(output), fileSizeBytes: actual.sizeBytes, actual, warnings, fullyDecoded: true as const };
}
