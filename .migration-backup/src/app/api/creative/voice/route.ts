import { NextResponse } from "next/server";

import { speakText, voiceEngineStatus } from "@/lib/creative/voice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET → honest per-tier engine status for the UI. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const keys = { elevenlabs: url.searchParams.get("elevenlabs") ?? undefined };
  return NextResponse.json({ engines: await voiceEngineStatus(keys) });
}

/** POST {text, voice?, keys?} → real audio, or an honest 503 with the reason. */
export async function POST(req: Request) {
  let body: { text?: string; voice?: string; keys?: { elevenlabs?: string } } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").slice(0, 5000);
  if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const result = await speakText(text, { voice: body.voice, keys: body.keys });
  if (!result.ok) return NextResponse.json({ error: result.reason, tried: result.tried }, { status: 503 });
  return new NextResponse(new Uint8Array(result.buffer), {
    headers: { "Content-Type": result.mime, "X-Arena-Engine": result.engine, "X-Arena-Via": result.via },
  });
}
