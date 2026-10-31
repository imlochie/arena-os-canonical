/**
 * Library sync — the streaming-library bridge (vision §V6: "connect to an
 * actual audio library... sync my streaming libraries automatically and
 * easily creating backups", the Songify / TuneMyMusic ground).
 *
 * HONEST ARCHITECTURE (the licensing wall, stated once, up front):
 * stem.fm streams its own LICENSED catalog — that is a label deal, not an
 * API. No third-party app can stream full Spotify/Apple tracks into a Web
 * Audio graph, and Spotify killed preview_url for third-party apps (Nov
 * 2024) while prohibiting syncing their content with video. So the
 * personal edge is built where the APIs are real:
 *
 *   1. YOUR LIBRARY AS THE CATALOG — connect Spotify / Apple Music /
 *      YouTube accounts, snapshot their playlists + likes (the APIs that
 *      genuinely exist), and browse/search them inside Waveyard. Dispatch
 *      into the stem pipeline happens through the app's existing intake
 *      (drop a file you have, or an authorized link) — never a ripper.
 *   2. SYNC + BACKUP — snapshot, diff ("what changed since last sync"),
 *      export to JSON/CSV, import a backup from any service. The
 *      Songify/TuneMyMusic job, self-contained, no subscription.
 *
 * Everything in this file is pure and side-effect free: the adapters map
 * DOCUMENTED payload shapes to the canonical model, the matcher scores
 * track identity across services, the diff engine compares snapshots, and
 * the serializers round-trip backups. No network code lives here.
 */

// ------------------------------------------------------------------ model

export const STREAMING_SERVICES = ["spotify", "apple", "youtube"] as const;
export type StreamingService = (typeof STREAMING_SERVICES)[number];

export function isStreamingService(value: unknown): value is StreamingService {
  return typeof value === "string" && (STREAMING_SERVICES as readonly string[]).includes(value);
}

/** One track, as a streaming library reports it (canonical form). */
export type ExternalTrack = {
  service: StreamingService;
  externalId: string;
  title: string;
  artists: string[];
  album: string | null;
  isrc: string | null;
  durationMs: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  trackCount?: number | null;
  discCount?: number | null;
  year?: number | null;
  albumArtist?: string | null;
  genre?: string | null;
  composer?: string | null;
  /** A provider URL reference; this does not mean the artwork file is archived. */
  artworkUrl?: string | null;
  rating?: number | null;
  playCount?: number | null;
  skipCount?: number | null;
  dateAdded?: string | null;
  lastPlayedAt?: string | null;
  releaseDate?: string | null;
  bitRate?: number | null;
  sampleRate?: number | null;
  kind?: string | null;
  comments?: string | null;
};

/** One playlist (canonical form). */
export type ExternalPlaylist = {
  externalId: string;
  name: string;
  description: string | null;
  tracks: ExternalTrack[];
};

/** A full library snapshot — the backup unit. */
export type LibrarySnapshot = {
  service: StreamingService;
  /** ISO timestamp of the pull. */
  takenAt: string;
  accountName: string | null;
  playlists: ExternalPlaylist[];
  likedTracks: ExternalTrack[];
};

const MAX_TITLE_LENGTH = 500;
const MAX_PLAYLISTS = 2000;
const MAX_TRACKS_PER_PLAYLIST = 10_000;
const MAX_LIKED = 20_000;

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function cleanIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function boundedMetadataInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,10}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function cleanArtworkUrl(value: unknown): string | null {
  const candidate = cleanString(value, 2048);
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")
      : null;
  } catch {
    return null;
  }
}

function parseTrack(raw: unknown, service: StreamingService): ExternalTrack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const externalId = typeof input.externalId === "string" && input.externalId.length > 0 && input.externalId.length <= 256 ? input.externalId : null;
  const title = cleanString(input.title, MAX_TITLE_LENGTH);
  if (externalId === null || title === null) return null;
  const artists = Array.isArray(input.artists)
    ? input.artists.filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0).slice(0, 12).map((artist) => artist.trim().slice(0, 200))
    : [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  return {
    service,
    externalId,
    title,
    artists,
    album: cleanString(input.album, MAX_TITLE_LENGTH),
    isrc: parseIsrc(input.isrc),
    durationMs: typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : null,
    ...(has("trackNumber") ? { trackNumber: boundedMetadataInteger(input.trackNumber, 1, 65535) } : {}),
    ...(has("discNumber") ? { discNumber: boundedMetadataInteger(input.discNumber, 1, 65535) } : {}),
    ...(has("trackCount") ? { trackCount: boundedMetadataInteger(input.trackCount, 1, 65535) } : {}),
    ...(has("discCount") ? { discCount: boundedMetadataInteger(input.discCount, 1, 65535) } : {}),
    ...(has("year") ? { year: boundedMetadataInteger(input.year, 1000, 9999) } : {}),
    ...(has("albumArtist") ? { albumArtist: cleanString(input.albumArtist, 200) } : {}),
    ...(has("genre") ? { genre: cleanString(input.genre, 200) } : {}),
    ...(has("composer") ? { composer: cleanString(input.composer, 200) } : {}),
    ...(has("artworkUrl") ? { artworkUrl: cleanArtworkUrl(input.artworkUrl) } : {}),
    ...(has("rating") ? { rating: boundedMetadataInteger(input.rating, 0, 100) } : {}),
    ...(has("playCount") ? { playCount: boundedMetadataInteger(input.playCount, 0, 1_000_000_000) } : {}),
    ...(has("skipCount") ? { skipCount: boundedMetadataInteger(input.skipCount, 0, 1_000_000_000) } : {}),
    ...(has("dateAdded") ? { dateAdded: cleanIsoDate(input.dateAdded) } : {}),
    ...(has("lastPlayedAt") ? { lastPlayedAt: cleanIsoDate(input.lastPlayedAt) } : {}),
    ...(has("releaseDate") ? { releaseDate: cleanIsoDate(input.releaseDate) } : {}),
    ...(has("bitRate") ? { bitRate: boundedMetadataInteger(input.bitRate, 1, 1_000_000) } : {}),
    ...(has("sampleRate") ? { sampleRate: boundedMetadataInteger(input.sampleRate, 1, 768_000) } : {}),
    ...(has("kind") ? { kind: cleanString(input.kind, 200) } : {}),
    ...(has("comments") ? { comments: cleanString(input.comments, 2000) } : {}),
  };
}

/** ISRC identity: the bare 12-char form (hyphenated input normalized). */
export function parseIsrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.replace(/-/g, "").trim().toUpperCase();
  return /^[A-Z0-9]{12}$/.test(bare) ? bare : null;
}

function parsePlaylist(raw: unknown, service: StreamingService): ExternalPlaylist | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const externalId = typeof input.externalId === "string" && input.externalId.length > 0 && input.externalId.length <= 256 ? input.externalId : null;
  const name = cleanString(input.name, MAX_TITLE_LENGTH);
  if (externalId === null || name === null) return null;
  return {
    externalId,
    name,
    description: cleanString(input.description, 2000),
    tracks: Array.isArray(input.tracks)
      ? input.tracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map((track) => parseTrack(track, service)).filter((track): track is ExternalTrack => track !== null)
      : [],
  };
}

/**
 * Total validation: ANY unknown value becomes a snapshot or null. Limits
 * are enforced (a hostile 10 GB "snapshot" is rejected, not stored).
 */
export function parseLibrarySnapshot(raw: unknown): LibrarySnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (!isStreamingService(input.service)) return null;
  if (typeof input.takenAt !== "string" || Number.isNaN(Date.parse(input.takenAt))) return null;
  const service = input.service;
  return {
    service,
    takenAt: input.takenAt,
    accountName: cleanString(input.accountName, 200),
    playlists: Array.isArray(input.playlists)
      ? input.playlists.slice(0, MAX_PLAYLISTS).map((playlist) => parsePlaylist(playlist, service)).filter((playlist): playlist is ExternalPlaylist => playlist !== null)
      : [],
    likedTracks: Array.isArray(input.likedTracks)
      ? input.likedTracks.slice(0, MAX_LIKED).map((track) => parseTrack(track, service)).filter((track): track is ExternalTrack => track !== null)
      : [],
  };
}

/** Honest counts for storage + UI. */
export function snapshotStats(snapshot: LibrarySnapshot): { playlists: number; tracks: number; tracksWithIsrc: number } {
  const playlistTracks = snapshot.playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
  const all = [...snapshot.likedTracks, ...snapshot.playlists.flatMap((playlist) => playlist.tracks)];
  return {
    playlists: snapshot.playlists.length,
    tracks: playlistTracks + snapshot.likedTracks.length,
    tracksWithIsrc: all.filter((track) => track.isrc !== null).length,
  };
}

// --------------------------------------------------------------- matching

const FEAT_PATTERN = /\s*[([]\s*(?:feat\.?|featuring|with)\s+[^)\]]*[)\]]/gi;
const VERSION_PATTERN = /\s*[-–—(]\s*(?:remaster(?:ed)?|deluxe|live|radio edit|single version|album version|mono|stereo|bonus track|explicit|clean)[^)\]]*[)\]]?/gi;
const PUNCTUATION = /[.,/\\|:;!?'"“”‘’`~@#$%^&*+=_<>()\[\]{}—–…]/g;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/['\u2018\u2019`]/g, "")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title identity: feat. credits, remaster/version qualifiers, punctuation
 *  and case fold away — "Back In Black (Remastered 2003)" ≡ "back in black". */
export function normalizeTitle(title: string): string {
  return fold(title.replace(FEAT_PATTERN, "").replace(VERSION_PATTERN, ""));
}

/** Artist identity: feat. credits and extra artists fold away. */
export function normalizeArtist(artist: string): string {
  return fold(artist.split(/,\s*|\s*&\s*|\s*feat\.?\s*/i)[0] ?? "");
}

function titleScore(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  // Containment with similar length ("song title" vs "song title (live at x)")
  if ((na.includes(nb) || nb.includes(na)) && Math.abs(na.length - nb.length) <= Math.max(6, 0.3 * Math.max(na.length, nb.length))) return 0.8;
  return 0;
}

function artistScore(a: ExternalTrack, b: ExternalTrack): number {
  if (a.artists.length === 0 || b.artists.length === 0) return 0.5; // unknown ≠ mismatch (YouTube rows carry no artist)
  for (const artistA of a.artists) {
    const na = normalizeArtist(artistA);
    if (na.length === 0) continue;
    for (const artistB of b.artists) {
      const nb = normalizeArtist(artistB);
      if (nb.length === 0) continue;
      if (na === nb) return 1;
      if (na.includes(nb) || nb.includes(na)) return 0.7;
    }
  }
  return 0;
}

function durationScore(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0.5; // unknown ≠ mismatch
  const diff = Math.abs(a - b);
  if (diff <= 2000) return 1;
  if (diff >= 8000) return 0;
  return 1 - (diff - 2000) / 6000;
}

/**
 * Track identity across services, 0–1. ISRC equality is decisive (same
 * recording); conflicting ISRCs are a small penalty (re-releases differ),
 * never an automatic match. Otherwise title/artist/duration weigh in.
 */
export function matchScore(a: ExternalTrack, b: ExternalTrack): number {
  if (a.isrc !== null && b.isrc !== null) {
    if (a.isrc === b.isrc) return 1;
  }
  const score = titleScore(a.title, b.title) * 0.4 + artistScore(a, b) * 0.25 + durationScore(a.durationMs, b.durationMs) * 0.35;
  if (a.isrc !== null && b.isrc !== null && a.isrc !== b.isrc) return score * 0.9;
  return score;
}

export type MatchVerdict = "same" | "likely" | "none";

/** ≥0.92 same · ≥0.7 likely (worth showing as a candidate) · else none. */
export function matchVerdict(score: number): MatchVerdict {
  if (score >= 0.92) return "same";
  if (score >= 0.7) return "likely";
  return "none";
}

export type LocalAudioRecord = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number;
};

export type SnapshotAudioMatch = {
  track: ExternalTrack;
  status: "matched" | "ambiguous" | "review" | "missing";
  score: number;
  candidates: Array<{ id: string; title: string; artist: string; score: number }>;
};

/**
 * Compare catalog entries with already-stored Waveyard audio. Local tracks
 * currently have no provider ISRC, so this reports suggestions from title,
 * artist, and duration; it never creates a durable identity link.
 */
export function reconcileSnapshotAudio(
  snapshot: LibrarySnapshot,
  localAudio: readonly LocalAudioRecord[],
): {
  matches: SnapshotAudioMatch[];
  summary: { total: number; matched: number; ambiguous: number; review: number; missing: number };
} {
  const uniqueCatalogTracks = new Map<string, ExternalTrack>();
  for (const track of [...snapshot.playlists.flatMap((playlist) => playlist.tracks), ...snapshot.likedTracks]) {
    const key = `${track.service}:${track.externalId}`;
    if (!uniqueCatalogTracks.has(key)) uniqueCatalogTracks.set(key, track);
  }

  const localByTitle = new Map<string, LocalAudioRecord[]>();
  for (const local of localAudio) {
    const title = normalizeTitle(local.title);
    if (!title) continue;
    const sameTitle = localByTitle.get(title) ?? [];
    sameTitle.push(local);
    localByTitle.set(title, sameTitle);
  }

  const matches: SnapshotAudioMatch[] = [...uniqueCatalogTracks.values()].map((track) => {
    const possible = (localByTitle.get(normalizeTitle(track.title)) ?? [])
      .map((local) => {
        const candidate: ExternalTrack = {
          service: track.service,
          externalId: local.id,
          title: local.title,
          artists: local.artist.trim() ? [local.artist] : [],
          album: local.album,
          isrc: null,
          durationMs: Number.isFinite(local.durationSeconds) && local.durationSeconds > 0
            ? Math.round(local.durationSeconds * 1000)
            : null,
        };
        return {
          id: local.id,
          title: local.title,
          artist: local.artist,
          score: matchScore(track, candidate),
        };
      })
      .sort((left, right) => right.score - left.score);
    const strong = possible.filter((candidate) => matchVerdict(candidate.score) === "same");
    const topScore = possible[0]?.score ?? 0;
    const status = strong.length > 1
      ? "ambiguous"
      : strong.length === 1
        ? "matched"
        : matchVerdict(topScore) === "likely"
          ? "review"
          : "missing";
    return {
      track,
      status,
      score: topScore,
      candidates: possible.filter((candidate) => matchVerdict(candidate.score) !== "none").slice(0, 3),
    };
  });

  return {
    matches,
    summary: {
      total: matches.length,
      matched: matches.filter((item) => item.status === "matched").length,
      ambiguous: matches.filter((item) => item.status === "ambiguous").length,
      review: matches.filter((item) => item.status === "review").length,
      missing: matches.filter((item) => item.status === "missing").length,
    },
  };
}

export type TrackGroup = {
  /** Canonical display track (the richest member: most fields present). */
  representative: ExternalTrack;
  members: ExternalTrack[];
};

/**
 * Group the same recording across services/snapshots — the dedupe view and
 * transfer prep. Greedy: each track joins the first group it matches at the
 * "same" threshold (or shares service+externalId, which is identity).
 */
export function groupTracks(tracks: readonly ExternalTrack[], threshold = 0.92): TrackGroup[] {
  const groups: TrackGroup[] = [];
  for (const track of tracks) {
    const group = groups.find((candidate) =>
      candidate.members.some((member) =>
        (member.service === track.service && member.externalId === track.externalId) || matchScore(member, track) >= threshold,
      ),
    );
    if (group === undefined) {
      groups.push({ representative: track, members: [track] });
      continue;
    }
    group.members.push(track);
    // The representative is the member with the most known fields.
    const richness = (candidate: ExternalTrack) => (candidate.isrc !== null ? 2 : 0) + (candidate.durationMs !== null ? 1 : 0) + candidate.artists.length;
    if (richness(track) > richness(group.representative)) group.representative = track;
  }
  return groups;
}

// ------------------------------------------------------------------- diff

export type SnapshotDiff = {
  playlistsAdded: Array<{ externalId: string; name: string }>;
  playlistsRemoved: Array<{ externalId: string; name: string }>;
  playlistsRenamed: Array<{ externalId: string; from: string; to: string }>;
  /** Keyed by playlist externalId, or "liked" for the liked-songs pool. */
  tracksAdded: Array<{ playlist: string; track: ExternalTrack }>;
  tracksRemoved: Array<{ playlist: string; track: ExternalTrack }>;
  /** Playlists (or "liked") whose track ORDER changed (same members). */
  reordered: string[];
};

const LIKED_KEY = "liked";

/** Compare two snapshots of the SAME service (honest: cross-service diff
 *  is matching, not diffing — use groupTracks for that). */
export function diffSnapshots(previous: LibrarySnapshot, next: LibrarySnapshot): SnapshotDiff {
  if (previous.service !== next.service) {
    throw new Error("diffSnapshots compares the same service — cross-service identity is matching (groupTracks)");
  }
  const diff: SnapshotDiff = { playlistsAdded: [], playlistsRemoved: [], playlistsRenamed: [], tracksAdded: [], tracksRemoved: [], reordered: [] };
  const previousById = new Map(previous.playlists.map((playlist) => [playlist.externalId, playlist]));
  const nextById = new Map(next.playlists.map((playlist) => [playlist.externalId, playlist]));

  for (const playlist of next.playlists) {
    if (!previousById.has(playlist.externalId)) diff.playlistsAdded.push({ externalId: playlist.externalId, name: playlist.name });
  }
  for (const playlist of previous.playlists) {
    if (!nextById.has(playlist.externalId)) diff.playlistsRemoved.push({ externalId: playlist.externalId, name: playlist.name });
  }
  for (const playlist of next.playlists) {
    const before = previousById.get(playlist.externalId);
    if (before !== undefined && before.name !== playlist.name) {
      diff.playlistsRenamed.push({ externalId: playlist.externalId, from: before.name, to: playlist.name });
    }
  }

  const comparePool = (beforeTracks: ExternalTrack[], afterTracks: ExternalTrack[], key: string): void => {
    const beforeIds = new Set(beforeTracks.map((track) => track.externalId));
    const afterIds = new Set(afterTracks.map((track) => track.externalId));
    for (const track of afterTracks) if (!beforeIds.has(track.externalId)) diff.tracksAdded.push({ playlist: key, track });
    for (const track of beforeTracks) if (!afterIds.has(track.externalId)) diff.tracksRemoved.push({ playlist: key, track });
    // Reorder: same member set, different sequence.
    if (beforeIds.size === afterIds.size && beforeIds.size > 0) {
      const sameSet = [...afterIds].every((id) => beforeIds.has(id));
      if (sameSet) {
        const beforeOrder = beforeTracks.map((track) => track.externalId);
        const afterOrder = afterTracks.map((track) => track.externalId);
        if (beforeOrder.join("\u0000") !== afterOrder.join("\u0000")) diff.reordered.push(key);
      }
    }
  };

  for (const playlist of next.playlists) {
    const before = previousById.get(playlist.externalId);
    comparePool(before?.tracks ?? [], playlist.tracks, playlist.externalId);
  }
  comparePool(previous.likedTracks, next.likedTracks, LIKED_KEY);
  return diff;
}

/** True when nothing changed (the "already backed up" state). */
export function diffIsEmpty(diff: SnapshotDiff): boolean {
  return (
    diff.playlistsAdded.length === 0 &&
    diff.playlistsRemoved.length === 0 &&
    diff.playlistsRenamed.length === 0 &&
    diff.tracksAdded.length === 0 &&
    diff.tracksRemoved.length === 0 &&
    diff.reordered.length === 0
  );
}

// ----------------------------------------------------------------- backup

/** Stable JSON backup (deterministic field order — diffs of backups are
 *  meaningful). Round-trips through parseLibrarySnapshot. */
export function backupToJson(snapshot: LibrarySnapshot): string {
  const stable = (track: ExternalTrack) => ({
    service: track.service,
    externalId: track.externalId,
    title: track.title,
    artists: track.artists,
    album: track.album,
    isrc: track.isrc,
    durationMs: track.durationMs,
    ...(track.trackNumber !== undefined ? { trackNumber: track.trackNumber } : {}),
    ...(track.discNumber !== undefined ? { discNumber: track.discNumber } : {}),
    ...(track.year !== undefined ? { year: track.year } : {}),
    ...(track.genre !== undefined ? { genre: track.genre } : {}),
    ...(track.composer !== undefined ? { composer: track.composer } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
    ...(track.albumArtist !== undefined ? { albumArtist: track.albumArtist } : {}),
    ...(track.trackCount !== undefined ? { trackCount: track.trackCount } : {}),
    ...(track.discCount !== undefined ? { discCount: track.discCount } : {}),
    ...(track.rating !== undefined ? { rating: track.rating } : {}),
    ...(track.playCount !== undefined ? { playCount: track.playCount } : {}),
    ...(track.skipCount !== undefined ? { skipCount: track.skipCount } : {}),
    ...(track.dateAdded !== undefined ? { dateAdded: track.dateAdded } : {}),
    ...(track.lastPlayedAt !== undefined ? { lastPlayedAt: track.lastPlayedAt } : {}),
    ...(track.releaseDate !== undefined ? { releaseDate: track.releaseDate } : {}),
    ...(track.bitRate !== undefined ? { bitRate: track.bitRate } : {}),
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.kind !== undefined ? { kind: track.kind } : {}),
    ...(track.comments !== undefined ? { comments: track.comments } : {}),
  });
  return JSON.stringify({
    format: "waveyard-library-backup",
    version: 1,
    snapshot: {
      service: snapshot.service,
      takenAt: snapshot.takenAt,
      accountName: snapshot.accountName,
      playlists: snapshot.playlists.map((playlist) => ({
        externalId: playlist.externalId,
        name: playlist.name,
        description: playlist.description,
        tracks: playlist.tracks.map(stable),
      })),
      likedTracks: snapshot.likedTracks.map(stable),
    },
  });
}

/** Parse a backup file (hostile input total). */
export function parseBackup(text: string): LibrarySnapshot | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const wrapper = parsed as Record<string, unknown>;
    if (wrapper.format !== "waveyard-library-backup" || wrapper.version !== 1) return null;
    return parseLibrarySnapshot(wrapper.snapshot);
  } catch {
    return null;
  }
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV export (TuneMyMusic parity): one row per playlist track + liked. */
export function snapshotToCsv(snapshot: LibrarySnapshot): string {
  const header = "playlist,position,title,artists,album,isrc,duration_ms,service,external_id,track_number,disc_number,year,genre,composer,artwork_url,album_artist,track_count,disc_count,rating,play_count,skip_count,date_added,last_played_at,release_date,bit_rate,sample_rate,kind,comments";
  const rows: string[] = [];
  const trackRow = (playlist: string, position: number, track: ExternalTrack) =>
    [
      csvCell(playlist),
      String(position + 1),
      csvCell(track.title),
      csvCell(track.artists.join("; ")),
      csvCell(track.album ?? ""),
      track.isrc ?? "",
      track.durationMs !== null ? String(track.durationMs) : "",
      track.service,
      csvCell(track.externalId),
      track.trackNumber ?? "",
      track.discNumber ?? "",
      track.year ?? "",
      csvCell(track.genre ?? ""),
      csvCell(track.composer ?? ""),
      csvCell(track.artworkUrl ?? ""),
      csvCell(track.albumArtist ?? ""),
      track.trackCount ?? "",
      track.discCount ?? "",
      track.rating ?? "",
      track.playCount ?? "",
      track.skipCount ?? "",
      csvCell(track.dateAdded ?? ""),
      csvCell(track.lastPlayedAt ?? ""),
      csvCell(track.releaseDate ?? ""),
      track.bitRate ?? "",
      track.sampleRate ?? "",
      csvCell(track.kind ?? ""),
      csvCell(track.comments ?? ""),
    ].join(",");
  for (const playlist of snapshot.playlists) {
    playlist.tracks.forEach((track, index) => rows.push(trackRow(playlist.name, index, track)));
  }
  snapshot.likedTracks.forEach((track, index) => rows.push(trackRow("Liked songs", index, track)));
  return [header, ...rows].join("\n");
}

/**
 * Minimal RFC 4180 row splitter: quoted fields may contain commas,
 * newlines, and escaped ("") quotes. Returns null on unterminated quotes —
 * a malformed CSV is never silently reinterpreted.
 */
function splitCsvRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (inQuotes) return null;
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const normaliseHeader = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const CSV_COLUMN_ALIASES: Record<
  "playlist" | "title" | "artists" | "album" | "isrc" | "durationMs" | "externalId" |
  "trackNumber" | "discNumber" | "trackCount" | "discCount" | "year" | "genre" | "composer" | "artworkUrl" |
  "albumArtist" | "rating" | "playCount" | "skipCount" | "dateAdded" | "lastPlayedAt" | "releaseDate" |
  "bitRate" | "sampleRate" | "kind" | "comments",
  readonly string[]
> = {
  // Ours first (round-trip guarantee), then Exportify, then TuneMyMusic.
  playlist: ["playlist", "playlist name"],
  title: ["title", "track name", "track", "name", "song"],
  artists: ["artists", "artist name(s)", "artist name", "artist(s)", "artist"],
  album: ["album", "album name"],
  isrc: ["isrc"],
  durationMs: ["duration_ms", "duration (ms)", "duration", "length"],
  externalId: ["external_id", "track id", "id"],
  trackNumber: ["track_number", "track number", "track no"],
  discNumber: ["disc_number", "disc number", "disc no"],
  trackCount: ["track_count", "track count"],
  discCount: ["disc_count", "disc count"],
  year: ["year", "release year"],
  albumArtist: ["album_artist", "album artist"],
  genre: ["genre"],
  composer: ["composer", "composers"],
  artworkUrl: ["artwork_url", "artwork url", "cover art url"],
  rating: ["rating", "stars"],
  playCount: ["play_count", "play count", "plays"],
  skipCount: ["skip_count", "skip count", "skips"],
  dateAdded: ["date_added", "date added"],
  lastPlayedAt: ["last_played_at", "last played at", "last played"],
  releaseDate: ["release_date", "release date"],
  bitRate: ["bit_rate", "bit rate", "bitrate"],
  sampleRate: ["sample_rate", "sample rate"],
  kind: ["kind", "file kind"],
  comments: ["comments", "comment"],
};

function parseDurationMs(value: string): number | null {
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(value.trim());
  if (clock !== null) {
    // "4:15" is minutes:seconds; "1:04:15" is hours:minutes:seconds.
    const [, head, middle, tail] = clock;
    const totalSeconds = tail !== undefined
      ? Number(head) * 3600 + Number(middle) * 60 + Number(tail)
      : Number(head) * 60 + Number(middle);
    return Number.isFinite(totalSeconds) ? totalSeconds * 1000 : null;
  }
  if (!/^\d+$/.test(value.trim()) || value.trim() === "") return null;
  const ms = Number(value.trim());
  return ms > 0 ? ms : null;
}

/**
 * CSV import (vision §V6 — library vision completion): accepts our own
 * export format (perfect round-trip: snapshotToCsv → parseCsvSnapshot),
 * Exportify CSVs, and TuneMyMusic CSVs. Tracks land in one named playlist
 * (or grouped by the playlist column when present). Returns null when the
 * text is not a recognizable track CSV — the caller reports, never guesses.
 */
export function parseCsvSnapshot(text: string, service: StreamingService, playlistName = "CSV import"): LibrarySnapshot | null {
  const rows = splitCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows === null || rows.length < 2) return null;
  const header = rows[0].map(normaliseHeader);
  const columnIndex = (field: keyof typeof CSV_COLUMN_ALIASES): number =>
    header.findIndex((cell) => CSV_COLUMN_ALIASES[field].includes(cell));
  const titleColumn = columnIndex("title");
  const artistsColumn = columnIndex("artists");
  if (titleColumn === -1 || artistsColumn === -1) return null;
  const albumColumn = columnIndex("album");
  const isrcColumn = columnIndex("isrc");
  const durationColumn = columnIndex("durationMs");
  const idColumn = columnIndex("externalId");
  const playlistColumn = columnIndex("playlist");
  const trackNumberColumn = columnIndex("trackNumber");
  const discNumberColumn = columnIndex("discNumber");
  const yearColumn = columnIndex("year");
  const genreColumn = columnIndex("genre");
  const composerColumn = columnIndex("composer");
  const artworkUrlColumn = columnIndex("artworkUrl");
  const albumArtistColumn = columnIndex("albumArtist");
  const trackCountColumn = columnIndex("trackCount");
  const discCountColumn = columnIndex("discCount");
  const ratingColumn = columnIndex("rating");
  const playCountColumn = columnIndex("playCount");
  const skipCountColumn = columnIndex("skipCount");
  const dateAddedColumn = columnIndex("dateAdded");
  const lastPlayedAtColumn = columnIndex("lastPlayedAt");
  const releaseDateColumn = columnIndex("releaseDate");
  const bitRateColumn = columnIndex("bitRate");
  const sampleRateColumn = columnIndex("sampleRate");
  const kindColumn = columnIndex("kind");
  const commentsColumn = columnIndex("comments");

  // Rows in file order, each tagged with its playlist cell (when the export
  // carries one — ours does; Exportify is one file per playlist).
  const collected: { playlist: string; track: ExternalTrack }[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    const title = cells[titleColumn]?.trim() ?? "";
    if (title === "") continue;
    const artistCell = cells[artistsColumn] ?? "";
    const artistParts = artistCell.includes(";") ? artistCell.split(";") : artistCell.split(",");
    const artists = artistParts
      .map((part) => part.trim())
      .filter((part) => part !== "");
    collected.push({
      playlist: playlistColumn !== -1 ? (cells[playlistColumn] ?? "").trim() || playlistName : playlistName,
      track: {
        service,
        externalId: (idColumn !== -1 ? cells[idColumn]?.trim() : "") || `csv:${rowIndex}`,
        title: title.slice(0, MAX_TITLE_LENGTH),
        artists: artists.length > 0 ? artists : ["Unknown artist"],
        album: albumColumn !== -1 ? cleanString(cells[albumColumn], MAX_TITLE_LENGTH) : null,
        isrc: isrcColumn !== -1 ? parseIsrc(cells[isrcColumn]) : null,
        durationMs: durationColumn !== -1 ? parseDurationMs(cells[durationColumn] ?? "") : null,
        trackNumber: trackNumberColumn !== -1 ? boundedMetadataInteger(cells[trackNumberColumn], 1, 65535) : null,
        discNumber: discNumberColumn !== -1 ? boundedMetadataInteger(cells[discNumberColumn], 1, 65535) : null,
        trackCount: trackCountColumn !== -1 ? boundedMetadataInteger(cells[trackCountColumn], 1, 65535) : null,
        discCount: discCountColumn !== -1 ? boundedMetadataInteger(cells[discCountColumn], 1, 65535) : null,
        year: yearColumn !== -1 ? boundedMetadataInteger(cells[yearColumn], 1000, 9999) : null,
        genre: genreColumn !== -1 ? cleanString(cells[genreColumn], 200) : null,
        composer: composerColumn !== -1 ? cleanString(cells[composerColumn], 200) : null,
        artworkUrl: artworkUrlColumn !== -1 ? cleanArtworkUrl(cells[artworkUrlColumn]) : null,
        ...(albumArtistColumn !== -1 ? { albumArtist: cleanString(cells[albumArtistColumn], 200) } : {}),
        ...(ratingColumn !== -1 ? { rating: boundedMetadataInteger(cells[ratingColumn], 0, 100) } : {}),
        ...(playCountColumn !== -1 ? { playCount: boundedMetadataInteger(cells[playCountColumn], 0, 1_000_000_000) } : {}),
        ...(skipCountColumn !== -1 ? { skipCount: boundedMetadataInteger(cells[skipCountColumn], 0, 1_000_000_000) } : {}),
        ...(dateAddedColumn !== -1 ? { dateAdded: cleanIsoDate(cells[dateAddedColumn]) } : {}),
        ...(lastPlayedAtColumn !== -1 ? { lastPlayedAt: cleanIsoDate(cells[lastPlayedAtColumn]) } : {}),
        ...(releaseDateColumn !== -1 ? { releaseDate: cleanIsoDate(cells[releaseDateColumn]) } : {}),
        ...(bitRateColumn !== -1 ? { bitRate: boundedMetadataInteger(cells[bitRateColumn], 1, 1_000_000) } : {}),
        ...(sampleRateColumn !== -1 ? { sampleRate: boundedMetadataInteger(cells[sampleRateColumn], 1, 768_000) } : {}),
        ...(kindColumn !== -1 ? { kind: cleanString(cells[kindColumn], 200) } : {}),
        ...(commentsColumn !== -1 ? { comments: cleanString(cells[commentsColumn], 2000) } : {}),
      },
    });
  }
  if (collected.length === 0) return null;

  // Group in first-seen playlist order.
  const order: string[] = [];
  const buckets = new Map<string, ExternalTrack[]>();
  for (const entry of collected) {
    if (!buckets.has(entry.playlist)) { buckets.set(entry.playlist, []); order.push(entry.playlist); }
    buckets.get(entry.playlist)!.push(entry.track);
  }
  const playlists: ExternalPlaylist[] = order.map((name, index) => ({
    externalId: `csv-import-${index}`,
    name: name.slice(0, 200),
    description: null,
    tracks: (buckets.get(name) ?? []).slice(0, MAX_TRACKS_PER_PLAYLIST),
  }));

  const candidate: LibrarySnapshot = {
    service,
    takenAt: new Date().toISOString(),
    accountName: null,
    playlists: playlists.slice(0, MAX_PLAYLISTS),
    likedTracks: [],
  };
  // Reuse the validation the live/backup paths use — limits stay honest.
  return parseLibrarySnapshot(candidate);
}

type ApplePlistValue = string | number | boolean | null | ApplePlistValue[] | { [key: string]: ApplePlistValue };

function decodePlistXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const codePoint = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

/**
 * Reads Apple's XML property-list export without following its Location paths
 * or resolving external entities. Audio is never read by this metadata parser.
 */
function parseApplePlistXmlDocument(xml: string): Record<string, ApplePlistValue> | null {
  if (xml.length === 0 || xml.length > 64 * 1024 * 1024) return null;
  const source = xml
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml\b[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const tokens: string[] = [];
  const tokenPattern = /<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][^>]*>|[^<]+/g;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    tokens.push(token.startsWith("<![CDATA[") ? token.slice(9, -3) : token);
    if (tokens.length > 2_000_000) return null;
  }

  let cursor = 0;
  let nodes = 0;
  const skipWhitespace = () => {
    while (cursor < tokens.length && !tokens[cursor].startsWith("<") && tokens[cursor].trim() === "") cursor += 1;
  };
  const parseText = (tag: string): string | null => {
    const opener = tokens[cursor] ?? "";
    const selfClosing = opener.endsWith("/>");
    cursor += 1;
    if (selfClosing) return "";
    let value = "";
    while (cursor < tokens.length) {
      const token = tokens[cursor++];
      if (token === `</${tag}>`) return decodePlistXmlText(value);
      if (token.startsWith("<")) return null;
      value += token;
    }
    return null;
  };

  const parseValue = (depth: number): ApplePlistValue | undefined => {
    skipWhitespace();
    if (depth > 64 || ++nodes > 1_000_000) return undefined;
    const token = tokens[cursor] ?? "";
    const opening = token.match(/^<([A-Za-z][A-Za-z0-9]*)\b[^>]*>$/);
    if (opening === null) return undefined;
    const tag = opening[1].toLowerCase();
    if (tag === "true" || tag === "false") {
      cursor += 1;
      if (!token.endsWith("/>")) {
        if (tokens[cursor] !== `</${tag}>`) return undefined;
        cursor += 1;
      }
      return tag === "true";
    }
    if (tag === "null") {
      cursor += 1;
      return null;
    }
    if (tag === "dict") {
      cursor += 1;
      const result: Record<string, ApplePlistValue> = {};
      if (token.endsWith("/>")) return result;
      while (true) {
        skipWhitespace();
        if (tokens[cursor] === "</dict>") {
          cursor += 1;
          return result;
        }
        const keyToken = tokens[cursor] ?? "";
        if (!/^<key(?:\s[^>]*)?>$/.test(keyToken)) return undefined;
        const key = parseText("key");
        if (key === null) return undefined;
        const value = parseValue(depth + 1);
        if (value === undefined) return undefined;
        result[key] = value;
      }
    }
    if (tag === "array") {
      cursor += 1;
      const result: ApplePlistValue[] = [];
      if (token.endsWith("/>")) return result;
      while (true) {
        skipWhitespace();
        if (tokens[cursor] === "</array>") {
          cursor += 1;
          return result;
        }
        const value = parseValue(depth + 1);
        if (value === undefined) return undefined;
        result.push(value);
      }
    }
    if (["string", "key", "date", "data", "integer", "real"].includes(tag)) {
      const text = parseText(tag);
      if (text === null) return undefined;
      if (tag === "integer") {
        if (!/^-?\d+$/.test(text.trim())) return undefined;
        const value = Number(text.trim());
        return Number.isSafeInteger(value) ? value : undefined;
      }
      if (tag === "real") {
        const value = Number(text.trim());
        return Number.isFinite(value) ? value : undefined;
      }
      return text;
    }
    return undefined;
  };

  skipWhitespace();
  if (tokens[cursor]?.startsWith("<plist")) cursor += 1;
  const root = parseValue(0);
  if (root === undefined || root === null || Array.isArray(root) || typeof root !== "object") return null;
  skipWhitespace();
  if (tokens[cursor] === "</plist>") cursor += 1;
  skipWhitespace();
  return cursor === tokens.length ? root : null;
}

function plistRecord(value: ApplePlistValue | undefined): Record<string, ApplePlistValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, ApplePlistValue>
    : null;
}

function plistString(value: ApplePlistValue | undefined, maxLength = MAX_TITLE_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean === "" ? null : clean.slice(0, maxLength);
}

function plistId(value: ApplePlistValue | undefined, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 200) : fallback;
}

/**
 * Imports a standard iTunes/Apple Music Library.xml as a metadata snapshot.
 * The XML's local file paths are deliberately ignored; this never copies or
 * decodes any audio and never follows a path from the imported document.
 */
export function parseAppleMusicLibraryXml(xml: string, libraryName = "Apple Music Library"): LibrarySnapshot | null {
  const root = parseApplePlistXmlDocument(xml);
  const rawTracks = plistRecord(root?.Tracks);
  if (root === null || rawTracks === null) return null;

  const byReference = new Map<string, ExternalTrack>();
  const allTracks: ExternalTrack[] = [];
  const likedTracks: ExternalTrack[] = [];
  for (const [dictionaryId, rawTrack] of Object.entries(rawTracks)) {
    const record = plistRecord(rawTrack);
    const title = plistString(record?.Name);
    if (record === null || title === null) continue;
    const persistentId = plistString(record["Persistent ID"], 200);
    const externalId = persistentId ?? plistId(record["Track ID"], dictionaryId);
    const artist = plistString(record.Artist) ?? plistString(record["Album Artist"]);
    const isrcRaw = plistString(record.ISRC, 32);
    const durationValue = record["Total Time"];
    const durationMs = typeof durationValue === "number" && durationValue > 0 ? durationValue : null;
    const trackNumber = boundedMetadataInteger(record["Track Number"], 1, 65535);
    const discNumber = boundedMetadataInteger(record["Disc Number"], 1, 65535);
    const year = boundedMetadataInteger(record.Year, 1000, 9999);
    const track: ExternalTrack = {
      service: "apple",
      externalId,
      title,
      artists: [artist ?? "Unknown artist"],
      album: plistString(record.Album),
      isrc: isrcRaw === null ? null : parseIsrc(isrcRaw),
      durationMs,
      trackNumber,
      discNumber,
      year,
      albumArtist: plistString(record["Album Artist"], 200),
      genre: plistString(record.Genre, 200),
      composer: plistString(record.Composer, 200),
      // iTunes Library.xml does not provide a portable artwork URL or bytes.
      artworkUrl: null,
      trackCount: boundedMetadataInteger(record["Track Count"], 1, 65535),
      discCount: boundedMetadataInteger(record["Disc Count"], 1, 65535),
      rating: boundedMetadataInteger(record.Rating, 0, 100),
      playCount: boundedMetadataInteger(record["Play Count"], 0, 1_000_000_000),
      skipCount: boundedMetadataInteger(record["Skip Count"], 0, 1_000_000_000),
      dateAdded: cleanIsoDate(record["Date Added"]),
      lastPlayedAt: cleanIsoDate(record["Play Date UTC"]),
      releaseDate: cleanIsoDate(record["Release Date"]),
      bitRate: boundedMetadataInteger(record["Bit Rate"], 1, 1_000_000),
      sampleRate: boundedMetadataInteger(record["Sample Rate"], 1, 768_000),
      kind: plistString(record.Kind, 200),
      comments: plistString(record.Comments, 2000),
    };
    allTracks.push(track);
    byReference.set(dictionaryId, track);
    if (record["Track ID"] !== undefined) byReference.set(String(record["Track ID"]), track);
    if (persistentId !== null) byReference.set(persistentId, track);
    if (record.Loved === true) likedTracks.push(track);
  }
  if (allTracks.length === 0) return null;

  const playlists: ExternalPlaylist[] = [{
    externalId: "apple-library",
    name: plistString(root.Name, 200) ?? libraryName.slice(0, 200),
    description: null,
    tracks: allTracks.slice(0, MAX_TRACKS_PER_PLAYLIST),
  }];
  const rawPlaylists = Array.isArray(root.Playlists) ? root.Playlists : [];
  for (const [index, rawPlaylist] of rawPlaylists.entries()) {
    const record = plistRecord(rawPlaylist);
    if (record === null || record["Master"] === true || record["Is Master"] === true) continue;
    const name = plistString(record.Name, 200);
    if (name === null) continue;
    const items = Array.isArray(record["Playlist Items"]) ? record["Playlist Items"] : [];
    const playlistTracks: ExternalTrack[] = [];
    for (const item of items) {
      const itemRecord = plistRecord(item);
      const reference = itemRecord?.["Track ID"] ?? itemRecord?.["Track Persistent ID"];
      if (reference === undefined) continue;
      const track = byReference.get(String(reference));
      if (track !== undefined) playlistTracks.push(track);
    }
    playlists.push({
      externalId: plistId(record["Playlist Persistent ID"], `apple-playlist-${index}`),
      name,
      description: plistString(record.Description, 1000),
      tracks: playlistTracks.slice(0, MAX_TRACKS_PER_PLAYLIST),
    });
    if (playlists.length >= MAX_PLAYLISTS) break;
  }

  const candidate: LibrarySnapshot = {
    service: "apple",
    takenAt: new Date().toISOString(),
    accountName: plistString(root.Name, 200),
    playlists,
    likedTracks: likedTracks.slice(0, MAX_TRACKS_PER_PLAYLIST),
  };
  return parseLibrarySnapshot(candidate);
}

