/**
 * Toolbox presets — HandBrake's ladder, re-implemented as honest ffmpeg arg
 * maps. Software encoders are the static-build defaults; when a hardware
 * encoder was detected it is preferred (and labeled on the job).
 *
 * Efficiency rules baked in:
 *   - CRF single-pass (no pointless 2-pass ABR);
 *   - presets only DOWNSCALE (a 720p source stays 720p under Fast 1080p);
 *   - audio stream-copies when source and target codecs already agree
 *     (checked against the real probe), else re-encodes conservatively;
 *   - remux = -c copy, the instant container change websites charge for.
 */

import type { SourceProbe } from "./convert";

export type PresetId =
  | "fast-1080p"
  | "fast-720p"
  | "fast-480p"
  | "hevc-1080p"
  | "webm-1080p"
  | "remux-mkv"
  | "remux-mp4"
  | "gif-480"
  | "extract-mp3"
  | "extract-m4a"
  | "extract-opus"
  | "convert-wav"
  | "image-jpeg"
  | "image-webp"
  | "image-png";

export type PresetSpec = {
  id: PresetId;
  label: string;
  kind: "video" | "audio" | "image";
  targetExt: string;
  description: string;
  notes?: string;
};

export const PRESETS: PresetSpec[] = [
  {
    id: "fast-1080p",
    label: "Fast 1080p30",
    kind: "video",
    targetExt: "mp4",
    description: "H.264 CRF 22, capped at 1080p/30fps — the everyday transcode.",
    notes: "Hardware encoder used when available; audio copies when already AAC.",
  },
  {
    id: "fast-720p",
    label: "Fast 720p30",
    kind: "video",
    targetExt: "mp4",
    description: "H.264 CRF 22 capped at 720p/30fps — smaller, still sharp.",
  },
  {
    id: "fast-480p",
    label: "Fast 480p30",
    kind: "video",
    targetExt: "mp4",
    description: "H.264 CRF 23 capped at 480p/30fps — the 'email it' size.",
  },
  {
    id: "hevc-1080p",
    label: "HEVC 1080p30 (small files)",
    kind: "video",
    targetExt: "mp4",
    description: "H.265 CRF 26 — roughly half the size of H.264 at similar quality.",
    notes: "Software x265 is slow by design; hardware HEVC is used when present.",
  },
  {
    id: "webm-1080p",
    label: "WebM 1080p (VP9 + Opus)",
    kind: "video",
    targetExt: "webm",
    description: "VP9 CRF 32 + Opus — the open-web upload format.",
    notes: "VP9 software encoding is the slowest preset; honest about it.",
  },
  {
    id: "remux-mkv",
    label: "Remux to MKV (instant)",
    kind: "video",
    targetExt: "mkv",
    description: "Container change only — no re-encode, zero quality loss, seconds.",
  },
  {
    id: "remux-mp4",
    label: "Remux to MP4 (instant)",
    kind: "video",
    targetExt: "mp4",
    description: "Container change only — no re-encode, zero quality loss, seconds.",
    notes: "Streams must be MP4-compatible (H.264/H.265 + AAC/MP3 mostly are).",
  },
  {
    id: "gif-480",
    label: "Animated GIF (480px, palette)",
    kind: "video",
    targetExt: "gif",
    description: "12fps, 480px wide, two-pass palette — the ezgif workflow, local.",
  },
  {
    id: "extract-mp3",
    label: "MP3 (V0)",
    kind: "audio",
    targetExt: "mp3",
    description: "Extract or convert audio to MP3 top quality (V0 ≈ 245kbps).",
  },
  {
    id: "extract-m4a",
    label: "M4A / AAC (192k)",
    kind: "audio",
    targetExt: "m4a",
    description: "AAC 192kbps stereo — the Apple-friendly default.",
  },
  {
    id: "extract-opus",
    label: "Opus (128k)",
    kind: "audio",
    targetExt: "opus",
    description: "Opus 128kbps — best quality-per-bit for voice and music.",
  },
  {
    id: "convert-wav",
    label: "WAV (PCM 16-bit)",
    kind: "audio",
    targetExt: "wav",
    description: "Uncompressed PCM — for editors and DAWs.",
  },
  {
    id: "image-jpeg",
    label: "JPEG (quality 85)",
    kind: "image",
    targetExt: "jpg",
    description: "Compress/convert any image to JPEG q85 — the tinyjpg job.",
  },
  {
    id: "image-webp",
    label: "WebP (quality 82)",
    kind: "image",
    targetExt: "webp",
    description: "WebP q82 — typically 25-35% smaller than JPEG at similar quality.",
  },
  {
    id: "image-png",
    label: "PNG (lossless)",
    kind: "image",
    targetExt: "png",
    description: "Lossless PNG — screenshots and line art.",
  },
];

export function presetCatalog(): PresetSpec[] {
  return PRESETS;
}

export function isPresetId(value: string): value is PresetId {
  return PRESETS.some((p) => p.id === value);
}

/* ------------------------------ arg builders ------------------------------ */

export type BuildContext = {
  input: string;
  output: string;
  source: SourceProbe;
  hw: string | null;
  custom?: { width?: number; fps?: number; quality?: number; targetExt?: string };
};

export type BuiltArgs = { args: string[]; engine: string };

function scaleFilter(maxWidth: number, maxHeight: number, fpsCap: number): string[] {
  // Only downscale: a 720p source stays 720p under a 1080p preset.
  return [
    "-vf",
    `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps='${Math.min(fpsCap, 30)}'`,
  ];
}

function audioArgs(source: SourceProbe, target: "aac" | "copy-if-aac" | "mp3" | "opus" | "wav" | "none"): string[] {
  if (target === "none") return ["-an"];
  if (target === "copy-if-aac") {
    // Stream copy when the source is already AAC (typical MP4) — zero work,
    // zero loss. Otherwise a conservative AAC re-encode.
    return source.audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"];
  }
  if (target === "mp3") return ["-c:a", "libmp3lame", "-q:a", "0"];
  if (target === "opus") return ["-c:a", "libopus", "-b:a", "128k"];
  if (target === "wav") return ["-c:a", "pcm_s16le"];
  return ["-c:a", "aac", "-b:a", "192k"];
}

function videoEncoderArgs(hw: string | null, codec: "h264" | "hevc", crf: number, tune?: string): { args: string[]; engine: string } {
  if (codec === "h264" && hw) {
    // Hardware H.264: quality maps to a QP range (vaapi/nvenc use -rc or -qp
    // differently; a bounded -qp keeps it simple and honest).
    return { args: ["-c:v", hw, "-qp", String(crf)], engine: `hardware:${hw}` };
  }
  if (codec === "hevc" && hw) {
    const hevcHw = hw.replace("h264_", "hevc_");
    return { args: ["-c:v", hevcHw, "-qp", String(crf)], engine: `hardware:${hevcHw}` };
  }
  if (codec === "hevc") {
    return {
      args: ["-c:v", "libx265", "-crf", String(crf), "-preset", "medium", "-tag:v", "hvc1"],
      engine: "software:libx265",
    };
  }
  return {
    args: ["-c:v", "libx264", "-crf", String(crf), "-preset", "faster", ...(tune ? ["-tune", tune] : [])],
    engine: "software:libx264",
  };
}

export function buildPresetArgs(presetId: PresetId | "custom", ctx: BuildContext): BuiltArgs {
  const { input, output, source, hw } = ctx;

  switch (presetId) {
    case "fast-1080p": {
      const enc = videoEncoderArgs(hw, "h264", 22);
      return {
        args: ["-i", input, ...scaleFilter(1920, 1080, 30), ...enc.args, ...audioArgs(source, "copy-if-aac"), "-movflags", "+faststart", output],
        engine: enc.engine,
      };
    }
    case "fast-720p": {
      const enc = videoEncoderArgs(hw, "h264", 22);
      return {
        args: ["-i", input, ...scaleFilter(1280, 720, 30), ...enc.args, ...audioArgs(source, "copy-if-aac"), "-movflags", "+faststart", output],
        engine: enc.engine,
      };
    }
    case "fast-480p": {
      const enc = videoEncoderArgs(hw, "h264", 23);
      return {
        args: ["-i", input, ...scaleFilter(854, 480, 30), ...enc.args, ...audioArgs(source, "copy-if-aac"), "-movflags", "+faststart", output],
        engine: enc.engine,
      };
    }
    case "hevc-1080p": {
      const enc = videoEncoderArgs(hw, "hevc", 26);
      return {
        args: ["-i", input, ...scaleFilter(1920, 1080, 30), ...enc.args, ...audioArgs(source, "copy-if-aac"), "-movflags", "+faststart", output],
        engine: enc.engine,
      };
    }
    case "webm-1080p": {
      return {
        args: [
          "-i", input,
          ...scaleFilter(1920, 1080, 30),
          "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
          ...audioArgs(source, "opus"),
          output,
        ],
        engine: "software:libvpx-vp9",
      };
    }
    case "remux-mkv":
    case "remux-mp4":
      return { args: ["-i", input, "-c", "copy", output], engine: "stream-copy" };
    case "gif-480":
      return {
        args: [
          "-i", input,
          "-vf",
          "fps=12,scale='min(480,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4",
          "-loop", "0",
          output,
        ],
        engine: "software:gif-palette",
      };
    case "extract-mp3":
      return { args: ["-i", input, "-vn", ...audioArgs(source, "mp3"), output], engine: "software:libmp3lame" };
    case "extract-m4a":
      return {
        args: ["-i", input, "-vn", ...(source.audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]), output],
        engine: source.audioCodec === "aac" ? "stream-copy" : "software:aac",
      };
    case "extract-opus":
      return { args: ["-i", input, "-vn", ...audioArgs(source, "opus"), output], engine: "software:libopus" };
    case "convert-wav":
      return { args: ["-i", input, "-vn", ...audioArgs(source, "wav"), output], engine: "software:pcm_s16le" };
    case "image-jpeg":
      return { args: ["-i", input, "-q:v", "4", output], engine: "software:mjpeg" };
    case "image-webp":
      return { args: ["-i", input, "-c:v", "libwebp", "-quality", "82", output], engine: "software:libwebp" };
    case "image-png":
      return { args: ["-i", input, output], engine: "software:png" };
    case "custom": {
      const width = Math.min(Math.max(Math.floor(ctx.custom?.width ?? 1280), 16), 7680);
      const fps = Math.min(Math.max(ctx.custom?.fps ?? 30, 1), 60);
      const quality = Math.min(Math.max(ctx.custom?.quality ?? 22, 0), 51);
      const enc = videoEncoderArgs(hw, "h264", quality);
      return {
        args: [
          "-i", input,
          "-vf",
          `scale='min(${width},iw)':-2:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,fps='${fps}'`,
          ...enc.args,
          ...audioArgs(source, "copy-if-aac"),
          "-movflags", "+faststart",
          output,
        ],
        engine: enc.engine,
      };
    }
  }
}
