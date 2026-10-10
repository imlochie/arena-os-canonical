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

function parseTrack(raw: unknown, service: StreamingService): ExternalTrack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const externalId = typeof input.externalId === "string" && input.externalId.length > 0 && input.externalId.length <= 256 ? input.externalId : null;
  const title = cleanString(input.title, MAX_TITLE_LENGTH);
  if (externalId === null || title === null) return null;
  const artists = Array.isArray(input.artists)
    ? input.artists.filter((artist): artist is string => typeof artist === "string" && artist.trim().length > 0).slice(0, 12).map((artist) => artist.trim().slice(0, 200))
    : [];
  return {
    service,
    externalId,
    title,
    artists,
    album: cleanString(input.album, MAX_TITLE_LENGTH),
    isrc: parseIsrc(input.isrc),
    durationMs: typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : null,
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
  const header = "playlist,position,title,artists,album,isrc,duration_ms,service,external_id";
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
    ].join(",");
  for (const playlist of snapshot.playlists) {
    playlist.tracks.forEach((track, index) => rows.push(trackRow(playlist.name, index, track)));
  }
  snapshot.likedTracks.forEach((track, index) => rows.push(trackRow("Liked songs", index, track)));
  return [header, ...rows].join("\n");
}
