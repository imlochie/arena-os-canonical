/**
 * Server-only configuration for the Archive Assistant read-only bridge.
 *
 * Environment contract (all server-only; never NEXT_PUBLIC_*):
 *
 *   ARCHIVE_ASSISTANT_API_URL   Base URL of the Archive Assistant HTTP API,
 *                               e.g. https://archive-assistant.example.com/api
 *                               REQUIRED. No default, no localhost fallback —
 *                               a missing value is a hard configuration error.
 *
 *   ARCHIVE_ASSISTANT_AUTH_MODE "bearer" (default, production):
 *                                 Arena forwards the authenticated user's
 *                                 bearer token server-to-server; Archive
 *                                 Assistant validates it (Clerk) and derives
 *                                 the owner from the authenticated identity.
 *                               "local" (development only):
 *                                 For use against a locally running Archive
 *                                 Assistant whose server resolves its own
 *                                 stable owner. Requires
 *                                 ARCHIVE_ASSISTANT_OWNER_ID.
 *
 *   ARCHIVE_ASSISTANT_OWNER_ID  Owner id attached as a server-configured
 *                               constant in "local" mode only. Arbitrary
 *                               client-provided owner ids are never part of
 *                               the contract: the value comes from server
 *                               env, never from the browser.
 *
 *   ARCHIVE_ASSISTANT_TIMEOUT_MS
 *                               Per-request bounded timeout (default 15000,
 *                               max 120000).
 *
 * The test-only `x-test-owner-id` header is never emitted by this bridge in
 * any mode (see client.ts).
 */

import { ArchiveAssistantConfigError } from "./errors";

export type ArchiveAssistantAuthMode = "bearer" | "local";

export type ArchiveAssistantConfig = {
  /** Normalized API base URL (no trailing slash), e.g. https://host/api */
  baseUrl: string;
  authMode: ArchiveAssistantAuthMode;
  /** Present only in local mode. */
  ownerId: string | null;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

type EnvLike = Record<string, string | undefined>;

export function getArchiveAssistantConfig(
  env: EnvLike = process.env,
): ArchiveAssistantConfig {
  const rawUrl = env.ARCHIVE_ASSISTANT_API_URL?.trim();
  if (!rawUrl) {
    throw new ArchiveAssistantConfigError(
      "ARCHIVE_ASSISTANT_API_URL is required to use the Archive Assistant bridge. " +
        "It must be set explicitly on the server; there is no localhost fallback.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ArchiveAssistantConfigError(
      "ARCHIVE_ASSISTANT_API_URL is not a valid URL.",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ArchiveAssistantConfigError(
      "ARCHIVE_ASSISTANT_API_URL must use http or https.",
    );
  }
  const baseUrl = parsed.toString().replace(/\/+$/, "");

  const rawMode = (env.ARCHIVE_ASSISTANT_AUTH_MODE ?? "bearer").trim().toLowerCase();
  if (rawMode !== "bearer" && rawMode !== "local") {
    throw new ArchiveAssistantConfigError(
      `ARCHIVE_ASSISTANT_AUTH_MODE must be "bearer" or "local" (got "${rawMode}").`,
    );
  }
  const authMode: ArchiveAssistantAuthMode = rawMode;

  let ownerId: string | null = null;
  if (authMode === "local") {
    ownerId = env.ARCHIVE_ASSISTANT_OWNER_ID?.trim() || null;
    if (!ownerId) {
      throw new ArchiveAssistantConfigError(
        "ARCHIVE_ASSISTANT_OWNER_ID is required when ARCHIVE_ASSISTANT_AUTH_MODE=local. " +
          "The owner id is a server-configured constant; it is never accepted from a client.",
      );
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.ARCHIVE_ASSISTANT_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const parsedTimeout = Number(rawTimeout);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout < 1 || parsedTimeout > MAX_TIMEOUT_MS) {
      throw new ArchiveAssistantConfigError(
        `ARCHIVE_ASSISTANT_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS}.`,
      );
    }
    timeoutMs = Math.floor(parsedTimeout);
  }

  return { baseUrl, authMode, ownerId, timeoutMs };
}

export function isArchiveAssistantConfigured(env: EnvLike = process.env): boolean {
  try {
    getArchiveAssistantConfig(env);
    return true;
  } catch {
    return false;
  }
}

/** Minimal host name for provenance output — never includes credentials,
 *  path, or query components of the configured URL. */
export function archiveAssistantBaseHost(config: ArchiveAssistantConfig): string {
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return "unknown";
  }
}
