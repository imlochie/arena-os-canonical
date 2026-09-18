/**
 * GET /api/archive/findings/:reviewItemId/lineage
 *
 * Explicit, on-demand finding-lineage lookup. Arena does NOT eagerly fetch
 * every finding's history: a workload item carries evidence handles, and the
 * full bounded lineage (current observation + at most one superseded prior
 * observation + provider refresh linkage) is fetched only when requested.
 */

import { getArchiveAssistantConfig, archiveAssistantBaseHost } from "../../../../../../lib/archive-assistant/config";
import { createArchiveAssistantClient, resolveRequestAuth } from "../../../../../../lib/archive-assistant/client";
import { buildFindingLineageFacts } from "../../../../../../lib/archive-assistant/context";
import { archiveAssistantErrorResponse } from "../../../../../../lib/archive-assistant/http";
import type { FindingLineageResponse } from "../../../../../../lib/archive-assistant/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ reviewItemId: string }> }) {
  try {
    const { reviewItemId: raw } = await params;
    const reviewItemId = Number(raw);
    if (!Number.isInteger(reviewItemId) || reviewItemId < 1) {
      return Response.json(
        { ok: false, error: "invalid_review_item_id", message: "reviewItemId must be a positive integer." },
        { status: 400 },
      );
    }

    const config = getArchiveAssistantConfig();
    const auth = resolveRequestAuth(req, config);
    const client = createArchiveAssistantClient(config, auth);

    const lineage = await client.getFindingLineage(reviewItemId);
    const body: FindingLineageResponse = {
      lineage,
      facts: buildFindingLineageFacts(lineage),
      meta: {
        generatedAt: new Date().toISOString(),
        reviewItemId,
        upstreamHost: archiveAssistantBaseHost(config),
      },
    };
    return Response.json(body);
  } catch (error) {
    return archiveAssistantErrorResponse(error);
  }
}
