/**
 * GET /api/archive/context
 *
 * Arena-side, read-only archive context assembly. The route:
 *   1. authenticates (bearer forwarding, or explicit local dev mode);
 *   2. calls Archive Assistant through the server-side read-only client;
 *   3. fetches the bounded six-part context (overview, workload,
 *      reconciliation summary, plex + jellyfin refresh state, and — with
 *      ?history=1 — one bounded history page per provider);
 *   4. returns normalized facts with evidence handles;
 *   5. never mutates either system.
 *
 * Archive Assistant database concepts (owners rows, review item payloads,
 * raw provider payloads, filesystem paths) never cross this route.
 */

import { getArchiveAssistantConfig, archiveAssistantBaseHost } from "../../../../lib/archive-assistant/config";
import { createArchiveAssistantClient, resolveRequestAuth } from "../../../../lib/archive-assistant/client";
import { buildArchiveContext } from "../../../../lib/archive-assistant/context";
import { archiveAssistantErrorResponse } from "../../../../lib/archive-assistant/http";
import type { ArchiveContextResponse } from "../../../../lib/archive-assistant/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const started = Date.now();
  try {
    const config = getArchiveAssistantConfig();
    const auth = resolveRequestAuth(req, config);
    const client = createArchiveAssistantClient(config, auth);

    const includeHistory = new URL(req.url).searchParams.get("history") === "1";
    const built = await buildArchiveContext(client, { includeHistory });

    const body: ArchiveContextResponse = {
      context: built.context,
      facts: built.facts,
      meta: {
        generatedAt: built.context.generatedAt,
        authMode: config.authMode,
        upstreamHost: archiveAssistantBaseHost(config),
        latencyMs: Date.now() - started,
        factsTruncated: built.factsTruncated,
        refreshHistoryIncluded: includeHistory,
      },
      ...(built.refreshHistory ? { refreshHistory: built.refreshHistory } : {}),
    };
    return Response.json(body);
  } catch (error) {
    return archiveAssistantErrorResponse(error);
  }
}
