import { NextResponse } from "next/server";

import { buildPodcastScript, synthesizePodcast } from "@/lib/creative/podcast";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST {text, title?, style?, synthesize?, keys?, modelId?}
 * → {script, lines, engine, via} + audio (base64) when synthesis is requested
 *   and a voice tier is actually available (otherwise an honest reason).
 */
export async function POST(req: Request) {
  let body: {
    text?: string;
    title?: string;
    style?: string;
    synthesize?: boolean;
    keys?: Record<string, string>;
    modelId?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").slice(0, 20000);
  if (!text.trim()) return NextResponse.json({ error: "text is required (paste notes, lyrics, a transcript…)" }, { status: 400 });

  const script = await buildPodcastScript(text, { title: body.title, style: body.style, keys: body.keys, modelId: body.modelId });

  if (!body.synthesize) return NextResponse.json({ script });
  const audio = await synthesizePodcast(script, { keys: { elevenlabs: body.keys?.elevenlabs } });
  if (!audio.ok) {
    return NextResponse.json({
      script,
      audio: null,
      audioReason: audio.reason,
    });
  }
  return NextResponse.json({
    script,
    audio: { base64: audio.buffer.toString("base64"), mime: audio.mime, engine: audio.engine },
  });
}
