/**
 * GET /api/archive/context
 *
 * Read-only archive context assembly — NATIVE since the Archive Assistant
 * merge. The route:
 *   1. builds the six-part context through the native client (Arena's own
 *      tables: overview, workload, reconciliation summary, plex + jellyfin
 *      refresh state, and — with ?history=1 — one bounded history page per
 *      provider);
 *   2. returns normalized facts with evidence handles;
 *   3. never mutates anything.
 *
 * Every native response is validated against the same generated contract
 * the old HTTP bridge enforced, so a native bug still fails closed.
 */

import { buildArchiveContext } from "@/lib/archive-assistant/context";
import { createNativeArchiveContextClient } from "@/lib/mediaArchive/contextClient";
import {
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  isArchiveAssistantError,
} from "@/lib/archive-assistant/errors";
import type { ArchiveContextResponse } from "@/lib/archive-assistant/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const started = Date.now();
  try {
    const client = createNativeArchiveContextClient();
    const includeHistory = new URL(req.url).searchParams.get("history") === "1";
    const built = await buildArchiveContext(client, { includeHistory });

    const body: ArchiveContextResponse = {
      context: built.context,
      facts: built.facts,
      meta: {
        generatedAt: built.context.generatedAt,
        authMode: "native",
        upstreamHost: "arena-native",
        latencyMs: Date.now() - started,
        factsTruncated: built.factsTruncated,
        refreshHistoryIncluded: includeHistory,
      },
      ...(built.refreshHistory ? { refreshHistory: built.refreshHistory } : {}),
    };
    return Response.json(body);
  } catch (error) {
    if (error instanceof ArchiveAssistantContractError) {
      return Response.json(
        { ok: false, error: "archive_assistant_contract_violation", message: error.message },
        { status: 500 }, // native bug, not upstream drift — still fails closed
      );
    }
    if (isArchiveAssistantError(error)) {
      return Response.json({ ok: false, error: error.kind, message: error.message }, { status: 500 });
    }
    console.error(error);
    return Response.json({ ok: false, error: "archive_context_failed", message: "Unexpected error." }, { status: 500 });
  }
}
