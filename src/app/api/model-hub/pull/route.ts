/**
 * Model download — proxies an Ollama pull stream.
 *
 * POST /api/model-hub/pull { baseUrl, model }
 *   → NDJSON stream (passthrough of Ollama's own progress events:
 *     {"status":"pulling manifest"} … {"status":"success"})
 *
 * Loopback-gated like every hub URL. The model tag is validated against
 * Ollama's tag charset so it can never smuggle path segments.
 */

import { NextResponse } from "next/server";

import { requireUser } from "@/lib/waveyard/local-context";
import { assertLoopbackUrl } from "@/lib/modelHub/runtimes";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const OLLAMA_TAG = /^[a-zA-Z0-9._:/-]{1,120}$/;

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => ({}))) as { baseUrl?: unknown; model?: unknown };
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (baseUrl === "" || model === "") {
      return NextResponse.json({ error: "baseUrl and model are required." }, { status: 400 });
    }
    if (!OLLAMA_TAG.test(model)) {
      return NextResponse.json({ error: "That is not a valid model tag." }, { status: 400 });
    }
    const url = assertLoopbackUrl(baseUrl);

    const upstream = await fetch(`${url.origin}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      // Long downloads: no AbortController timeout — the client can cancel
      // by aborting its own fetch.
    });
    if (!upstream.ok || upstream.body === null) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `The runtime refused the pull (HTTP ${upstream.status}). ${detail.slice(0, 200)}`.trim() },
        { status: 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "The pull could not be started.";
    console.error("model pull failed", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
