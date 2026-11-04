import assert from "node:assert/strict";
import { randomInt, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCALE_ITEMS = [
  ["harmonicFit", "Harmonic fit", "1 = clashes strongly; 5 = fits naturally"],
  ["rhythmFit", "Rhythm and phrase fit", "1 = fights the groove; 5 = locks in naturally"],
  ["stemArtifacts", "Stem artifacts", "1 = distracting artifacts; 5 = clean or barely noticeable"],
  ["overallFit", "Overall mix quality", "1 = would not keep it; 5 = would use it"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runFfmpeg(inputPath, outputPath) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-i", inputPath, "-map", "0:a:0",
    "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", outputPath,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`FFmpeg could not convert ${inputPath}: ${result.error?.message ?? result.stderr}`);
  }
}

function readPcmWavMetrics(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  let channels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === "fmt ") {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (name === "data") {
      data = buffer.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  assert.equal(channels, 2);
  assert.equal(sampleRate, 44_100);
  assert.equal(bitsPerSample, 16);
  assert.ok(data && data.length > 0);
  let sumSquares = 0;
  let peak = 0;
  let nearFullScaleSamples = 0;
  const count = Math.floor(data.length / 2);
  for (let index = 0; index < count; index += 1) {
    const value = data.readInt16LE(index * 2);
    const absolute = Math.abs(value);
    const normalized = value / 32768;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, absolute / 32768);
    if (absolute >= 32760) nearFullScaleSamples += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  return {
    sampleRate,
    channels,
    bitDepth: bitsPerSample,
    durationSeconds: Number((count / channels / sampleRate).toFixed(3)),
    rmsDbfs: Number((20 * Math.log10(Math.max(rms, 1e-8))).toFixed(2)),
    samplePeakDbfs: Number((20 * Math.log10(Math.max(peak, 1e-8))).toFixed(2)),
    nearFullScaleSampleCount: nearFullScaleSamples,
    samples: count,
  };
}

export function trimPcmWavToSamples(buffer, targetSampleCount) {
  assert.ok(Number.isInteger(targetSampleCount) && targetSampleCount > 0);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (name === "data") {
      const targetDataBytes = targetSampleCount * 2;
      assert.ok(targetDataBytes <= size, "cannot extend a WAV while trimming");
      if (targetDataBytes === size) return buffer;
      const trimmed = Buffer.concat([
        buffer.subarray(0, dataStart),
        buffer.subarray(dataStart, dataStart + targetDataBytes),
      ]);
      trimmed.writeUInt32LE(targetDataBytes, offset + 4);
      trimmed.writeUInt32LE(trimmed.length - 8, 4);
      return trimmed;
    }
    offset = dataStart + size + (size % 2);
  }
  throw new Error("PCM WAV is missing its data chunk");
}

function shuffle(items) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function htmlForTrials(trials) {
  const rows = trials.map((trial, index) => `
    <article class="trial" data-trial="${trial.id}">
      <h2>Mix ${index + 1}</h2>
      <div class="samples">
        ${trial.order.map(label => `
          <section class="sample">
            <h3>Sample ${label}</h3>
            <audio controls preload="none" src="../audio/${trial[label].file}"></audio>
            <fieldset>
              <legend>Rate this sample</legend>
              ${SCALE_ITEMS.map(([key, title, note]) => `
                <label>${title}<small>${note}</small>
                  <select data-rating="${label}.${key}" required>
                    <option value="">Choose 1–5</option>
                    <option value="1">1</option><option value="2">2</option>
                    <option value="3">3</option><option value="4">4</option><option value="5">5</option>
                  </select>
                </label>`).join("")}
            </fieldset>
          </section>`).join("")}
      </div>
      <label class="preference">Which full mix do you prefer?
        <select data-preference required>
          <option value="">Choose one</option>
          <option value="A">Sample A</option><option value="B">Sample B</option>
          <option value="tie">No preference</option>
        </select>
      </label>
      <label class="comments">Optional notes<textarea data-comments maxlength="1000"></textarea></label>
    </article>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waveyard mix listening study</title>
<style>
  :root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#101214;color:#f2f3f5}
  body{max-width:1050px;margin:0 auto;padding:24px}
  h1{font-size:1.7rem} .intro,.trial{background:#1c2024;border:1px solid #30363d;border-radius:16px;padding:20px;margin:16px 0}
  .samples{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .sample{background:#15181b;border-radius:12px;padding:14px}
  audio{width:100%;margin:8px 0 14px} label{display:block;margin:12px 0;font-weight:600}
  small{display:block;color:#aeb6bf;font-weight:400} select,textarea,button{font:inherit;color:inherit;background:#242a30;border:1px solid #48515a;border-radius:8px;padding:9px}
  select{display:block;width:100%;margin-top:6px} textarea{width:100%;min-height:70px;box-sizing:border-box}
  button{cursor:pointer;background:#d9e5ff;color:#111827;font-weight:700;padding:12px 18px}
  .status{min-height:1.5em;color:#b7e1c3} @media(max-width:700px){body{padding:14px}.samples{grid-template-columns:1fr}}
</style></head><body>
<h1>Waveyard mix listening study</h1>
<section class="intro"><p>Listen to both samples for each mix, then rate each sample separately. The order of mixes and A/B labels is randomized. Higher ratings are better, including for stem artifacts.</p>
<p>This page stores nothing on a server. Your answers stay in this browser until you download them. The separate <strong>LICENSES.md</strong> file credits the source music; it is not shown alongside the blinded trial labels.</p></section>
${rows}
<button id="download" type="button">Download my ratings</button><p class="status" role="status" aria-live="polite"></p>
<script>
const trials = ${JSON.stringify(trials.map(trial => ({ id: trial.id, order: trial.order })))};
document.querySelector("#download").addEventListener("click", () => {
  const responses = [];
  for (const trial of trials) {
    const article = document.querySelector('[data-trial="' + trial.id + '"]');
    const ratings = {};
    for (const label of ["A", "B"]) {
      const sample = {};
      for (const [key] of ${JSON.stringify(SCALE_ITEMS)}) {
        const value = article.querySelector('[data-rating="' + label + '.' + key + '"]').value;
        if (!value) { article.querySelector('[data-rating="' + label + '.' + key + '"]').focus(); return; }
        sample[key] = Number(value);
      }
      ratings[label] = sample;
    }
    const preference = article.querySelector("[data-preference]").value;
    if (!preference) { article.querySelector("[data-preference]").focus(); return; }
    responses.push({
      trialId: trial.id,
      order: trial.order,
      ratings,
      preference,
      comments: article.querySelector("[data-comments]").value.trim(),
    });
  }
  const file = new Blob([JSON.stringify({ schemaVersion: 1, responses }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url; link.download = "waveyard-ratings.json"; link.click();
  URL.revokeObjectURL(url);
  document.querySelector(".status").textContent = "Ratings downloaded. Send the JSON file to the study organizer.";
});
</script></body></html>`;
}

export async function buildMashupListeningKit({ manifestPath, captureReportPath, outputDirectory }) {
  const manifestAbsolute = resolve(manifestPath);
  const captureAbsolute = resolve(captureReportPath);
  const outputAbsolute = resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(manifestAbsolute, "utf8"));
  const captureReport = JSON.parse(await readFile(captureAbsolute, "utf8"));
  const trackById = new Map(manifest.tracks.map(track => [track.id, track]));
  const captureDirectory = dirname(captureAbsolute);
  const participantDirectory = join(outputAbsolute, "participant");
  const audioDirectory = join(participantDirectory, "audio");
  await mkdir(audioDirectory, { recursive: true });

  const organizerTrials = [];
  const participantTrials = [];
  const measuredCombinations = [];
  for (const capture of captureReport.captures) {
    const combination = manifest.combinations.find(item => item.id === capture.id);
    assert.ok(combination, `manifest has combination ${capture.id}`);
    const lead = trackById.get(combination.leadTrackId);
    const donor = trackById.get(combination.donorTrackId);
    assert.ok(lead && donor, `combination ${capture.id} refers to known tracks`);
    const trialId = randomUUID();
    const baselineWebm = resolve(captureDirectory, capture.baseline.filename);
    const swapWebm = resolve(captureDirectory, capture.swapped.filename);
    const baselineWavName = `${randomUUID()}.wav`;
    const swapWavName = `${randomUUID()}.wav`;
    const baselineWavPath = join(audioDirectory, baselineWavName);
    const swapWavPath = join(audioDirectory, swapWavName);
    runFfmpeg(baselineWebm, baselineWavPath);
    runFfmpeg(swapWebm, swapWavPath);
    const decodedBaselineBytes = await readFile(baselineWavPath);
    const decodedSwapBytes = await readFile(swapWavPath);
    const decodedBaselineMetrics = readPcmWavMetrics(decodedBaselineBytes);
    const decodedSwapMetrics = readPcmWavMetrics(decodedSwapBytes);
    const commonSampleCount = Math.min(decodedBaselineMetrics.samples, decodedSwapMetrics.samples);
    const baselineBytes = trimPcmWavToSamples(decodedBaselineBytes, commonSampleCount);
    const swapBytes = trimPcmWavToSamples(decodedSwapBytes, commonSampleCount);
    if (baselineBytes !== decodedBaselineBytes) await writeFile(baselineWavPath, baselineBytes);
    if (swapBytes !== decodedSwapBytes) await writeFile(swapWavPath, swapBytes);
    const baselineMetrics = readPcmWavMetrics(baselineBytes);
    const swapMetrics = readPcmWavMetrics(swapBytes);
    assert.equal(baselineMetrics.samples, swapMetrics.samples, "blind A/B samples have the same length");
    const order = shuffle(["A", "B"]);
    const isSwapA = randomInt(2) === 0;
    const sampleA = isSwapA
      ? { role: "swap", file: swapWavName }
      : { role: "baseline", file: baselineWavName };
    const sampleB = isSwapA
      ? { role: "baseline", file: baselineWavName }
      : { role: "swap", file: swapWavName };
    participantTrials.push({ id: trialId, order, A: { file: sampleA.file }, B: { file: sampleB.file } });
    organizerTrials.push({
      trialId,
      combinationId: capture.id,
      leadTrackId: lead.id,
      donorTrackId: donor.id,
      stemType: combination.stemType,
      versionA: sampleA.role,
      versionB: sampleB.role,
    });
    measuredCombinations.push({
      id: capture.id,
      leadTrackId: lead.id,
      donorTrackId: donor.id,
      stemType: combination.stemType,
      leadBpm: lead.analysis?.bpm ?? null,
      donorBpm: donor.analysis?.bpm ?? null,
      requestedTempoStretchRatio: capture.swapped.liveSwap?.requestedTempoStretchRatio ?? null,
      tempoRatio: capture.swapped.liveSwap?.timing?.tempoStretchRatio ?? null,
      expectedTempoRatio: capture.swapped.liveSwap?.expectedTempoStretchRatio ?? null,
      tempoMatchApplied: capture.swapped.liveSwap?.tempoMatchApplied ?? false,
      leadKey: lead.analysis?.musicalKey ?? null,
      donorKey: donor.analysis?.musicalKey ?? null,
      leadKeyConfidence: lead.analysis?.keyConfidence ?? null,
      donorKeyConfidence: donor.analysis?.keyConfidence ?? null,
      playbackContinuity: capture.swapped.liveSwap?.advancingOriginalClocks ?? [],
      baseline: { sha256: sha256(baselineBytes), ...baselineMetrics },
      liveSwap: { sha256: sha256(swapBytes), ...swapMetrics },
      humanListening: {
        listenerCount: 0,
        responseCount: 0,
        listenerCountDefinition: "Anonymous response submissions; unique people are not identity-verified.",
        ratings: null,
        preference: null,
      },
    });
  }

  const licenseRows = manifest.tracks.map(track =>
    `- **${track.title}** — ${track.artist}. [Source](${track.sourceUrl}). Licensed [CC BY 4.0](${track.licenseUrl}). Excerpt: ${track.excerpt.startSeconds}s–${track.excerpt.startSeconds + track.excerpt.durationSeconds}s. Changes: excerpted, separated into stems with Waveyard, and used in live stem-swap comparisons.`,
  );
  const credits = [
    "# Source audio credits",
    "",
    "This private evaluation kit contains excerpts and derived mixes. The CC BY 4.0 license permits sharing and commercial reuse with attribution; preserve these credits and indicate the changes when redistributing any audio.",
    "",
    ...licenseRows,
    "",
    "The anonymized audio labels do not guarantee that a listener will fail to recognize a composition. Source titles are kept out of the trial page; this credits file is provided to preserve attribution.",
    "",
  ].join("\n");
  await writeFile(join(participantDirectory, "index.html"), htmlForTrials(shuffle(participantTrials)));
  await writeFile(join(participantDirectory, "LICENSES.md"), credits);
  await writeFile(join(outputAbsolute, "organizer-answer-key.json"), `${JSON.stringify({
    schemaVersion: 1,
    private: true,
    trials: organizerTrials,
  }, null, 2)}\n`);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: captureReport.browserVersion ? "Linux browser capture; see capture report" : process.platform,
    audioFormat: "44.1 kHz stereo PCM16 WAV decoded from Chromium WebM/Opus capture; the kit is not lossless at the browser-capture stage.",
    sources: manifest.tracks.map(track => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      license: track.license,
      sourceUrl: track.sourceUrl,
      sourceSha256: track.sourceSha256,
      excerpt: track.excerpt,
      separationReport: track.separationReport,
      separationMetrics: track.separationMetrics,
      analysis: track.analysis,
      stemFiles: track.stems,
    })),
    combinations: measuredCombinations,
    listenerSummary: {
      listenerCount: 0,
      responseCount: 0,
      listenerCountDefinition: "Anonymous response submissions; unique people are not identity-verified.",
      limitation: "No human ratings have been submitted. Browser playback and signal measurements do not establish perceived musical fit or audible separation quality.",
    },
    evidenceLimit: captureReport.evidenceLimit,
  };
  await writeFile(join(outputAbsolute, "evaluation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { report, participantDirectory, answerKeyPath: join(outputAbsolute, "organizer-answer-key.json") };
}

export function summarizeMashupResponses(report, answerKey, responses) {
  const keyByTrial = new Map(answerKey.trials.map(trial => [trial.trialId, trial]));
  const summaries = new Map(report.combinations.map(combination => [combination.id, {
    combinationId: combination.id,
    responseCount: 0,
    ratings: { baseline: {}, swap: {} },
    preference: { baseline: 0, swap: 0, tie: 0 },
  }]));
  for (const responseFile of responses) {
    if (typeof responseFile === "string") {
      throw new Error("Pass parsed response JSON objects to summarizeMashupResponses.");
    }
    const response = responseFile;
    for (const trialResponse of response.responses ?? []) {
      const trial = keyByTrial.get(trialResponse.trialId);
      if (!trial) continue;
      const summary = summaries.get(trial.combinationId);
      if (!summary) continue;
      summary.responseCount += 1;
      for (const label of ["A", "B"]) {
        const version = trial[`version${label}`];
        for (const [metric, value] of Object.entries(trialResponse.ratings?.[label] ?? {})) {
          if (!Number.isFinite(value) || value < 1 || value > 5) continue;
          const values = summary.ratings[version][metric] ??= [];
          values.push(value);
        }
      }
      const preference = trialResponse.preference;
      if (preference === "tie") summary.preference.tie += 1;
      else if (preference === "A" || preference === "B") {
        summary.preference[trial[`version${preference}`]] += 1;
      }
    }
  }
  return [...summaries.values()].map(summary => ({
    ...summary,
    ratings: Object.fromEntries(Object.entries(summary.ratings).map(([version, metrics]) => [
      version,
      Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [
        metric,
        { mean: values.reduce((sum, value) => sum + value, 0) / values.length, n: values.length },
      ])),
    ])),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") {
    const [manifestPath, captureReportPath, outputDirectory] = args;
    if (!manifestPath || !captureReportPath || !outputDirectory) {
      throw new Error("Usage: node scripts/waveyard-mashup-listening.mjs build <manifest.json> <browser-live-swap-captures.json> <output-directory>");
    }
    const result = await buildMashupListeningKit({ manifestPath, captureReportPath, outputDirectory });
    console.log(JSON.stringify({
      report: join(resolve(outputDirectory), "evaluation-report.json"),
      participantPage: join(result.participantDirectory, "index.html"),
      answerKey: result.answerKeyPath,
    }, null, 2));
  } else if (command === "summarize") {
    const [reportPath, answerKeyPath, ...responsePaths] = args;
    if (!reportPath || !answerKeyPath || responsePaths.length === 0) {
      throw new Error("Usage: node scripts/waveyard-mashup-listening.mjs summarize <evaluation-report.json> <organizer-answer-key.json> <response.json...>");
    }
    const [report, answerKey, ...responses] = await Promise.all([
      readFile(resolve(reportPath), "utf8").then(JSON.parse),
      readFile(resolve(answerKeyPath), "utf8").then(JSON.parse),
      ...responsePaths.map(path => readFile(resolve(path), "utf8").then(JSON.parse)),
    ]);
    const summary = summarizeMashupResponses(report, answerKey, responses);
    const byCombination = new Map(summary.map(item => [item.combinationId, item]));
    report.combinations = report.combinations.map(item => ({
      ...item,
      humanListening: byCombination.get(item.id) ?? {
        combinationId: item.id,
        listenerCount: 0,
        responseCount: 0,
        listenerCountDefinition: "Anonymous response submissions; unique people are not identity-verified.",
        ratings: null,
        preference: null,
      },
    }));
    report.listenerSummary = {
      listenerCount: responses.length,
      responseCount: responses.length,
      listenerCountDefinition: "Count of submitted response files; unique people are not identity-verified.",
      limitation: "Ratings are subjective and only represent the submitted blinded responses.",
    };
    await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report: resolve(reportPath), responseCount: responses.length }, null, 2));
  } else {
    throw new Error("Choose the build or summarize command.");
  }
}
