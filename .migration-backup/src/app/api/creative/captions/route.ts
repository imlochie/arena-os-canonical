import { NextResponse } from "next/server";

import { buildSrt, buildVtt, parseSrt, segmentsFromText, transcribeAudio } from "@/lib/creative/captions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST one of:
 *   {text}                       → auto-timed SRT + VTT (paste a transcript)
 *   {srt}                        → normalized SRT + VTT (round-trip/repair)
 *   {audioBase64, filename, keys?} → real transcription (Groq/OpenAI BYOK)
 *     then SRT + VTT from the returned segments
 */
export async function POST(req: Request) {
  let body: { text?: string; srt?: string; audioBase64?: string; filename?: string; keys?: { groq?: string; openai?: string } } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.audioBase64) {
    const audio = Buffer.from(body.audioBase64, "base64");
    if (audio.byteLength < 128) return NextResponse.json({ error: "audioBase64 is too small to transcribe" }, { status: 400 });
    const result = await transcribeAudio(audio, body.filename || "audio.wav", { keys: body.keys });
    if (!result.ok) return NextResponse.json({ error: result.reason, tried: result.tried }, { status: 503 });
    const segments = result.segments?.length ? result.segments : segmentsFromText(result.text);
    return NextResponse.json({ text: result.text, engine: result.engine, via: result.via, srt: buildSrt(segments), vtt: buildVtt(segments) });
  }

  if (body.srt?.trim()) {
    const segments = parseSrt(body.srt);
    if (segments.length === 0) return NextResponse.json({ error: "could not parse any cues from srt" }, { status: 422 });
    return NextResponse.json({ engine: "srt-normalize", srt: buildSrt(segments), vtt: buildVtt(segments), segments: segments.length });
  }

  const text = (body.text ?? "").slice(0, 100_000);
  if (!text.trim()) return NextResponse.json({ error: "provide text, srt, or audioBase64" }, { status: 400 });
  const segments = segmentsFromText(text);
  return NextResponse.json({ engine: "auto-time", srt: buildSrt(segments), vtt: buildVtt(segments), segments: segments.length });
}
