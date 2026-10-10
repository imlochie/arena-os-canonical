/**
 * Shorts — CapCut-style output (#13, Wave 3): audio + captions → a real MP4
 * with the waveform visualized and the subtitles BURNED IN. All ffmpeg, all
 * offline, all real. Dubbing (#11 Wave 3): transcribe → translate → speak.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execTool } from "@/lib/waveyard/ffmpeg";
import { buildSrt, segmentsFromText, transcribeAudio } from "@/lib/creative/captions";
import { generate } from "@/lib/ai";
import { speakText } from "@/lib/creative/voice";

export type ShortResult =
  | { ok: true; buffer: Buffer; seconds: number }
  | { ok: false; reason: string };

/** audio (wav/mp3…) + srt text → captioned waveform MP4. */
export async function renderCaptionedShort(audio: Buffer, srt: string): Promise<ShortResult> {
  const dir = await mkdtemp(join(tmpdir(), "arena-short-"));
  try {
    const audioPath = join(dir, "audio");
    const srtPath = join(dir, "captions.srt");
    const outPath = join(dir, "short.mp4");
    await writeFile(audioPath, audio);
    await writeFile(srtPath, srt, "utf8");
    const escaped = srtPath.replace(/'/g, "\\'");
    await execTool(
      "ffmpeg",
      [
        "-y",
        "-i", audioPath,
        "-filter_complex",
        `[0:a]showwaves=s=1280x720:mode=line:colors=0x818cf8:rate=25,format=yuv420p[v];[v]subtitles='${escaped}':force_style='FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00E5E7EB,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'[f]`,
        "-map", "[f]",
        "-map", "0:a",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "26",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        outPath,
      ],
      { timeoutMs: 180_000 },
    );
    const buffer = await readFile(outPath);
    if (buffer.byteLength < 1024) return { ok: false, reason: "ffmpeg produced no video" };
    return { ok: true, buffer, seconds: 0 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type DubStage = { stage: "transcribe" | "translate" | "speak"; ok: boolean; detail: string };

export type DubResult =
  | { ok: true; stages: DubStage[]; translatedText: string; audio: Buffer; mime: string; engine: string }
  | { ok: false; stages: DubStage[]; failedAt: string; reason: string };

/** transcribe (BYOK) → translate (any model) → speak (voice tiers). */
export async function dubAudio(
  audio: Buffer,
  filename: string,
  targetLanguage: string,
  opts: {
    keys?: { groq?: string; openai?: string; elevenlabs?: string };
    modelId?: string;
    fetchImpl?: typeof fetch;
    speak?: (text: string, keys?: { elevenlabs?: string }) => Promise<{ ok: boolean; reason?: string; buffer?: Buffer; mime?: string; engine?: string }>;
  } = {},
): Promise<DubResult> {
  const stages: DubStage[] = [];

  // 1 — transcribe
  const transcription = await transcribeAudio(audio, filename, { keys: opts.keys, fetchImpl: opts.fetchImpl });
  if (!transcription.ok) {
    stages.push({ stage: "transcribe", ok: false, detail: transcription.reason });
    return { ok: false, stages, failedAt: "transcribe", reason: transcription.reason };
  }
  stages.push({ stage: "transcribe", ok: true, detail: `${transcription.via}: ${transcription.text.length} chars` });

  // 2 — translate
  const translation = await generate({
    modelId: opts.modelId ?? "local-engine",
    messages: [
      {
        role: "user",
        content:
          `Translate the following transcript into ${targetLanguage}. Reply with ONLY the translation, no commentary.\n\nTRANSCRIPT:\n${transcription.text.slice(0, 6000)}`,
      },
    ],
    keys: opts.keys as never,
    temperature: 0.3,
  });
  const translated = translation.text.trim();
  if (!translated) {
    stages.push({ stage: "translate", ok: false, detail: "model returned no text" });
    return { ok: false, stages, failedAt: "translate", reason: "translation was empty" };
  }
  stages.push({ stage: "translate", ok: true, detail: `${translation.via ?? translation.backend}` });

  // 3 — speak
  const speakImpl =
    opts.speak ??
    (async (text: string, keys?: { elevenlabs?: string }) => {
      const result = await speakText(text, { keys });
      return result.ok
        ? { ok: true, buffer: result.buffer, mime: result.mime, engine: result.engine }
        : { ok: false, reason: result.reason };
    });
  const spoken = await speakImpl(translated, opts.keys);
  if (!spoken.ok || !spoken.buffer) {
    stages.push({ stage: "speak", ok: false, detail: spoken.reason ?? "voice failed" });
    return { ok: false, stages, failedAt: "speak", reason: spoken.reason ?? "voice failed" };
  }
  stages.push({ stage: "speak", ok: true, detail: spoken.engine ?? "voice" });
  return { ok: true, stages, translatedText: translated, audio: spoken.buffer, mime: spoken.mime ?? "audio/mpeg", engine: spoken.engine ?? "voice" };
}

export { buildSrt, segmentsFromText };
