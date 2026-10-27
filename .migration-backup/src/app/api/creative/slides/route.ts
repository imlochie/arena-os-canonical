import { NextResponse } from "next/server";

import { buildDeck, deckToHtml, deckToPptx } from "@/lib/creative/slides";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST {prompt, count?, keys?, modelId?} → deck + HTML + PPTX (base64). */
export async function POST(req: Request) {
  let body: { prompt?: string; count?: number; keys?: Record<string, string>; modelId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const prompt = (body.prompt ?? "").slice(0, 4000);
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });

  const deck = await buildDeck(prompt, { count: body.count, keys: body.keys, modelId: body.modelId });
  const [html, pptx] = await Promise.all([deckToHtml(deck), deckToPptx(deck)]);
  return NextResponse.json({
    deck,
    html,
    pptxBase64: pptx.toString("base64"),
  });
}
