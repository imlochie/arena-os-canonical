/**
 * Server-side live status probe for the Archive Assistant room.
 *
 * The rooms map stays static; this helper answers the only question that
 * changes at runtime: is the bridge to the Archive Assistant app actually
 * connected right now? It performs ONE bounded read (getOverview) through
 * the same six-operation read-only client the /api/archive/context route
 * uses — no new capability, no writes, ever.
 *
 * Outcomes:
 *   unconfigured      ARCHIVE_ASSISTANT_API_URL is not set on the server
 *   bearer-configured bearer mode is set; probing requires an authenticated
 *                     request through /api/archive/context (no page-level probe)
 *   unreachable       network/timeout/API error from the configured host
 *   auth-required     upstream rejected the local owner id
 *   contract-mismatch upstream answered but not in the pinned contract shape
 *   connected         real overview facts from the real app
 */

import { createArchiveAssistantClient } from "./client";
import {
  archiveAssistantBaseHost,
  getArchiveAssistantConfig,
  isArchiveAssistantConfigured,
} from "./config";
import {
  ArchiveAssistantApiError,
  ArchiveAssistantContractError,
  ArchiveAssistantTimeoutError,
  ArchiveAssistantUpstreamAuthError,
} from "./errors";

export type ArchiveBridgeStatus =
  | { state: "unconfigured" }
  | { state: "bearer-configured"; host: string }
  | { state: "unreachable"; host: string; detail: string }
  | { state: "auth-required"; host: string; detail: string }
  | { state: "contract-mismatch"; host: string; detail: string }
  | {
      state: "connected";
      host: string;
      health: string;
      attentionCount: number;
      scanStatus: string;
      acquisitionJobs: number;
      informational: string[];
    };

export async function getArchiveBridgeStatus(): Promise<ArchiveBridgeStatus> {
  if (!isArchiveAssistantConfigured()) {
    return { state: "unconfigured" };
  }
  const config = getArchiveAssistantConfig();
  const host = archiveAssistantBaseHost(config);

  if (config.authMode === "bearer") {
    // No page-level probe in bearer mode: the token belongs to an
    // authenticated request, not to a page render. The full context is
    // available via GET /api/archive/context with credentials.
    return { state: "bearer-configured", host };
  }

  const client = createArchiveAssistantClient(config, {
    mode: "local",
    ownerId: config.ownerId ?? "",
  });

  try {
    const overview = await client.getOverview();
    return {
      state: "connected",
      host,
      health: String(overview.summary.health),
      attentionCount: Number(overview.summary.attentionCount ?? 0),
      scanStatus: String(overview.activeWork.scanStatus),
      acquisitionJobs: Number(overview.activeWork.acquisitionJobs ?? 0),
      informational: Array.isArray(overview.informational)
        ? overview.informational.slice(0, 3).map((item) => String(item))
        : [],
    };
  } catch (error) {
    if (error instanceof ArchiveAssistantUpstreamAuthError) {
      return { state: "auth-required", host, detail: error.message };
    }
    if (error instanceof ArchiveAssistantContractError) {
      return { state: "contract-mismatch", host, detail: error.message };
    }
    if (
      error instanceof ArchiveAssistantTimeoutError ||
      error instanceof ArchiveAssistantApiError
    ) {
      return { state: "unreachable", host, detail: error.message };
    }
    return {
      state: "unreachable",
      host,
      detail: error instanceof Error ? error.message : "Unknown bridge error.",
    };
  }
}
