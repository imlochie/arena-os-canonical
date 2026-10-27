/**
 * Optional upstream configuration for the personalisation-evidence seam
 * (Gate 6). Since the Archive Assistant merge this seam is UNWIRED in the
 * app: its future is native, deriving behavioral signals from the watch
 * state the merged sync captures (media_library_items.viewCount /
 * lastViewedAt). The client + contract + tests stay as validated
 * scaffolding for that wiring; nothing in the app calls the upstream today.
 *
 * Environment contract (server-only; never NEXT_PUBLIC_*):
 *
 *   ARCHIVE_ASSISTANT_API_URL   Base URL of the optional personalisation
 *                               evidence endpoint. REQUIRED — no default,
 *                               no localhost fallback; a missing value is a
 *                               hard configuration error (the seam is off).
 *   ARCHIVE_ASSISTANT_AUTH_MODE "bearer" (default) | "local"
 *   ARCHIVE_ASSISTANT_OWNER_ID  Required in local mode.
 *   ARCHIVE_ASSISTANT_TIMEOUT_MS Per-request bounded timeout (default
 *                               15000, max 120000).
 */

import { ArchiveAssistantConfigError } from "../archive-assistant/errors";

export type PersonalisationAuthMode = "bearer" | "local";

export type PersonalisationUpstreamConfig = {
  baseUrl: string;
  authMode: PersonalisationAuthMode;
  ownerId: string | null;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

type EnvLike = Record<string, string | undefined>;

export function getPersonalisationUpstreamConfig(env: EnvLike = process.env): PersonalisationUpstreamConfig {
  const rawUrl = env.ARCHIVE_ASSISTANT_API_URL?.trim();
  if (!rawUrl) {
    throw new ArchiveAssistantConfigError(
      "ARCHIVE_ASSISTANT_API_URL is required to use the personalisation evidence seam. " +
        "It must be set explicitly on the server; there is no localhost fallback.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ArchiveAssistantConfigError("ARCHIVE_ASSISTANT_API_URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ArchiveAssistantConfigError("ARCHIVE_ASSISTANT_API_URL must use http or https.");
  }
  const baseUrl = parsed.toString().replace(/\/+$/, "");

  const rawMode = (env.ARCHIVE_ASSISTANT_AUTH_MODE ?? "bearer").trim().toLowerCase();
  if (rawMode !== "bearer" && rawMode !== "local") {
    throw new ArchiveAssistantConfigError(
      `ARCHIVE_ASSISTANT_AUTH_MODE must be "bearer" or "local" (got "${rawMode}").`,
    );
  }
  const authMode: PersonalisationAuthMode = rawMode;

  let ownerId: string | null = null;
  if (authMode === "local") {
    ownerId = env.ARCHIVE_ASSISTANT_OWNER_ID?.trim() || null;
    if (!ownerId) {
      throw new ArchiveAssistantConfigError(
        "ARCHIVE_ASSISTANT_OWNER_ID is required when ARCHIVE_ASSISTANT_AUTH_MODE=local.",
      );
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.ARCHIVE_ASSISTANT_TIMEOUT_MS?.trim();
  if (rawTimeout) {
    const parsedTimeout = Number(rawTimeout);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout < 1 || parsedTimeout > MAX_TIMEOUT_MS) {
      throw new ArchiveAssistantConfigError(
        `ARCHIVE_ASSISTANT_TIMEOUT_MS must be between 1 and ${MAX_TIMEOUT_MS} (got "${rawTimeout}").`,
      );
    }
    timeoutMs = Math.floor(parsedTimeout);
  }

  return { baseUrl, authMode, ownerId, timeoutMs };
}

export function isPersonalisationUpstreamConfigured(env: EnvLike = process.env): boolean {
  try {
    getPersonalisationUpstreamConfig(env);
    return true;
  } catch {
    return false;
  }
}
