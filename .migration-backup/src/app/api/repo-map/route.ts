import { NextResponse } from "next/server";

import { buildRepoMap, repoMapToPrompt } from "@/lib/repoMap";

export const dynamic = "force-dynamic";

/** GET → the live repo map (paths, LOC, exports). ?format=prompt for the compact LLM form. */
export async function GET(req: Request) {
  const map = await buildRepoMap();
  if (new URL(req.url).searchParams.get("format") === "prompt") {
    return new NextResponse(repoMapToPrompt(map), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.json(map);
}
