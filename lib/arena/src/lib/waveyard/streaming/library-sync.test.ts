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
  matchedLocalAudioIdsForTracks,
  normalizeArtist,
  normalizeTitle,
  parseAppleMusicLibraryXml,
  parseBackup,
  parseCsvSnapshot,
  parseLibrarySnapshot,
  reconcileSnapshotAudio,
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

test("JSON backup preserves the full supported track metadata", () => {
  const original = snapshot({
    playlists: [{
      externalId: "p1",
      name: "Archive",
      description: null,
      tracks: [track({
        trackNumber: 7,
        discNumber: 2,
        year: 1980,
        albumArtist: "AC/DC",
        trackCount: 10,
        discCount: 2,
        genre: "Hard rock",
        composer: "Angus Young",
        artworkUrl: "https://images.example.test/cover.jpg",
        rating: 80,
        playCount: 120_000,
        skipCount: 3,
        dateAdded: "2024-02-03T04:05:06.000Z",
        lastPlayedAt: "2026-01-02T03:04:05.000Z",
        releaseDate: "1980-07-25T00:00:00.000Z",
        bitRate: 256,
        sampleRate: 44100,
        kind: "Apple Music AAC audio file",
        comments: "Imported from Apple Music",
      })],
    }],
    likedTracks: [],
  });
  assert.deepEqual(parseBackup(backupToJson(original)), original);
});

test("CSV export escapes honestly (TuneMyMusic parity)", () => {
  const csv = snapshotToCsv(snapshot({
    playlists: [{ externalId: "p1", name: 'My "best" list', description: null, tracks: [track({ title: "Song, with comma" })] }],
    likedTracks: [],
  }));
  const lines = csv.split("\n");
  assert.equal(lines[0], "playlist,position,title,artists,album,isrc,duration_ms,service,external_id,track_number,disc_number,year,genre,composer,artwork_url,album_artist,track_count,disc_count,rating,play_count,skip_count,date_added,last_played_at,release_date,bit_rate,sample_rate,kind,comments");
  assert.ok(lines[1].includes('"My ""best"" list"'), "playlist quotes doubled");
  assert.ok(lines[1].includes('"Song, with comma"'), "title comma quoted");
  assert.ok(lines[1].includes("AUSBM0000001"));
  // The plain snapshot's CSV has a row per track.
  const plain = snapshotToCsv(snapshot()).split("\n");
  assert.equal(plain.length, 1 + 3);
});

// ------------------------------------------------------- CSV import (V6.1)

test("CSV import round-trips our own export", () => {
  const original = snapshot({
    playlists: [{
      externalId: "p1",
      name: "Road trip",
      description: null,
      tracks: [
        track({
          trackNumber: 7,
          discNumber: 2,
          trackCount: 10,
          discCount: 2,
          year: 1980,
          albumArtist: "AC/DC",
          genre: "Hard rock",
          composer: "Angus Young",
          artworkUrl: "https://images.example.test/cover.jpg",
          rating: 80,
          playCount: 120_000,
          skipCount: 3,
          dateAdded: "2024-02-03T04:05:06.000Z",
          lastPlayedAt: "2026-01-02T03:04:05.000Z",
          releaseDate: "1980-07-25T00:00:00.000Z",
          bitRate: 256,
          sampleRate: 44100,
          kind: "Apple Music AAC audio file",
          comments: "Imported from Apple Music",
        }),
        track({ externalId: "t2", title: "Thunderstruck", artists: ["Artist, With Comma", "Guest Artist"] }),
      ],
    }],
  });
  const reparsed = parseCsvSnapshot(snapshotToCsv(original), "spotify", "reimport");
  assert.notEqual(reparsed, null);
  assert.equal(reparsed!.service, "spotify");
  // Every playlist and track from the export survives, grouped by name.
  const names = reparsed!.playlists.map((playlist) => playlist.name);
  assert.ok(names.includes("Road trip"));
  assert.ok(names.includes("Liked songs"));
  const roadTrip = reparsed!.playlists.find((playlist) => playlist.name === "Road trip")!;
  assert.equal(roadTrip.tracks.length, 2);
  assert.equal(roadTrip.tracks[0].title, "Back in Black");
  assert.equal(roadTrip.tracks[0].artists[0], "AC/DC");
  assert.equal(roadTrip.tracks[0].isrc, "AUSBM0000001");
  assert.equal(roadTrip.tracks[0].durationMs, 255_000);
  assert.equal(roadTrip.tracks[0].trackNumber, 7);
  assert.equal(roadTrip.tracks[0].discNumber, 2);
  assert.equal(roadTrip.tracks[0].trackCount, 10);
  assert.equal(roadTrip.tracks[0].discCount, 2);
  assert.equal(roadTrip.tracks[0].year, 1980);
  assert.equal(roadTrip.tracks[0].albumArtist, "AC/DC");
  assert.equal(roadTrip.tracks[0].genre, "Hard rock");
  assert.equal(roadTrip.tracks[0].composer, "Angus Young");
  assert.equal(roadTrip.tracks[0].artworkUrl, "https://images.example.test/cover.jpg");
  assert.equal(roadTrip.tracks[0].rating, 80);
  assert.equal(roadTrip.tracks[0].playCount, 120_000);
  assert.equal(roadTrip.tracks[0].skipCount, 3);
  assert.equal(roadTrip.tracks[0].dateAdded, "2024-02-03T04:05:06.000Z");
  assert.equal(roadTrip.tracks[0].lastPlayedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(roadTrip.tracks[0].releaseDate, "1980-07-25T00:00:00.000Z");
  assert.equal(roadTrip.tracks[0].bitRate, 256);
  assert.equal(roadTrip.tracks[0].sampleRate, 44100);
  assert.equal(roadTrip.tracks[0].kind, "Apple Music AAC audio file");
  assert.equal(roadTrip.tracks[0].comments, "Imported from Apple Music");
  assert.deepEqual(roadTrip.tracks[1].artists, ["Artist, With Comma", "Guest Artist"]);
});

test("CSV import accepts Exportify headers, quoting, and multi-artist cells", () => {
  const csv = [
    '"Track Name","Artist Name(s)","Album Name","Duration (ms)","ISRC"',
    '"Song, with comma","AC/DC, Bon Scott","Back in Black","255000","AUSBM0000001"',
    '"Thunderstruck","AC/DC","Back in Black","292000","invalid-isrc"',
  ].join("\r\n");
  const parsed = parseCsvSnapshot(csv, "apple", "Exported playlist");
  assert.notEqual(parsed, null);
  assert.equal(parsed!.playlists.length, 1);
  assert.equal(parsed!.playlists[0].name, "Exported playlist");
  const first = parsed!.playlists[0].tracks[0];
  assert.equal(first.title, "Song, with comma");
  assert.deepEqual(first.artists, ["AC/DC", "Bon Scott"]);
  assert.equal(first.durationMs, 255_000);
  assert.equal(first.isrc, "AUSBM0000001");
  assert.equal(parsed!.playlists[0].tracks[1].isrc, null, "invalid ISRCs drop to null, never guess");
});

test("CSV import accepts TuneMyMusic clock durations and BOM", () => {
  const csv = "\uFEFFTrack,Artist,Album,Length\nBack in Black,AC/DC,Back in Black,4:15";
  const parsed = parseCsvSnapshot(csv, "youtube");
  assert.notEqual(parsed, null);
  assert.equal(parsed!.playlists[0].tracks[0].durationMs, 255_000);
});

test("CSV import groups by the playlist column in first-seen order", () => {
  const csv = [
    "playlist,position,title,artists,album,isrc,duration_ms,service,external_id",
    "A,1,One,Artist,X,,1000,spotify,e1",
    "B,1,Two,Artist,X,,1000,spotify,e2",
    "A,2,Three,Artist,X,,1000,spotify,e3",
  ].join("\n");
  const parsed = parseCsvSnapshot(csv, "spotify");
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed!.playlists.map((playlist) => playlist.name), ["A", "B"]);
  assert.deepEqual(parsed!.playlists[0].tracks.map((t) => t.title), ["One", "Three"]);
  assert.deepEqual(parsed!.playlists[1].tracks.map((t) => t.title), ["Two"]);
});

test("CSV import rejects what is not a track list — never guesses", () => {
  assert.equal(parseCsvSnapshot("", "spotify"), null);
  assert.equal(parseCsvSnapshot("just one header row\n", "spotify"), null);
  assert.equal(parseCsvSnapshot("a,b\n1,2\n", "spotify"), null, "no title/artist columns");
  assert.equal(parseCsvSnapshot('title,artists\n"unterminated quote that never closes, artists\n', "spotify"), null);
  assert.equal(parseCsvSnapshot("title,artists\n,Artist\n", "spotify"), null, "empty-title rows only → no tracks");
});

test("Apple Library XML imports playlists and metadata without reading local audio paths", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Name</key><string>My Library &amp; More</string>
  <key>Tracks</key><dict>
    <key>101</key><dict>
      <key>Track ID</key><integer>101</integer>
      <key>Persistent ID</key><string>AA001</string>
      <key>Name</key><string>Song &amp; One</string>
      <key>Artist</key><string>Artist One</string>
      <key>Album Artist</key><string>Album Artist One</string>
      <key>Album</key><string>Album A</string>
      <key>Total Time</key><integer>210000</integer>
      <key>Track Number</key><integer>4</integer>
      <key>Track Count</key><integer>12</integer>
      <key>Disc Number</key><integer>2</integer>
      <key>Disc Count</key><integer>2</integer>
      <key>Year</key><integer>1980</integer>
      <key>Genre</key><string>Hard rock</string>
      <key>Composer</key><string>Angus Young</string>
      <key>Rating</key><integer>80</integer>
      <key>Play Count</key><integer>120000</integer>
      <key>Skip Count</key><integer>3</integer>
      <key>Date Added</key><date>2024-02-03T04:05:06Z</date>
      <key>Play Date UTC</key><date>2026-01-02T03:04:05Z</date>
      <key>Release Date</key><date>1980-07-25T00:00:00Z</date>
      <key>Bit Rate</key><integer>256</integer>
      <key>Sample Rate</key><integer>44100</integer>
      <key>Kind</key><string>Apple Music AAC audio file</string>
      <key>Comments</key><string>Imported, from &quot;Apple Music&quot;</string>
      <key>Loved</key><true/>
      <key>Location</key><string>file:///private/Apple%20Music/Protected.m4p</string>
    </dict>
    <key>102</key><dict>
      <key>Track ID</key><integer>102</integer>
      <key>Persistent ID</key><string>AA002</string>
      <key>Name</key><string>Song Two</string>
      <key>Artist</key><string>Artist Two</string>
      <key>Total Time</key><integer>180000</integer>
      <key>Location</key><string>file:///private/Apple%20Music/ProtectedTwo.m4p</string>
    </dict>
  </dict>
  <key>Playlists</key><array>
    <dict>
      <key>Master</key><true/>
      <key>Name</key><string>Library</string>
      <key>Playlist Items</key><array><dict><key>Track ID</key><integer>101</integer></dict></array>
    </dict>
    <dict>
      <key>Playlist Persistent ID</key><string>PLAY01</string>
      <key>Name</key><string>Women's Mix</string>
      <key>Description</key><string>Imported playlist</string>
      <key>Playlist Items</key><array>
        <dict><key>Track ID</key><integer>102</integer></dict>
        <dict><key>Track ID</key><integer>101</integer></dict>
      </array>
    </dict>
  </array>
</dict></plist>`;

  const parsed = parseAppleMusicLibraryXml(xml);
  assert.notEqual(parsed, null);
  assert.equal(parsed!.service, "apple");
  assert.equal(parsed!.accountName, "My Library & More");
  assert.equal(parsed!.playlists[0].name, "My Library & More");
  assert.deepEqual(parsed!.playlists[0].tracks.map((item) => item.title), ["Song & One", "Song Two"]);
  assert.deepEqual(parsed!.likedTracks.map((item) => item.externalId), ["AA001"]);
  const playlist = parsed!.playlists.find((item) => item.externalId === "PLAY01");
  assert.notEqual(playlist, undefined);
  assert.deepEqual(playlist!.tracks.map((item) => item.externalId), ["AA002", "AA001"]);
  assert.equal(playlist!.description, "Imported playlist");
  assert.equal(playlist!.tracks[0].durationMs, 180_000);
  const song = playlist!.tracks[1];
  assert.equal(song.trackNumber, 4);
  assert.equal(song.discNumber, 2);
  assert.equal(song.year, 1980);
  assert.equal(song.albumArtist, "Album Artist One");
  assert.equal(song.trackCount, 12);
  assert.equal(song.discCount, 2);
  assert.equal(song.genre, "Hard rock");
  assert.equal(song.composer, "Angus Young");
  assert.equal(song.rating, 80);
  assert.equal(song.playCount, 120_000);
  assert.equal(song.skipCount, 3);
  assert.equal(song.dateAdded, "2024-02-03T04:05:06.000Z");
  assert.equal(song.lastPlayedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(song.releaseDate, "1980-07-25T00:00:00.000Z");
  assert.equal(song.bitRate, 256);
  assert.equal(song.sampleRate, 44100);
  assert.equal(song.kind, "Apple Music AAC audio file");
  assert.equal(song.comments, 'Imported, from "Apple Music"');
  assert.equal(song.artworkUrl, null, "the XML exposes no portable artwork URL");
  assert.equal(JSON.stringify(parsed).includes("Protected.m4p"), false, "the XML's file paths are never copied into a backup");
  assert.deepEqual(parseBackup(backupToJson(parsed!)), parsed, "Apple XML metadata survives a JSON backup round-trip");
  const csvSnapshot = parseCsvSnapshot(snapshotToCsv(parsed!), "apple", "reimport");
  const csvSong = csvSnapshot?.playlists.flatMap((item) => item.tracks).find((item) => item.externalId === "AA001");
  assert.equal(csvSong?.playCount, 120_000, "Apple listening counts survive CSV export and import");
  assert.equal(csvSong?.rating, 80);
  assert.equal(csvSong?.albumArtist, "Album Artist One");
  assert.equal(csvSong?.comments, 'Imported, from "Apple Music"');
});

test("snapshot validation rejects unsafe artwork URLs and impossible metadata numbers", () => {
  const parsed = parseLibrarySnapshot(snapshot({
    likedTracks: [track({
      trackNumber: 0,
      discNumber: 70_000,
      year: 30_000,
      artworkUrl: "javascript:alert(1)",
      rating: 101,
      playCount: -1,
      skipCount: 1_000_000_001,
      sampleRate: 768_001,
      dateAdded: "not a date",
    })],
  }));
  assert.equal(parsed?.likedTracks[0].trackNumber, null);
  assert.equal(parsed?.likedTracks[0].discNumber, null);
  assert.equal(parsed?.likedTracks[0].year, null);
  assert.equal(parsed?.likedTracks[0].artworkUrl, null);
  assert.equal(parsed?.likedTracks[0].rating, null);
  assert.equal(parsed?.likedTracks[0].playCount, null);
  assert.equal(parsed?.likedTracks[0].skipCount, null);
  assert.equal(parsed?.likedTracks[0].sampleRate, null);
  assert.equal(parsed?.likedTracks[0].dateAdded, null);
});

test("snapshot audio reconciliation distinguishes strong, ambiguous, review, and missing matches", () => {
  const snapshotWithCoverage = snapshot({
    playlists: [
      {
        externalId: "p1",
        name: "Archive",
        description: null,
        tracks: [
          track({ externalId: "strong", title: "Back in Black" }),
          track({ externalId: "review", title: "Candidate Song", artists: ["Artist"], durationMs: 100_000 }),
          track({ externalId: "ambiguous", title: "Duplicate Song", artists: ["Artist"], durationMs: 180_000 }),
          track({ externalId: "missing", title: "No Local Copy", artists: ["Artist"] }),
        ],
      },
      {
        externalId: "p2",
        name: "Another playlist",
        description: null,
        tracks: [track({ externalId: "strong", title: "Back in Black" })],
      },
    ],
    likedTracks: [],
  });
  const result = reconcileSnapshotAudio(snapshotWithCoverage, [
    { id: "local-strong", title: "Back in Black", artist: "AC/DC", album: "Back in Black", durationSeconds: 255 },
    { id: "local-review", title: "Candidate Song", artist: "Artist", album: null, durationSeconds: 105 },
    { id: "local-ambiguous-a", title: "Duplicate Song", artist: "Artist", album: null, durationSeconds: 180 },
    { id: "local-ambiguous-b", title: "Duplicate Song", artist: "Artist", album: null, durationSeconds: 180 },
  ]);

  assert.deepEqual(result.summary, { total: 4, matched: 1, ambiguous: 1, review: 1, missing: 1 });
  assert.equal(result.matches.find((item) => item.track.externalId === "strong")?.status, "matched");
  assert.equal(result.matches.find((item) => item.track.externalId === "ambiguous")?.status, "ambiguous");
  assert.equal(result.matches.find((item) => item.track.externalId === "review")?.status, "review");
  assert.equal(result.matches.find((item) => item.track.externalId === "missing")?.status, "missing");
  assert.equal(result.matches[1].candidates[0].score, 0.825);
});

test("local-audio backup selection includes only unique matches in the visible catalog view", () => {
  const records = [
    { track: track({ service: "apple", externalId: "matched" }), status: "matched" as const,
      score: 0.98, candidates: [{ id: "local-a", title: "Back in Black", artist: "AC/DC", score: 0.98 }] },
    { track: track({ service: "apple", externalId: "duplicate" }), status: "matched" as const,
      score: 0.97, candidates: [{ id: "local-a", title: "Back in Black", artist: "AC/DC", score: 0.97 }] },
    { track: track({ service: "apple", externalId: "ambiguous" }), status: "ambiguous" as const,
      score: 0.96, candidates: [{ id: "local-b", title: "Back in Black", artist: "AC/DC", score: 0.96 }] },
    { track: track({ service: "apple", externalId: "review" }), status: "review" as const,
      score: 0.8, candidates: [{ id: "local-c", title: "Back in Black", artist: "AC/DC", score: 0.8 }] },
  ];

  assert.deepEqual(
    matchedLocalAudioIdsForTracks(records, new Set(["apple:matched", "apple:duplicate", "apple:ambiguous", "apple:review"])),
    ["local-a"],
    "ambiguous and review candidates are excluded, and duplicate local IDs are included once",
  );
  assert.deepEqual(
    matchedLocalAudioIdsForTracks(records, new Set(["apple:matched"])),
    ["local-a"],
    "tracks outside the current playlist/search view are not selected",
  );
});

test("Apple Library XML rejects malformed or non-library documents", () => {
  assert.equal(parseAppleMusicLibraryXml("not XML"), null);
  assert.equal(parseAppleMusicLibraryXml("<plist><dict><key>Tracks</key><string>bad</string></dict></plist>"), null);
  assert.equal(parseAppleMusicLibraryXml("<plist><dict><key>Tracks</key><dict></dict></dict></plist>"), null);
});
