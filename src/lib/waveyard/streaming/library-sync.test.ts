/**
 * Library-sync tests — the canonical model, the cross-service matcher, the
 * diff engine, and the backup serializers. Everything hostile becomes null
 * or clamps; every honest case (feat. credits, remasters, re-releases,
 * YouTube's missing artists) is verified arithmetically.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  backupToJson,
  diffIsEmpty,
  diffSnapshots,
  groupTracks,
  isStreamingService,
  matchScore,
  matchVerdict,
  normalizeArtist,
  normalizeTitle,
  parseBackup,
  parseLibrarySnapshot,
  snapshotStats,
  snapshotToCsv,
  type ExternalTrack,
  type LibrarySnapshot,
} from "./library-sync";

function track(overrides: Partial<ExternalTrack> = {}): ExternalTrack {
  return {
    service: "spotify",
    externalId: "t1",
    title: "Back in Black",
    artists: ["AC/DC"],
    album: "Back in Black",
    isrc: "AUSBM0000001",
    durationMs: 255_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    service: "spotify",
    takenAt: "2026-10-10T00:00:00.000Z",
    accountName: "me",
    playlists: [
      { externalId: "p1", name: "Road trip", description: null, tracks: [track(), track({ externalId: "t2", title: "Thunderstruck" })] },
    ],
    likedTracks: [track({ externalId: "t3", title: "Hells Bells" })],
    ...overrides,
  };
}

// ------------------------------------------------------------------ model

test("snapshot validation is total: hostile input → null, limits enforced", () => {
  assert.ok(parseLibrarySnapshot(null) === null);
  assert.ok(parseLibrarySnapshot("nope") === null);
  assert.ok(parseLibrarySnapshot([]) === null);
  assert.ok(parseLibrarySnapshot({ service: "napster", takenAt: "2026-01-01T00:00:00Z" }) === null, "unknown service rejected");
  assert.ok(parseLibrarySnapshot({ service: "spotify", takenAt: "not a date" }) === null);

  const good = parseLibrarySnapshot(snapshot());
  assert.ok(good !== null);
  assert.equal(good.playlists.length, 1);
  assert.equal(good.likedTracks.length, 1);

  // Limits: 2001 playlists → truncated to 2000, not stored whole.
  const hostile = snapshot({ playlists: Array.from({ length: 2001 }, (_, index) => ({ externalId: `p${index}`, name: "x", description: null, tracks: [] })) });
  assert.equal(parseLibrarySnapshot(hosty(hostile))?.playlists.length, 2000);
  // Bad rows are dropped, good rows survive.
  const mixed = snapshot({ likedTracks: [track(), { externalId: "", title: "no id" }, { externalId: "ok", title: 5 }] as unknown as ExternalTrack[] });
  const parsed = parseLibrarySnapshot(mixed);
  assert.ok(parsed !== null);
  assert.equal(parsed.likedTracks.length, 1);
  // ISRC shape is enforced; hyphenated input is normalized to the bare form.
  const badIsrc = parseLibrarySnapshot(snapshot({ likedTracks: [track({ isrc: "not-an-isrc" })] }));
  assert.equal(badIsrc?.likedTracks[0].isrc, null);
  const hyphenated = parseLibrarySnapshot(snapshot({ likedTracks: [track({ isrc: "AU-SBM-00-00001" })] }));
  assert.equal(hyphenated?.likedTracks[0].isrc, "AUSBM0000001");
});

/** JSON round-trip helper that strips undefined (JSON semantics). */
function hosty(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("stats count honestly", () => {
  const stats = snapshotStats(snapshot());
  assert.deepEqual(stats, { playlists: 1, tracks: 3, tracksWithIsrc: 3 });
  assert.deepEqual(snapshotStats(snapshot({ playlists: [], likedTracks: [] })), { playlists: 0, tracks: 0, tracksWithIsrc: 0 });
  assert.ok(isStreamingService("spotify") && isStreamingService("apple") && isStreamingService("youtube"));
  assert.ok(!isStreamingService("tidal"));
});

// --------------------------------------------------------------- matching

test("title normalization folds feat. credits, remasters, and punctuation", () => {
  assert.equal(normalizeTitle("Back In Black (Remastered 2003)"), normalizeTitle("back in black"));
  assert.equal(normalizeTitle("Song (feat. Someone Else)"), normalizeTitle("song"));
  assert.equal(normalizeTitle("Song - Radio Edit"), normalizeTitle("SONG"));
  assert.equal(normalizeTitle("Don't Stop Me Now"), normalizeTitle("dont stop me now"));
  assert.notEqual(normalizeTitle("Back in Black"), normalizeTitle("Back in Blackness"));
  assert.equal(normalizeArtist("AC/DC feat. Someone"), normalizeArtist("ac dc"));
  assert.equal(normalizeArtist("Taylor Swift, Bon Iver"), normalizeArtist("taylor swift"));
});

test("matchScore: ISRC is decisive, conflicting ISRCs only penalize", () => {
  const a = track();
  const sameRecording = track({ service: "apple", externalId: "x", artists: ["Totally Wrong Name"], title: "Completely Different Title" });
  assert.equal(matchScore(a, sameRecording), 1, "ISRC equality = same recording, full stop");

  const reissue = track({ service: "apple", externalId: "x", isrc: "AUSBM00999999", durationMs: 255_100 });
  assert.ok(matchScore(a, reissue) >= 0.85, `re-release with same title+duration still scores as a likely match (${matchScore(a, reissue)})`);
  assert.ok(matchScore(a, reissue) < 1, "conflicting ISRCs never score a perfect 1");
});

test("matchScore: title, artist, and duration weigh in honestly", () => {
  const base = track({ isrc: null });
  const same = track({ isrc: null, service: "apple", externalId: "x" });
  assert.ok(matchScore(base, same) >= 0.92, `identical metadata → same (${matchScore(base, same)})`);

  const otherArtist = track({ isrc: null, service: "apple", externalId: "x", artists: ["Someone Else"] });
  assert.ok(matchScore(base, otherArtist) < 0.92, "different artist never reaches 'same' (title+duration alone maxes at the likely tier — covers stay candidates)");

  const longer = track({ isrc: null, service: "apple", externalId: "x", durationMs: 255_000 + 2500 });
  assert.ok(matchScore(base, longer) >= 0.92, `2.5 s off is still the same track (${matchScore(base, longer)})`);
  const wayLonger = track({ isrc: null, service: "apple", externalId: "x", durationMs: 300_000 });
  assert.ok(matchScore(base, wayLonger) < 0.7, "45 s off is not the same track");

  // YouTube rows carry no artist: neutral 0.5, not a penalty.
  const youtubeRow = track({ isrc: null, service: "youtube", externalId: "v1", artists: [], durationMs: null, album: null });
  assert.ok(matchScore(base, youtubeRow) > 0.45, "missing artist is neutral");

  assert.equal(matchVerdict(1), "same");
  assert.equal(matchVerdict(0.75), "likely");
  assert.equal(matchVerdict(0.5), "none");
});

test("groupTracks dedupes the same recording across services", () => {
  const spotifyTrack = track({ externalId: "s1" });
  const appleTrack = track({ service: "apple", externalId: "a1" });
  const youtubeTrack = track({ service: "youtube", externalId: "y1", artists: [], isrc: null, durationMs: null });
  const other = track({ externalId: "s2", title: "Completely Different Song", isrc: "AUSBM0000002" });
  // Strict grouping: the apple row merges via ISRC; the youtube row is too
  // metadata-poor (no artist, no duration, no isrc) to auto-merge at "same".
  const strict = groupTracks([spotifyTrack, appleTrack, youtubeTrack, other]);
  assert.equal(strict.length, 3, "spotify+apple merged, youtube honestly separate, other distinct");
  const mine = strict.find((group) => group.representative.title === "Back in Black" && group.members.length > 1);
  assert.ok(mine !== undefined);
  assert.equal(mine.members.length, 2, "spotify + apple present");
  assert.equal(mine.representative.service, "spotify", "the richest member represents");
  // At the "likely" threshold the youtube row joins as an unverified member.
  const loose = groupTracks([spotifyTrack, appleTrack, youtubeTrack, other], 0.7);
  const looseMine = loose.find((group) => group.representative.title === "Back in Black");
  assert.ok(looseMine !== undefined);
  assert.equal(looseMine.members.length, 3, "the likely tier is for user confirmation, not auto-merge");
});

// ------------------------------------------------------------------- diff

test("diffSnapshots reports every honest change", () => {
  const reorderPlaylist = (first: string, second: string) => ({
    externalId: "p3",
    name: "Stable",
    description: null,
    tracks: [track({ externalId: first, title: first }), track({ externalId: second, title: second })],
  });
  const before = snapshot({ playlists: [...snapshot().playlists, reorderPlaylist("a", "b")] });
  const after = snapshot({
    playlists: [
      // p1 renamed, t2 left, t3 joined
      { externalId: "p1", name: "Road trip 2026", description: null, tracks: [track({ externalId: "t3", title: "Hells Bells" }), track()] },
      { externalId: "p2", name: "New", description: null, tracks: [] },
      // p3: same members, swapped order — a pure reorder
      reorderPlaylist("b", "a"),
    ],
    likedTracks: [track({ externalId: "t3", title: "Hells Bells" }), track({ externalId: "t2", title: "Thunderstruck" })],
  });
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.playlistsAdded, [{ externalId: "p2", name: "New" }]);
  assert.deepEqual(diff.playlistsRemoved, []);
  assert.deepEqual(diff.playlistsRenamed, [{ externalId: "p1", from: "Road trip", to: "Road trip 2026" }]);
  assert.deepEqual(diff.tracksAdded.map((entry) => entry.track.externalId), ["t3", "t2"], "t3 joined p1, t2 joined liked");
  assert.deepEqual(diff.tracksRemoved.map((entry) => entry.track.externalId), ["t2"], "t2 left p1");
  assert.deepEqual(diff.reordered, ["p3"], "membership-stable order change = reorder; membership change is not");
  assert.ok(!diffIsEmpty(diff));

  assert.ok(diffIsEmpty(diffSnapshots(before, JSON.parse(JSON.stringify(before)) as LibrarySnapshot)), "identical libraries diff empty");
  // Cross-service diffing is refused by contract (same service only).
  assert.throws(() => diffSnapshots(before, snapshot({ service: "apple" })), /same service/);
});

// ----------------------------------------------------------------- backup

test("backups round-trip and reject hostile files", () => {
  const original = snapshot();
  const json = backupToJson(original);
  const restored = parseBackup(json);
  assert.ok(restored !== null);
  assert.deepEqual(restored, original, "round-trip is lossless");
  assert.deepEqual(JSON.parse(json).format, "waveyard-library-backup");

  assert.ok(parseBackup("{not json") === null);
  assert.ok(parseBackup(JSON.stringify({ format: "someone-elses", version: 1 })) === null);
  assert.ok(parseBackup(JSON.stringify({ format: "waveyard-library-backup", version: 99, snapshot: original })) === null, "unknown version refused");
  // Stable field order → byte-identical backups of identical libraries.
  assert.equal(backupToJson(original), backupToJson(snapshot()));
});

test("CSV export escapes honestly (TuneMyMusic parity)", () => {
  const csv = snapshotToCsv(snapshot({
    playlists: [{ externalId: "p1", name: 'My "best" list', description: null, tracks: [track({ title: "Song, with comma" })] }],
    likedTracks: [],
  }));
  const lines = csv.split("\n");
  assert.equal(lines[0], "playlist,position,title,artists,album,isrc,duration_ms,service,external_id");
  assert.ok(lines[1].includes('"My ""best"" list"'), "playlist quotes doubled");
  assert.ok(lines[1].includes('"Song, with comma"'), "title comma quoted");
  assert.ok(lines[1].includes("AUSBM0000001"));
  // The plain snapshot's CSV has a row per track.
  const plain = snapshotToCsv(snapshot()).split("\n");
  assert.equal(plain.length, 1 + 3);
});
