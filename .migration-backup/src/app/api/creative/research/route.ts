import { NextResponse } from "next/server";

import { researchAnswer } from "@/lib/creative/research";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST {query, keys?, modelId?} → cited answer + the sources it used. */
export async function POST(req: Request) {
  let body: { query?: string; keys?: Record<string, string>; modelId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const query = (body.query ?? "").slice(0, 1000);
  if (!query.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });
  const result = await researchAnswer(query, { keys: body.keys, modelId: body.modelId });
  return NextResponse.json(result);
}
