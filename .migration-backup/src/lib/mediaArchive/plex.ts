/**
 * Plex client for the merged media-archive domain.
 *
 * Real HTTP against a real Plex server (the user's own): library sections
 * and their items, with watch state (viewCount / lastViewedAt / viewOffset)
 * captured so the native overview can report honest media experience.
 * Token = the account's X-Plex-Token value, sealed at rest.
 */

import { MediaProviderError, providerJsonFetch, type NormalizedMediaItem } from "./types";

type PlexDirectory = {
  key?: string;
  title?: string;
  type?: string;
};

type PlexMetadata = {
  ratingKey?: string;
  title?: string;
  year?: number;
  type?: string | number;
  viewCount?: number;
  lastViewedAt?: number;
  viewOffset?: number;
  duration?: number;
  librarySectionTitle?: string;
};

function plexItemType(raw: string | number | undefined): NormalizedMediaItem["itemType"] {
  // Plex library types: 1 = movie, 2 = show, 3 = season, 4 = episode.
  const value = String(raw ?? "");
  if (value === "1" || value === "movie") return "movie";
  if (value === "2" || value === "show") return "show";
  if (value === "4" || value === "episode") return "episode";
  return "unknown";
}

function plexEpochToDate(value: number | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fetchPlexLibraries(baseUrl: string, token: string): Promise<{ key: string; title: string }[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const payload = (await providerJsonFetch(`${base}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`)) as {
    MediaContainer?: { Directory?: PlexDirectory[] };
  };
  const directories = payload?.MediaContainer?.Directory;
  if (!Array.isArray(directories)) {
    throw new MediaProviderError("bad_response", "Plex /library/sections did not contain Directory[].");
  }
  return directories
    .filter((d) => typeof d.key === "string" && d.key && typeof d.title === "string")
    .map((d) => ({ key: String(d.key), title: String(d.title) }));
}

export async function fetchPlexLibraryItems(
  baseUrl: string,
  token: string,
  sectionKey: string,
): Promise<NormalizedMediaItem[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const payload = (await providerJsonFetch(
    `${base}/library/sections/${encodeURIComponent(sectionKey)}/all?X-Plex-Token=${encodeURIComponent(token)}`,
  )) as { MediaContainer?: { Metadata?: PlexMetadata[] } };
  const metadata = payload?.MediaContainer?.Metadata;
  if (!Array.isArray(metadata)) {
    throw new MediaProviderError("bad_response", `Plex section ${sectionKey} did not contain Metadata[].`);
  }
  const items: NormalizedMediaItem[] = [];
  for (const m of metadata) {
    if (typeof m.ratingKey !== "string" || !m.ratingKey || typeof m.title !== "string" || !m.title) continue;
    items.push({
      ratingKey: m.ratingKey,
      libraryName: typeof m.librarySectionTitle === "string" ? m.librarySectionTitle : "",
      title: m.title,
      year: typeof m.year === "number" && Number.isFinite(m.year) ? m.year : null,
      itemType: plexItemType(m.type),
      viewCount: typeof m.viewCount === "number" && m.viewCount > 0 ? Math.floor(m.viewCount) : 0,
      viewOffsetMs: typeof m.viewOffset === "number" && m.viewOffset > 0 ? Math.floor(m.viewOffset) : 0,
      durationMs: typeof m.duration === "number" && m.duration > 0 ? Math.floor(m.duration) : null,
      lastViewedAt: plexEpochToDate(m.lastViewedAt),
      raw: m as Record<string, unknown>,
    });
  }
  return items;
}
