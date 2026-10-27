/**
 * Space watchers — recurring, real observation tasks.
 *
 * The flagship case: "watch my YouTube channel and take notes of all my
 * descriptions." YouTube publishes every channel's uploads as an RSS feed
 * (youtube.com/feeds/videos.xml?channel_id=…), so a watcher needs NO API
 * key, NO quota, NO cost — one fetch per tick. Playlists work the same way
 * (?playlist_id=…). @handles are resolved best-effort from the channel page
 * (honest failure if YouTube changes the page shape).
 *
 * Every tick: fetch the feed → diff against the seen set → new videos'
 * titles + descriptions become the watcher's notes (appended to the space's
 * briefcase and recorded as a run). Nothing is invented: a fetch failure is
 * recorded as the run's output, verbatim.
 */

export interface FeedEntry {
  videoId: string;
  title: string;
  published: string;
  description: string;
  url: string;
}

export interface WatchState {
  seenIds: string[];
  lastCheckedAt?: string;
}

export interface WatchResult {
  ok: boolean;
  newEntries: FeedEntry[];
  total: number;
  notes: string;
  error?: string;
}

/** Parse a YouTube RSS feed (regex-based; the feed is stable XML). */
export function parseYouTubeFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const blocks = xml.split(/<entry>/).slice(1);
  for (const b of blocks) {
    const grab = (tag: string) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return "";
      return m[1]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .trim();
    };
    const idUrl = grab("id"); // yt:video:VIDEOID
    const videoId = idUrl.replace(/^yt:video:/, "");
    if (!videoId) continue;
    entries.push({
      videoId,
      title: grab("title"),
      published: grab("published"),
      description: grab("media:description"),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return entries;
}

export function feedUrlFor(watchType: string, source: string): string {
  if (watchType === "youtube-playlist") return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(source)}`;
  // handle → best-effort resolve happens at fetch time
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source)}`;
}

export async function resolveYouTubeSource(watchType: string, source: string, fetcher = fetch): Promise<{ url: string; resolved: string }> {
  if (watchType === "youtube-channel" && source.startsWith("@")) {
    // Best-effort: the channel page embeds the channel id.
    const res = await fetcher(`https://www.youtube.com/${source}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ArenaOS-Space/1.0)" },
    });
    const html = await res.text();
    const m =
      html.match(/"channelId":"(UC[\w-]{22})"/) ||
      html.match(/channel\/(UC[\w-]{22})/);
    if (!m) throw new Error(`could not resolve ${source} to a channel id — paste the channel id (UC…) instead`);
    return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`, resolved: m[1] };
  }
  return { url: feedUrlFor(watchType, source), resolved: source };
}

export function formatNotes(entries: FeedEntry[]): string {
  return entries
    .map(
      (e) =>
        `### ${e.title}\n${e.published ? "_" + e.published.slice(0, 10) + "_ · " : ""}${e.url}\n\n${e.description || "(no description)"}`
    )
    .join("\n\n");
}

/** One watcher pass. Pure apart from the fetcher — tests inject fixtures. */
export async function runWatchPass(
  watchType: string,
  source: string,
  state: WatchState,
  fetcher = fetch
): Promise<WatchResult & { state: WatchState }> {
  try {
    const { url } = await resolveYouTubeSource(watchType, source, fetcher);
    const res = await fetcher(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ArenaOS-Space/1.0)" },
    });
    if (!res.ok) {
      return { ok: false, newEntries: [], total: 0, notes: "", error: `feed fetch failed: ${res.status} ${res.statusText}`, state: { ...state, lastCheckedAt: new Date().toISOString() } };
    }
    const xml = await res.text();
    const entries = parseYouTubeFeed(xml);
    const seen = new Set(state.seenIds);
    const fresh = entries.filter((e) => !seen.has(e.videoId));
    return {
      ok: true,
      newEntries: fresh,
      total: entries.length,
      notes: formatNotes(fresh),
      state: {
        seenIds: entries.map((e) => e.videoId).slice(0, 500),
        lastCheckedAt: new Date().toISOString(),
      },
    };
  } catch (e) {
    return {
      ok: false, newEntries: [], total: 0, notes: "",
      error: e instanceof Error ? e.message : "watch failed",
      state: { ...state, lastCheckedAt: new Date().toISOString() },
    };
  }
}
