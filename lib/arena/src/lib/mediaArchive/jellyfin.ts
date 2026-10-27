/**
 * Jellyfin client for the merged media-archive domain.
 *
 * Real HTTP against a real Jellyfin server (the user's own): user views
 * (libraries) and their items, with watch state (UserData.PlayCount /
 * LastPlayedDate) captured for the native overview. Token = Jellyfin API key,
 * sealed at rest.
 */

import { MediaProviderError, providerJsonFetch, type NormalizedMediaItem } from "./types";

type JellyfinView = { Id?: string; Name?: string; CollectionType?: string };

type JellyfinItem = {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
  UserData?: { PlayCount?: number; LastPlayedDate?: string; PlaybackPositionTicks?: number };
};

const TICKS_PER_MS = 10_000;

function jellyfinItemType(raw: string | undefined): NormalizedMediaItem["itemType"] {
  const value = String(raw ?? "").toLowerCase();
  if (value === "movie") return "movie";
  if (value === "series") return "show";
  if (value === "episode") return "episode";
  return "unknown";
}

export async function fetchJellyfinUserViews(
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<{ key: string; title: string }[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const payload = (await providerJsonFetch(
    `${base}/Users/${encodeURIComponent(userId)}/Views?api_key=${encodeURIComponent(apiKey)}`,
  )) as { Items?: JellyfinView[] };
  const views = payload?.Items;
  if (!Array.isArray(views)) {
    throw new MediaProviderError("bad_response", "Jellyfin /Users/{id}/Views did not contain Items[].");
  }
  return views
    .filter((v) => typeof v.Id === "string" && v.Id && typeof v.Name === "string")
    .map((v) => ({ key: String(v.Id), title: String(v.Name) }));
}

export async function fetchJellyfinItems(
  baseUrl: string,
  apiKey: string,
  userId: string,
  parentId: string,
): Promise<NormalizedMediaItem[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url =
    `${base}/Users/${encodeURIComponent(userId)}/Items?ParentId=${encodeURIComponent(parentId)}` +
    `&Recursive=true&Fields=ProductionYear,UserData,Path&api_key=${encodeURIComponent(apiKey)}`;
  const payload = (await providerJsonFetch(url)) as { Items?: JellyfinItem[] };
  const entries = payload?.Items;
  if (!Array.isArray(entries)) {
    throw new MediaProviderError("bad_response", "Jellyfin /Users/{id}/Items did not contain Items[].");
  }
  const items: NormalizedMediaItem[] = [];
  for (const entry of entries) {
    if (typeof entry.Id !== "string" || !entry.Id || typeof entry.Name !== "string" || !entry.Name) continue;
    const lastPlayed = entry.UserData?.LastPlayedDate ? new Date(entry.UserData.LastPlayedDate) : null;
    items.push({
      ratingKey: entry.Id,
      libraryName: "",
      title: entry.Name,
      year: typeof entry.ProductionYear === "number" && Number.isFinite(entry.ProductionYear) ? entry.ProductionYear : null,
      itemType: jellyfinItemType(entry.Type),
      viewCount:
        typeof entry.UserData?.PlayCount === "number" && (entry.UserData?.PlayCount ?? 0) > 0
          ? Math.floor(entry.UserData.PlayCount)
          : 0,
      viewOffsetMs:
        typeof entry.UserData?.PlaybackPositionTicks === "number" && entry.UserData.PlaybackPositionTicks > 0
          ? Math.floor(entry.UserData.PlaybackPositionTicks / TICKS_PER_MS)
          : 0,
      durationMs:
        typeof entry.RunTimeTicks === "number" && entry.RunTimeTicks > 0
          ? Math.floor(entry.RunTimeTicks / TICKS_PER_MS)
          : null,
      lastViewedAt: lastPlayed && !Number.isNaN(lastPlayed.getTime()) ? lastPlayed : null,
      raw: entry as Record<string, unknown>,
    });
  }
  return items;
}

/** Resolve a usable user id: the explicit one, or the first account found. */
export async function resolveJellyfinUserId(baseUrl: string, apiKey: string): Promise<string> {
  const base = baseUrl.replace(/\/+$/, "");
  const payload = (await providerJsonFetch(`${base}/Users?api_key=${encodeURIComponent(apiKey)}`)) as {
    Id?: string;
    Name?: string;
  }[];
  if (!Array.isArray(payload) || payload.length === 0 || typeof payload[0]?.Id !== "string") {
    throw new MediaProviderError("bad_response", "Jellyfin /Users did not return any user.");
  }
  return payload[0].Id;
}
