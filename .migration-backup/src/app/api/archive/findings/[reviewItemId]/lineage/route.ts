/**
 * GET /api/archive/findings/:reviewItemId/lineage
 *
 * Explicit, on-demand finding-lineage lookup — NATIVE since the Archive
 * Assistant merge. Arena does NOT eagerly fetch every finding's history: a
 * workload item carries evidence handles, and the full bounded lineage
 * (current observation + at most one superseded prior observation +
 * provider refresh linkage) is fetched only when requested.
 */

import { buildFindingLineageFacts } from "@/lib/archive-assistant/context";
import { createNativeArchiveContextClient } from "@/lib/mediaArchive/contextClient";
import {
  ArchiveAssistantContractError,
  ArchiveAssistantNotFoundError,
  isArchiveAssistantError,
} from "@/lib/archive-assistant/errors";
import type { FindingLineageResponse } from "@/lib/archive-assistant/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ reviewItemId: string }> }) {
  try {
    const { reviewItemId: raw } = await params;
    const reviewItemId = Number(raw);
    if (!Number.isInteger(reviewItemId) || reviewItemId < 1) {
      return Response.json(
        { ok: false, error: "invalid_review_item_id", message: "reviewItemId must be a positive integer." },
        { status: 400 },
      );
    }

    const client = createNativeArchiveContextClient();
    const lineage = await client.getFindingLineage(reviewItemId);
    const body: FindingLineageResponse = {
      lineage,
      facts: buildFindingLineageFacts(lineage),
      meta: {
        generatedAt: new Date().toISOString(),
        reviewItemId,
        upstreamHost: "arena-native",
      },
    };
    return Response.json(body);
  } catch (error) {
    if (error instanceof ArchiveAssistantNotFoundError) {
      return Response.json({ ok: false, error: "archive_assistant_not_found", message: error.message }, { status: 404 });
    }
    if (error instanceof ArchiveAssistantContractError) {
      return Response.json(
        { ok: false, error: "archive_assistant_contract_violation", message: error.message },
        { status: 500 },
      );
    }
    if (isArchiveAssistantError(error)) {
      return Response.json({ ok: false, error: error.kind, message: error.message }, { status: 500 });
    }
    console.error(error);
    return Response.json({ ok: false, error: "lineage_failed", message: "Unexpected error." }, { status: 500 });
  }
}
