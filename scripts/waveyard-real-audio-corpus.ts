/**
 * Fetches the real-audio acceptance corpus for Waveyard mashup generation.
 *
 * The audio is deliberately **not** committed (36 MB of mp3). This script
 * reproduces the exact corpus from a pinned upstream commit and verifies every
 * file against the sha256 in `fixtures/waveyard-real-audio/corpus.json`, so a
 * measurement taken today can be re-run later and is known to be the same input.
 *
 * Licence: CC0 1.0 (public domain dedication) — see the manifest. Nothing here
 * touches a commercial recording.
 *
 * Usage:
 *   tsx scripts/waveyard-real-audio-corpus.ts            # fetch + verify
 *   tsx scripts/waveyard-real-audio-corpus.ts --verify   # verify only
 *
 * Output: ./generated-artifacts/waveyard-real-audio/ (git-ignored).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CorpusTrack = { file: string; bytes: number; sha256: string };

type CorpusManifest = {
  schemaVersion: number;
  purpose: string;
  license: { id: string; url: string; note: string };
  source: { repository: string; commit: string; tracksPath: string; retrieved: string };
  groundTruth: { status: string; detail: string; fields: string[] };
  tracks: CorpusTrack[];
};

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "fixtures", "waveyard-real-audio", "corpus.json");
const outputDirectory = resolve(here, "..", "generated-artifacts", "waveyard-real-audio");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes("--verify");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest;
  mkdirSync(outputDirectory, { recursive: true });

  const rawBase = `https://raw.githubusercontent.com/${manifest.source.repository.replace("https://github.com/", "")}`;
  const pinnedBase = `${rawBase}/${manifest.source.commit}/${manifest.source.tracksPath}`;

  let fetched = 0;
  let alreadyPresent = 0;
  const failures: string[] = [];

  for (const track of manifest.tracks) {
    const destination = join(outputDirectory, track.file);
    let bytes: Buffer | null = null;

    if (existsSync(destination)) {
      bytes = readFileSync(destination);
      if (sha256(bytes) !== track.sha256) {
        // Stale or partial file: refetch rather than trust it.
        bytes = null;
      } else {
        alreadyPresent += 1;
      }
    }

    if (bytes === null) {
      if (verifyOnly) {
        failures.push(`${track.file}: missing or checksum mismatch (verify-only mode)`);
        continue;
      }
      const response = await fetch(`${pinnedBase}/${track.file}`);
      if (!response.ok) {
        failures.push(`${track.file}: HTTP ${response.status}`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
      const digest = sha256(bytes);
      if (digest !== track.sha256) {
        failures.push(`${track.file}: sha256 ${digest.slice(0, 12)}… != expected ${track.sha256.slice(0, 12)}…`);
        continue;
      }
      writeFileSync(destination, bytes);
      fetched += 1;
    }

    if (bytes.length !== track.bytes) {
      failures.push(`${track.file}: ${bytes.length} bytes != expected ${track.bytes}`);
    }
  }

  const report = {
    corpus: manifest.source.repository,
    commit: manifest.source.commit,
    license: manifest.license.id,
    groundTruth: manifest.groundTruth.status,
    outputDirectory,
    fetched,
    alreadyPresent,
    verified: manifest.tracks.length - failures.length,
    total: manifest.tracks.length,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

/** Decodes one corpus track to mono PCM at the analyser's rate, using ffmpeg. */
export function decodeCorpusTrack(file: string, ffmpegPath?: string): Float32Array {
  const ffmpeg = ffmpegPath ?? process.env.ARENA_FFMPEG_PATH;
  if (!ffmpeg) throw new Error("ARENA_FFMPEG_PATH must point at an ffmpeg binary to decode the corpus.");
  const stdout = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", join(outputDirectory, file), "-ac", "1", "-ar", "22050", "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

export const REAL_AUDIO_CORPUS_DIRECTORY = outputDirectory;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
