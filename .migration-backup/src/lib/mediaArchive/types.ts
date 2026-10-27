/**
 * Shared shapes for the merged media-archive domain (Wave 5b).
 *
 * The Archive Assistant used to be a separate app Arena talked to over a
 * read-only HTTP bridge. It is now native: these are the normalized shapes
 * the plex/jellyfin clients produce, the sync engine records, and the
 * reconciliation engine reasons over. The six-operation read surface keeps
 * its GENERATED contract types (../archive-assistant/generated/types.ts) —
 * the native client must still validate against them.
 */

export type MediaProviderKind = "plex" | "jellyfin" | "local";

export const MEDIA_PROVIDER_KINDS: readonly MediaProviderKind[] = ["plex", "jellyfin", "local"];

export function isMediaProviderKind(value: string): value is MediaProviderKind {
  return value === "plex" || value === "jellyfin" || value === "local";
}

/** One normalized library item, provider-agnostic. */
export type NormalizedMediaItem = {
  ratingKey: string;
  libraryName: string;
  title: string;
  year: number | null;
  itemType: "movie" | "show" | "episode" | "unknown";
  viewCount: number;
  viewOffsetMs: number;
  durationMs: number | null;
  lastViewedAt: Date | null;
  raw: Record<string, unknown>;
};

/** One provider's full snapshot after a sync. */
export type ProviderSnapshot = {
  provider: MediaProviderKind;
  libraries: { key: string; title: string }[];
  items: NormalizedMediaItem[];
  /** Libraries that failed while others succeeded → partial snapshot. */
  failedLibraries: { library: string; reason: string }[];
};

export class MediaProviderError extends Error {
  readonly code: "auth_failed" | "connect_failed" | "bad_response" | "not_configured";
  constructor(code: "auth_failed" | "connect_failed" | "bad_response" | "not_configured", message: string) {
    super(message);
    this.name = "MediaProviderError";
    this.code = code;
  }
}

/** Provider-agnostic JSON GET with timeout + honest error mapping. */
export async function providerJsonFetch(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: "no-store",
    });
  } catch (error) {
    const code = (error as { name?: string })?.name === "TimeoutError" ? "connect_failed" : "connect_failed";
    throw new MediaProviderError(code, `Provider request failed: ${String((error as Error)?.message ?? error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new MediaProviderError("auth_failed", `Provider rejected the token (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new MediaProviderError("bad_response", `Provider answered HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new MediaProviderError("bad_response", "Provider answer was not JSON.");
  }
}

/** Normalize a provider identity for matching: lowercase, strip punctuation. */
export function normalizeMediaTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Identity key used to match a local archive file to a provider item. */
export function mediaIdentityKey(title: string, year: number | null): string {
  return year ? `${normalizeMediaTitle(title)}|${year}` : normalizeMediaTitle(title);
}
