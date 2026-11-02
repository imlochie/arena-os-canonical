import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STEMS = ["vocals", "drums", "bass", "other"];

export function summarizeBlindListeningResponses(answerKey, responses) {
  if (!Array.isArray(answerKey.trials) || !answerKey.studyId) {
    throw new Error("The answer key is missing its study ID or trial mapping.");
  }
  const trialsById = new Map(answerKey.trials.map((trial) => [trial.trialId, trial]));
  if (trialsById.size !== STEMS.length) throw new Error("The answer key must define four unique stem trials.");

  const summaries = Object.fromEntries(
    STEMS.map((stem) => [
      stem,
      {
        validResponses: 0,
        differenceRatingCounts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
        meanDifferenceRating: null,
        preference: { sequential: 0, parallel: 0, noPreference: 0 },
      },
    ]),
  );
  const headphoneUse = { yes: 0, no: 0, unsure: 0 };
  const validSubmissions = [];

  for (const [responseIndex, response] of responses.entries()) {
    if (response.schemaVersion !== 1 || response.studyId !== answerKey.studyId) {
      throw new Error(`Response ${responseIndex + 1} does not belong to this listening study.`);
    }
    if (!Array.isArray(response.judgments) || response.judgments.length !== STEMS.length) {
      throw new Error(`Response ${responseIndex + 1} must contain exactly four stem judgments.`);
    }
    if (!Object.hasOwn(headphoneUse, response.headphoneUse)) {
      throw new Error(`Response ${responseIndex + 1} has an invalid headphone-use answer.`);
    }

    const seenTrials = new Set();
    for (const judgment of response.judgments) {
      const trial = trialsById.get(judgment.trialId);
      if (!trial || trial.stem !== judgment.stem || seenTrials.has(judgment.trialId)) {
        throw new Error(`Response ${responseIndex + 1} contains an unknown, mismatched, or duplicate trial.`);
      }
      if (!Number.isInteger(judgment.differenceRating) || judgment.differenceRating < 1 || judgment.differenceRating > 5) {
        throw new Error(`Response ${responseIndex + 1} contains an invalid difference rating.`);
      }
      const summary = summaries[trial.stem];
      summary.validResponses += 1;
      summary.differenceRatingCounts[String(judgment.differenceRating)] += 1;

      if (judgment.preference === "No preference") {
        summary.preference.noPreference += 1;
      } else if (judgment.preference === "A" || judgment.preference === "B") {
        const setting = trial.versions[judgment.preference]?.setting;
        if (setting !== "sequential" && setting !== "parallel") {
          throw new Error(`Answer key has an invalid setting for ${judgment.preference}.`);
        }
        summary.preference[setting] += 1;
      } else {
        throw new Error(`Response ${responseIndex + 1} contains an invalid preference.`);
      }
      seenTrials.add(judgment.trialId);
    }
    if (seenTrials.size !== STEMS.length) {
      throw new Error(`Response ${responseIndex + 1} does not cover all four stems.`);
    }
    headphoneUse[response.headphoneUse] += 1;
    validSubmissions.push({
      listenerCodeProvided: typeof response.listenerCode === "string" && response.listenerCode.trim().length > 0,
    });
  }

  for (const summary of Object.values(summaries)) {
    if (summary.validResponses > 0) {
      const total = Object.entries(summary.differenceRatingCounts).reduce(
        (sum, [rating, count]) => sum + Number(rating) * count,
        0,
      );
      summary.meanDifferenceRating = Number((total / summary.validResponses).toFixed(2));
    }
  }

  return {
    schemaVersion: 1,
    studyId: answerKey.studyId,
    input: answerKey.input,
    matchedOutputEquality: answerKey.matchedOutputEquality ?? null,
    validResponseFiles: validSubmissions.length,
    listenerCount: null,
    listenerCountLimit:
      "Response files are counted, not verified unique people; optional listener codes may help an organizer detect repeat submissions.",
    headphoneUse,
    perStem: summaries,
    interpretation:
      validSubmissions.length === 0
        ? "No listener responses were supplied; no perceptual conclusion can be drawn."
        : "Ratings describe only the returned response files for these four stems and this excerpt. They do not establish universal perceptual quality or equivalence.",
    sampleLimit:
      "This study covers one short excerpt and one recorded machine/runtime. A small or self-selected panel cannot establish universal quality or equivalence.",
  };
}

async function main() {
  const [answerKeyPath, outputPath, ...responsePaths] = process.argv.slice(2);
  if (!answerKeyPath || !outputPath) {
    throw new Error(
      "Usage: node scripts/waveyard-blind-listening-report.mjs <answer-key.json> <output.json> [response.json ...]",
    );
  }
  const answerKey = JSON.parse(await readFile(resolve(answerKeyPath), "utf8"));
  const responses = await Promise.all(
    responsePaths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))),
  );
  const summary = summarizeBlindListeningResponses(answerKey, responses);
  await writeFile(resolve(outputPath), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Listening response summary saved to ${resolve(outputPath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
