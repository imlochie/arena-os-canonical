import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBlindListeningKit } from "./waveyard-blind-listening.mjs";
import { summarizeBlindListeningResponses } from "./waveyard-blind-listening-report.mjs";

test("creates a blind per-stem kit with randomized labels and a checksum-bearing answer key", async () => {
  const root = await mkdtemp(join(tmpdir(), "waveyard-blind-listening-test-"));
  try {
    const sourceFilesByMode = {};
    for (const mode of ["sequential", "parallel"]) {
      const directory = join(root, mode);
      await mkdir(directory);
      sourceFilesByMode[mode] = directory;
      for (const stem of ["vocals", "drums", "bass", "other"]) {
        await writeFile(join(directory, `${stem}-estimate.wav`), `${mode}:${stem}`);
      }
    }

    const result = await createBlindListeningKit({
      outputDirectory: join(root, "kit"),
      sourceFilesByMode,
      metadata: {
        input: {
          processedExcerptSha256: "a".repeat(64),
          models: [{ id: "test-model", sha256: "b".repeat(64) }],
        },
        settings: {
          sequential: { intraOpThreads: 2, interOpThreads: 1 },
          parallel: { intraOpThreads: 1, interOpThreads: 2 },
        },
      },
    });

    const html = await readFile(result.participantPage, "utf8");
    const key = JSON.parse(await readFile(result.answerKey, "utf8"));
    assert.doesNotMatch(html, /sequential|parallel|intraOpThreads|interOpThreads/i);
    assert.match(html, /differenceRating/);
    assert.match(html, /preference/);
    assert.match(html, /headphoneUse/);
    assert.equal(key.listenerSample.status, "not-collected");
    assert.ok(key.studyId);
    assert.equal(key.matchedOutputEquality.identicalStemCount, 0);
    assert.equal(key.matchedOutputEquality.allMatchedOutputsByteIdentical, false);
    assert.equal(key.trials.length, 4);
    assert.deepEqual(
      [...key.trials].map(({ stem }) => stem).sort(),
      ["bass", "drums", "other", "vocals"],
    );
    for (const trial of key.trials) {
      assert.deepEqual(
        Object.values(trial.versions).map(({ setting }) => setting).sort(),
        ["parallel", "sequential"],
      );
      for (const version of Object.values(trial.versions)) {
        assert.match(version.sha256, /^[a-f0-9]{64}$/);
      }
    }
    assert.equal(result.outputChecksums.length, 4);
    assert.equal(result.matchedOutputEquality.identicalStemCount, 0);

    const response = {
      schemaVersion: 1,
      studyId: key.studyId,
      headphoneUse: "yes",
      judgments: key.trials.map((trial) => ({
        trialId: trial.trialId,
        stem: trial.stem,
        differenceRating: 4,
        preference: "A",
      })),
    };
    const summary = summarizeBlindListeningResponses(key, [response]);
    assert.equal(summary.validResponseFiles, 1);
    assert.equal(summary.listenerCount, null);
    assert.equal(summary.headphoneUse.yes, 1);
    assert.deepEqual(
      Object.values(summary.perStem).map(({ validResponses }) => validResponses),
      [1, 1, 1, 1],
    );
    assert.equal(summary.perStem.vocals.meanDifferenceRating, 4);
    assert.equal(
      summary.perStem.vocals.preference[key.trials.find(({ stem }) => stem === "vocals").versions.A.setting],
      1,
    );
    assert.throws(
      () => summarizeBlindListeningResponses(key, [{ ...response, studyId: "another-study" }]),
      /does not belong/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
