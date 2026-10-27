/**
 * Streaming-library adapters — DOCUMENTED payload shapes → the canonical
 * LibrarySnapshot model. Pure: no fetch, no OAuth round-trips here; the
 * component supplies the network. What each adapter honestly provides:
 *
 *   Spotify (Web API, PKCE — no client secret on our server):
 *     playlists + liked songs WITH isrc and duration (rich matching).
 *     preview_url is deliberately NOT mapped: Spotify removed third-party
 *     access to previews (Nov 2024) and its terms prohibit syncing their
 *     content with video — Waveyard never pretends otherwise.
 *   Apple Music (MusicKit JS, in-browser): library playlists + songs with
 *     duration; library songs carry NO isrc (Apple only exposes it on
 *     catalog resources) — matching leans on title/artist/duration.
 *   YouTube (Data API v3): playlist items of the user's YouTube account
 *     (many music tracks live there); NO official YouTube Music API
 *     exists. Items carry no duration/isrc and the channel name stands in
 *     for the artist ("Artist - Topic" → "Artist").
 */

import type { ExternalPlaylist, ExternalTrack, LibrarySnapshot, StreamingService } from "./library-sync";

// ----------------------------------------------------------------- spotify

/** The scopes a library backup genuinely needs (read-only). */
export const SPOTIFY_LIBRARY_SCOPES = "playlist-read-private playlist-read-collaborative user-library-read user-read-private" as const;

/** A Spotify track object (Web API shape) → canonical. */
export function mapSpotifyTrack(payload: unknown): ExternalTrack | null {
  if (typeof payload !== "object" || payload === null) return null;
  const input = payload as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.name !== "string") return null;
  const artists = Array.isArray(input.artists)
    ? input.artists.map((artist) => (typeof artist === "object" && artist !== null && "name" in artist && typeof (artist as Record<string, unknown>).name === "string" ? (artist as Record<string, unknown>).name as string : null)).filter((name): name is string => name !== null)
    : [];
  const album = typeof input.album === "object" && input.album !== null && typeof (input.album as Record<string, unknown>).name === "string" ? (input.album as Record<string, unknown>).name as string : null;
  const externalIds = typeof input.external_ids === "object" && input.external_ids !== null ? (input.external_ids as Record<string, unknown>) : {};
  const isrc = typeof externalIds.isrc === "string" ? externalIds.isrc : null;
  const durationMs = typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) ? input.duration_ms : null;
  return { service: "spotify", externalId: input.id, title: input.name, artists, album, isrc, durationMs };
}

/** A Spotify playlist object → canonical (tracks filled by the assembler). */
export function mapSpotifyPlaylist(payload: unknown): { externalId: string; name: string; description: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const input = payload as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.name !== "string") return null;
  return { externalId: input.id, name: input.name, description: typeof input.description === "string" && input.description.trim().length > 0 ? input.description.trim() : null };
}

/** Paging math: how many limit-sized requests cover `total` items. */
export function pageCount(total: number, limit: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(limit) || total <= 0 || limit <= 0) return 0;
  return Math.ceil(total / limit);
}

/** Assemble a Spotify snapshot from fetched pages (pure). */
export function assembleSpotifySnapshot(input: {
  accountName: string | null;
  playlists: Array<{ playlist: unknown; trackPages: unknown[][] }>;
  likedPages: unknown[][];
}): LibrarySnapshot {
  const playlists: ExternalPlaylist[] = [];
  for (const entry of input.playlists) {
    const mapped = mapSpotifyPlaylist(entry.playlist);
    if (mapped === null) continue;
    const tracks = entry.trackPages.flat().map(mapSpotifyTrack).filter((track): track is ExternalTrack => track !== null);
    playlists.push({ ...mapped, tracks });
  }
  return {
    service: "spotify",
    takenAt: new Date().toISOString(),
    accountName: input.accountName,
    playlists,
    likedTracks: input.likedPages.flat().map(mapSpotifyTrack).filter((track): track is ExternalTrack => track !== null),
  };
}

// ------------------------------------------------------------------- apple

/** A MusicKit library song resource → canonical. */
export function mapAppleSong(payload: unknown): ExternalTrack | null {
  if (typeof payload !== "object" || payload === null) return null;
  const resource = payload as Record<string, unknown>;
  if (typeof resource.id !== "string") return null;
  const attributes = typeof resource.attributes === "object" && resource.attributes !== null ? (resource.attributes as Record<string, unknown>) : {};
  if (typeof attributes.name !== "string") return null;
  return {
    service: "apple",
    externalId: resource.id,
    title: attributes.name,
    artists: typeof attributes.artistName === "string" && attributes.artistName.trim().length > 0 ? [attributes.artistName] : [],
    album: typeof attributes.albumName === "string" ? attributes.albumName : null,
    // Library songs expose no isrc (catalog-only field) — honest null.
    isrc: null,
    durationMs: typeof attributes.durationInMillis === "number" && Number.isFinite(attributes.durationInMillis) ? attributes.durationInMillis : null,
  };
}

/** A MusicKit library playlist resource → canonical. */
export function mapApplePlaylist(payload: unknown): { externalId: string; name: string; description: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const resource = payload as Record<string, unknown>;
  if (typeof resource.id !== "string") return null;
  const attributes = typeof resource.attributes === "object" && resource.attributes !== null ? (resource.attributes as Record<string, unknown>) : {};
  if (typeof attributes.name !== "string") return null;
  return { externalId: resource.id, name: attributes.name, description: typeof attributes.description === "string" && attributes.description.trim().length > 0 ? attributes.description.trim() : null };
}

/** Assemble an Apple snapshot (pure). */
export function assembleAppleSnapshot(input: {
  accountName: string | null;
  playlists: Array<{ playlist: unknown; trackResources: unknown[] }>;
  likedSongs: unknown[];
}): LibrarySnapshot {
  const playlists: ExternalPlaylist[] = [];
  for (const entry of input.playlists) {
    const mapped = mapApplePlaylist(entry.playlist);
    if (mapped === null) continue;
    const tracks = entry.trackResources.map(mapAppleSong).filter((track): track is ExternalTrack => track !== null);
    playlists.push({ ...mapped, tracks });
  }
  return {
    service: "apple",
    takenAt: new Date().toISOString(),
    accountName: input.accountName,
    playlists,
    likedTracks: input.likedSongs.map(mapAppleSong).filter((track): track is ExternalTrack => track !== null),
  };
}

// ----------------------------------------------------------------- youtube

/** "Artist - Topic" / "ArtistVEVO" → the artist name, honestly derived. */
export function cleanYouTubeArtist(channelTitle: string | null): string[] {
  if (channelTitle === null || channelTitle.trim().length === 0) return [];
  const cleaned = channelTitle.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
  return cleaned.length > 0 ? [cleaned] : [];
}

/** A Data API playlistItem → canonical (no duration/isrc at this level —
 *  a videos.list call would be needed; the UI states this). */
export function mapYouTubePlaylistItem(payload: unknown): ExternalTrack | null {
  if (typeof payload !== "object" || payload === null) return null;
  const input = payload as Record<string, unknown>;
  const snippet = typeof input.snippet === "object" && input.snippet !== null ? (input.snippet as Record<string, unknown>) : {};
  const contentDetails = typeof input.contentDetails === "object" && input.contentDetails !== null ? (input.contentDetails as Record<string, unknown>) : {};
  const videoId = typeof contentDetails.videoId === "string" ? contentDetails.videoId : typeof snippet.resourceId === "object" && snippet.resourceId !== null && typeof (snippet.resourceId as Record<string, unknown>).videoId === "string" ? (snippet.resourceId as Record<string, unknown>).videoId as string : null;
  if (videoId === null || typeof snippet.title !== "string") return null;
  return {
    service: "youtube",
    externalId: videoId,
    title: snippet.title,
    artists: cleanYouTubeArtist(typeof snippet.videoOwnerChannelTitle === "string" ? snippet.videoOwnerChannelTitle : null),
    album: null,
    isrc: null,
    durationMs: null,
  };
}

/** Assemble a YouTube snapshot (pure). */
export function assembleYouTubeSnapshot(input: {
  accountName: string | null;
  playlists: Array<{ playlist: unknown; itemResources: unknown[] }>;
  likedItems: unknown[];
}): LibrarySnapshot {
  const playlists: ExternalPlaylist[] = [];
  for (const entry of input.playlists) {
    if (typeof entry.playlist !== "object" || entry.playlist === null) continue;
    const playlistInput = entry.playlist as Record<string, unknown>;
    const snippet = typeof playlistInput.snippet === "object" && playlistInput.snippet !== null ? (playlistInput.snippet as Record<string, unknown>) : {};
    if (typeof playlistInput.id !== "string" || typeof snippet.title !== "string") continue;
    playlists.push({
      externalId: playlistInput.id,
      name: snippet.title,
      description: typeof snippet.description === "string" && snippet.description.trim().length > 0 ? snippet.description.trim() : null,
      tracks: entry.itemResources.map(mapYouTubePlaylistItem).filter((track): track is ExternalTrack => track !== null),
    });
  }
  return {
    service: "youtube",
    takenAt: new Date().toISOString(),
    accountName: input.accountName,
    playlists,
    likedTracks: input.likedItems.map(mapYouTubePlaylistItem).filter((track): track is ExternalTrack => track !== null),
  };
}

// -------------------------------------------------------------------- PKCE

/** base64url, no padding — works in node (Buffer) and the browser (btoa)
 *  without importing either at module scope. */
function base64UrlEncode(bytes: Uint8Array): string | null {
  const globalBuffer = (globalThis as unknown as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (typeof globalBuffer?.from === "function") {
    const encoded = globalBuffer.from(bytes).toString("base64");
    return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return null;
}

/** A PKCE code verifier: 64 random bytes, base64url (43+ chars, RFC 7636). */
export function createPkceVerifier(randomBytes: Uint8Array): string {
  if (randomBytes.length < 32) throw new Error("PKCE verifier needs at least 32 random bytes");
  const encoded = base64UrlEncode(randomBytes);
  if (encoded === null || encoded.length < 43) throw new Error("PKCE encoding failed");
  return encoded;
}

/**
 * The S256 code challenge: base64url(SHA-256(verifier)). The digest is
 * injected (the component passes crypto.subtle.digest; tests pass the
 * node webcrypto digest) so this module stays side-effect free.
 */
export async function pkceChallengeFromVerifier(
  verifier: string,
  digest: (algorithm: "SHA-256", data: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const hashed = await digest("SHA-256", bytes);
  const encoded = base64UrlEncode(hashed);
  if (encoded === null || encoded.length < 43) throw new Error("PKCE challenge encoding failed");
  return encoded;
}

/** The Spotify PKCE authorize URL (the browser opens this). */
export function spotifyAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes?: string }): string {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("scope", input.scopes ?? SPOTIFY_LIBRARY_SCOPES);
  return url.toString();
}

/** The service a canonical track came from (helper for dispatch UIs). */
export function serviceOf(track: ExternalTrack): StreamingService {
  return track.service;
}
