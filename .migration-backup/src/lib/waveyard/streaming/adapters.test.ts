/**
 * Adapter tests — documented payload shapes (Spotify Web API, MusicKit JS,
 * YouTube Data API) map to the canonical model; PKCE against the RFC 7636
 * test vector. No network: payloads are fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  assembleSpotifySnapshot,
  cleanYouTubeArtist,
  createPkceVerifier,
  mapApplePlaylist,
  mapAppleSong,
  mapSpotifyPlaylist,
  mapSpotifyTrack,
  mapYouTubePlaylistItem,
  pageCount,
  pkceChallengeFromVerifier,
  SPOTIFY_LIBRARY_SCOPES,
  spotifyAuthorizeUrl,
} from "./adapters";

// ----------------------------------------------------------------- spotify

const spotifyTrack = {
  id: "track-1",
  name: "Back in Black",
  artists: [{ name: "AC/DC" }],
  album: { name: "Back in Black" },
  duration_ms: 255_300,
  external_ids: { isrc: "AUSBM00000001" },
  // The field Spotify removed for third-party apps — must be IGNORED.
  preview_url: "https://example.com/preview.mp3",
};

test("spotify payloads map to the canonical model, preview_url ignored", () => {
  const mapped = mapSpotifyTrack(spotifyTrack);
  assert.ok(mapped !== null);
  assert.equal(mapped.service, "spotify");
  assert.equal(mapped.title, "Back in Black");
  assert.deepEqual(mapped.artists, ["AC/DC"]);
  assert.equal(mapped.album, "Back in Black");
  assert.equal(mapped.isrc, "AUSBM00000001");
  assert.equal(mapped.durationMs, 255_300);
  assert.equal("previewUrl" in (mapped as Record<string, unknown>), false, "preview_url is deliberately not mapped");

  const playlist = mapSpotifyPlaylist({ id: "pl-1", name: "Road trip", description: "" });
  assert.ok(playlist !== null);
  assert.equal(playlist.description, null, "blank description → null");

  // Hostile shapes.
  assert.equal(mapSpotifyTrack({ id: "x" }), null, "name required");
  assert.equal(mapSpotifyTrack(null), null);
  assert.equal(mapSpotifyTrack({ id: 5, name: "x" }), null);
  assert.equal(mapSpotifyPlaylist({ name: "no id" }), null);
});

test("pageCount covers the paging math", () => {
  assert.equal(pageCount(0, 50), 0);
  assert.equal(pageCount(1, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(250, 50), 5);
  assert.equal(pageCount(-1, 50), 0);
  assert.equal(pageCount(100, 0), 0);
});

test("the spotify snapshot assembles from pages", () => {
  const snapshot = assembleSpotifySnapshot({
    accountName: "me",
    playlists: [
      { playlist: { id: "pl-1", name: "Road trip" }, trackPages: [[spotifyTrack], [{ id: "track-2", name: "Thunderstruck", artists: [], album: null }]] },
      { playlist: { id: "broken" }, trackPages: [] },
    ],
    likedPages: [[spotifyTrack]],
  });
  assert.equal(snapshot.service, "spotify");
  assert.equal(snapshot.playlists.length, 1, "broken playlist dropped");
  assert.equal(snapshot.playlists[0].tracks.length, 2);
  assert.equal(snapshot.likedTracks.length, 1);
  assert.ok(Number.isNaN(Date.parse(snapshot.takenAt)) === false);
  assert.equal(SPOTIFY_LIBRARY_SCOPES.includes("playlist-read-private"), true);
  assert.equal(SPOTIFY_LIBRARY_SCOPES.includes("playlist-modify"), false, "backup is read-only — no write scopes");
});

// ------------------------------------------------------------------- apple

test("apple MusicKit resources map honestly (no isrc in library songs)", () => {
  const song = mapAppleSong({
    id: "song-1",
    attributes: { name: "Back in Black", artistName: "AC/DC", albumName: "Back in Black", durationInMillis: 255_300, playCount: 12 },
  });
  assert.ok(song !== null);
  assert.equal(song.service, "apple");
  assert.deepEqual(song.artists, ["AC/DC"]);
  assert.equal(song.durationMs, 255_300);
  assert.equal(song.isrc, null, "library songs carry no isrc — the adapter says so instead of guessing");

  assert.equal(mapAppleSong({ attributes: { name: "no id" } }), null);
  const noArtist = mapAppleSong({ id: "song-2", attributes: { name: "Untitled" } });
  assert.ok(noArtist !== null);
  assert.deepEqual(noArtist.artists, []);

  const playlist = mapApplePlaylist({ id: "pl-1", attributes: { name: "Road trip", description: "long drive" } });
  assert.ok(playlist !== null);
  assert.equal(playlist.description, "long drive");
});

// ----------------------------------------------------------------- youtube

test("youtube playlist items map with the channel-as-artist rule", () => {
  assert.deepEqual(cleanYouTubeArtist("AC/DC - Topic"), ["AC/DC"]);
  assert.deepEqual(cleanYouTubeArtist("QueenOfficialVEVO"), ["QueenOfficial"]);
  assert.deepEqual(cleanYouTubeArtist(null), []);
  assert.deepEqual(cleanYouTubeArtist("  "), []);

  const item = mapYouTubePlaylistItem({
    snippet: { title: "Back in Black", videoOwnerChannelTitle: "AC/DC - Topic" },
    contentDetails: { videoId: "vid-1" },
  });
  assert.ok(item !== null);
  assert.equal(item.service, "youtube");
  assert.equal(item.externalId, "vid-1");
  assert.deepEqual(item.artists, ["AC/DC"]);
  assert.equal(item.durationMs, null, "playlistItems carry no duration — honest null");

  assert.equal(mapYouTubePlaylistItem({ snippet: { title: "x" } }), null, "videoId required");
  const viaResourceId = mapYouTubePlaylistItem({ snippet: { title: "x", resourceId: { videoId: "vid-2" } } });
  assert.ok(viaResourceId !== null);
  assert.equal(viaResourceId.externalId, "vid-2");
});

// -------------------------------------------------------------------- PKCE

test("PKCE follows RFC 7636 (the spec's own test vector)", async () => {
  // RFC 7636 Appendix B: this verifier must produce this challenge.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const digest = async (algorithm: "SHA-256", data: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest(algorithm, data as BufferSource));
  const challenge = await pkceChallengeFromVerifier(verifier, digest);
  assert.equal(challenge, expected, "the RFC vector is the contract");

  // The verifier generator produces valid base64url, 43+ chars.
  const generated = createPkceVerifier(webcrypto.getRandomValues(new Uint8Array(64)));
  assert.ok(generated.length >= 43);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(generated), "base64url alphabet only");
  assert.throws(() => createPkceVerifier(new Uint8Array(8)), "too little entropy is refused");

  // Distinct randoms → distinct verifiers.
  assert.notEqual(createPkceVerifier(webcrypto.getRandomValues(new Uint8Array(64))), createPkceVerifier(webcrypto.getRandomValues(new Uint8Array(64))));
});

test("the authorize URL carries PKCE and the read-only scopes", async () => {
  const digest = async (algorithm: "SHA-256", data: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest(algorithm, data as BufferSource));
  const challenge = await pkceChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", digest);
  const url = new URL(spotifyAuthorizeUrl({ clientId: "my-app", redirectUri: "http://localhost:3000/waveyard/studio", state: "xyz", codeChallenge: challenge }));
  assert.equal(url.hostname, "accounts.spotify.com");
  assert.equal(url.searchParams.get("client_id"), "my-app");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(url.searchParams.get("scope"), SPOTIFY_LIBRARY_SCOPES);
  assert.equal(url.searchParams.get("state"), "xyz");
});
