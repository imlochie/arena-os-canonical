import { NextResponse } from "next/server";

import { buildSrt, segmentsFromText } from "@/lib/creative/captions";
import { dubAudio, renderCaptionedShort } from "@/lib/creative/shorts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST one of:
 *   {audioBase64, srt?|text?}  → captioned waveform MP4 (burned-in subtitles)
 *   {audioBase64, dub: "French", keys?} → dubbed audio + per-stage status
 */
export async function POST(req: Request) {
  let body: { audioBase64?: string; srt?: string; text?: string; dub?: string; keys?: Record<string, string> } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const audio = body.audioBase64 ? Buffer.from(body.audioBase64, "base64") : null;
  if (!audio || audio.byteLength < 128) return NextResponse.json({ error: "audioBase64 is required" }, { status: 400 });

  if (body.dub) {
    const result = await dubAudio(audio, "audio.wav", body.dub.slice(0, 40), { keys: body.keys as never });
    if (!result.ok) {
      return NextResponse.json({ stages: result.stages, failedAt: result.failedAt, error: result.reason }, { status: 503 });
    }
    return NextResponse.json({
      stages: result.stages,
      translatedText: result.translatedText,
      engine: result.engine,
      audioBase64: result.audio.toString("base64"),
      mime: result.mime,
    });
  }

  const srt = body.srt?.trim() ? body.srt : body.text?.trim() ? buildSrt(segmentsFromText(body.text)) : null;
  if (!srt) return NextResponse.json({ error: "provide srt or text for the captions" }, { status: 400 });
  const short = await renderCaptionedShort(audio, srt);
  if (!short.ok) return NextResponse.json({ error: short.reason }, { status: 500 });
  return NextResponse.json({ mp4Base64: short.buffer.toString("base64"), bytes: short.buffer.byteLength });
}
