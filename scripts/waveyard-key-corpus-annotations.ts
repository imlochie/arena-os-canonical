/**
 * Scrapes the GiantSteps key annotations into a local corpus manifest.
 *
 * ## Why the annotations and not the audio
 *
 * The GiantSteps key dataset (Knees et al., ISMIR 2015) is **604 professionally
 * annotated electronic-dance tracks** with a key label per track. It is the
 * closest thing to a defensible key benchmark that is reachable from this
 * environment, and the annotations themselves are on GitHub.
 *
 * The audio is **not** in the repository and never will be. The recordings are
 * 2-minute Beatport previews of commercial releases; the dataset ships only the
 * annotations plus a download script so each user obtains the audio under
 * Beatport's terms. Redistributing or committing that audio would breach both
 * Beatport's terms and the dataset's own licence, so this repo stores
 * annotations only and treats the audio as a local, user-supplied input.
 *
 * ## What this buys, and what it does not
 *
 * It buys a real evaluation set: six hundred human-annotated keys across EDM,
 * which is exactly the material the CC0 corpus could not cover. It does **not**
 * by itself let the analyser be scored, because scoring needs the audio. Until
 * the annotated audio is present, every consumer of this manifest must report
 * "unscored" rather than an accuracy figure. Reporting accuracy against
 * annotations with no audio would be fabrication.
 *
 * ## Usage
 *
 *   tsx scripts/waveyard-key-corpus-annotations.ts
 *
 * Output: ./generated-artifacts/waveyard-key-annotations/{manifest.json,annotations/}
 * Then, with audio supplied locally, run the evaluation harness.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, "..", "generated-artifacts", "waveyard-key-annotations");

/** Pinned so a later run scores exactly the same annotation set. */
const ANNOTATION_SOURCE = {
  repository: "GiantSteps/giantsteps-key-dataset",
  commit: "6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b",
  reference:
    "Knees, Faraldo, Herrera, Vogl, Böck, Hörschläger, Le Goff — "
    + '"Two data sets for tempo estimation and key detection in electronic dance music '
    + 'annotated from user corrections", ISMIR 2015',
  license:
    "Annotations: research use under the dataset's own terms, credited to the paper above. "
    + "Audio: NOT included — Beatport previews of commercial releases, obtained by the user "
    + "under Beatport's terms. Never commit this audio.",
};

type KeyAnnotation = { trackId: string; key: string; keys: string[] };

/** Standard 24-class vocabulary the analyser reports in. */
const KEY_CLASSES = (() => {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return names.flatMap((name) => [`${name} major`, `${name} minor`]);
})();

/**
 * Reads a JSON document from the annotation repository.
 *
 * `gh api` is used rather than `fetch` because it carries the caller's own
 * credentials and certificate store, so it works in environments where Node's
 * bundled trust store does not (this repo's sandbox included). It also keeps the
 * request rate-limited against a real account instead of the anonymous pool.
 */
function ghApiJson(path: string): unknown {
  const stdout = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(stdout);
}

function fetchAnnotationList(): string[] {
  const body = ghApiJson(
    `repos/${ANNOTATION_SOURCE.repository}/git/trees/HEAD?recursive=1`,
  ) as { tree?: Array<{ path: string }> };
  return (body.tree ?? [])
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("annotations/key/") && path.endsWith(".key"));
}

function fetchAnnotationText(path: string): string {
  const body = ghApiJson(`repos/${ANNOTATION_SOURCE.repository}/contents/${path}`) as { content?: string };
  if (!body.content) throw new Error(`${path}: no content`);
  return Buffer.from(body.content, "base64").toString("utf8");
}

/** Enharmonic spelling → the sharp-based class names the analyser reports. */
const ENHARMONIC: Record<string, string> = {
  C: "C", "C#": "C#", Db: "C#",
  D: "D", "D#": "D#", Eb: "D#",
  E: "E", Fb: "E",
  F: "F", "F#": "F#", Gb: "F#",
  G: "G", "G#": "G#", Ab: "G#",
  A: "A", "A#": "A#", Bb: "A#",
  B: "B", Cb: "B",
};

/**
 * Reads a key label, maping enharmonic spellings onto the sharp-based names the
 * analyser reports. The dataset writes `Db minor` and `Bb minor`; an earlier
 * version of this parser dropped those 78 tracks outright by treating the flat
 * sign as part of an unrelated substitution.
 *
 * A file may contain more than one label when the recording modulates. Those are
 * counted separately rather than flattened, because a key change is a case the
 * analyser has to be measured on, not averaged away.
 */
type ParsedKey = { keys: string[]; modulates: boolean };

function normaliseKey(raw: string): ParsedKey | null {
  const lines = raw.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
  if (lines.length === 0) return null;
  const keys: string[] = [];
  for (const line of lines) {
    const match = /^([A-G][#b]?)\s*(major|minor|maj|min|m)$/i.exec(line);
    if (!match) continue;
    const root = ENHARMONIC[match[1]!] ?? null;
    if (root === null) continue;
    const suffix = match[2]!.toLowerCase();
    const mode = suffix.startsWith("maj") ? "major" : "minor";
    const candidate = `${root} ${mode}`;
    if (KEY_CLASSES.includes(candidate) && !keys.includes(candidate)) keys.push(candidate);
  }
  if (keys.length === 0) return null;
  return { keys, modulates: keys.length > 1 };
}

async function main(): Promise<void> {
  mkdirSync(join(outputDirectory, "annotations"), { recursive: true });
  const paths = fetchAnnotationList();
  if (paths.length === 0) throw new Error("no key annotations found at the pinned source");

  const annotations: KeyAnnotation[] = [];
  const unparsed: string[] = [];
  let modulating = 0;
  for (const path of paths) {
    const trackId = path.split("/").pop()!.replace(/\.key$/, "");
    const parsed = normaliseKey(fetchAnnotationText(path));
    if (parsed === null) {
      unparsed.push(trackId);
      continue;
    }
    if (parsed.modulates) modulating += 1;
    annotations.push({ trackId, key: parsed.keys[0]!, keys: parsed.keys });
    writeFileSync(join(outputDirectory, "annotations", `${trackId}.key`), `${parsed.keys.join("\n")}\n`);
  }

  const distribution = new Map<string, number>();
  for (const annotation of annotations) {
    distribution.set(annotation.key, (distribution.get(annotation.key) ?? 0) + 1);
  }
  const missingClasses = KEY_CLASSES.filter((name) => !distribution.has(name));

  const manifest = {
    schemaVersion: 1,
    purpose:
      "Human-annotated key benchmark for Waveyard key detection. Annotations only; scoring "
      + "requires the user to supply the matching audio locally.",
    audioIncluded: false,
    audioNote: ANNOTATION_SOURCE.license,
    source: ANNOTATION_SOURCE,
    groundTruth: {
      status: "independent",
      method: "professional annotation correcting automated estimates, published at ISMIR 2015",
      caveat:
        "Annotated on 2-minute previews by the dataset authors. It is far stronger evidence than "
        + "readme metadata, but it is one annotator pipeline on one genre (EDM), not universal truth.",
    },
    totals: {
      annotated: annotations.length,
      unparsed: unparsed.length,
      distinctKeys: distribution.size,
      missingKeyClasses: missingClasses,
      modulatingTracks: modulating,
    },
    modulatingTracks: modulating,
    distribution: [...distribution.entries()].sort((left, right) => right[1] - left[1]),
    annotations,
  };
  writeFileSync(join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({
    outputDirectory,
    annotated: annotations.length,
    unparsed: unparsed.length,
    distinctKeys: distribution.size,
    missingKeyClasses: missingClasses.length,
    modulatingTracks: modulating,
    audioIncluded: false,
    scoring: "blocked until matching audio is supplied locally",
  }, null, 2));
}

await main();
