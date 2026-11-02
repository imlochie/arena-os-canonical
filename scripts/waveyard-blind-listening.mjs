import { createHash, randomInt, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const STEMS = ["vocals", "drums", "bass", "other"];
const MODES = ["sequential", "parallel"];

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function htmlForTrials(trials, studyId) {
  const serializedTrials = JSON.stringify(trials).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blind stem listening comparison</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #172033; background: #f4f6fa; }
    body { max-width: 820px; margin: 0 auto; padding: 28px 18px 60px; }
    h1 { font-size: 1.7rem; margin-bottom: 8px; }
    .intro, .trial { background: white; border: 1px solid #dce2eb; border-radius: 12px; padding: 18px; margin: 16px 0; }
    .trial h2 { font-size: 1.15rem; margin: 0 0 12px; }
    .players { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    audio { display: block; width: 100%; margin: 8px 0; }
    fieldset { border: 0; padding: 0; margin: 16px 0 0; }
    legend { font-weight: 650; margin-bottom: 6px; }
    .choices { display: flex; flex-wrap: wrap; gap: 12px; }
    label { cursor: pointer; }
    textarea, input[type="text"] { box-sizing: border-box; width: 100%; border: 1px solid #aeb9c9; border-radius: 6px; padding: 9px; font: inherit; }
    button { border: 0; border-radius: 7px; padding: 11px 16px; background: #155eef; color: white; font: inherit; font-weight: 650; cursor: pointer; }
    button:disabled { background: #8693a8; cursor: not-allowed; }
    .small { color: #526079; font-size: .92rem; }
    @media (max-width: 560px) { .players { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Blind stem listening comparison</h1>
  <form id="response-form">
  <section class="intro">
    <p>Listen to both versions of each stem. The versions are labeled A and B in randomized order. The CPU setting is not shown.</p>
    <p>Use headphones if available and similar playback volume for both clips. You may replay either clip. Judge whether you hear a difference, then choose which sounds better to you. “No preference” is a valid answer.</p>
    <label for="listener">Optional listener code</label>
    <input id="listener" type="text" maxlength="80" autocomplete="off">
    <fieldset>
      <legend>Did you use headphones?</legend>
      <div class="choices">
        <label><input required type="radio" name="headphones" value="yes"> Yes</label>
        <label><input required type="radio" name="headphones" value="no"> No</label>
        <label><input required type="radio" name="headphones" value="unsure"> Prefer not to say</label>
      </div>
    </fieldset>
    <p class="small">Your answers stay in this browser until you download them. Do not include your name or other personal details.</p>
  </section>
    <div id="trials"></div>
    <button id="download" type="submit">Download my judgments</button>
  </form>
  <script>
    const trials = ${serializedTrials};
    const trialsRoot = document.querySelector("#trials");
    for (const [index, trial] of trials.entries()) {
      const card = document.createElement("section");
      card.className = "trial";
      card.innerHTML = \`
        <h2>Pair \${index + 1}: \${trial.stem}</h2>
        <div class="players">
          <div><strong>Version A</strong><audio controls preload="none" src="\${trial.a}"></audio></div>
          <div><strong>Version B</strong><audio controls preload="none" src="\${trial.b}"></audio></div>
        </div>
        <fieldset>
          <legend>How clearly can you hear a difference?</legend>
          <div class="choices">
            \${["1 — none", "2 — slight", "3 — noticeable", "4 — clear", "5 — very clear"].map((label, ratingIndex) =>
              \`<label><input required type="radio" name="difference-\${trial.id}" value="\${ratingIndex + 1}"> \${label}</label>\`
            ).join("")}
          </div>
        </fieldset>
        <fieldset>
          <legend>Which version do you prefer?</legend>
          <div class="choices">
            \${["A", "B", "No preference"].map((choice) =>
              \`<label><input required type="radio" name="preference-\${trial.id}" value="\${choice}"> \${choice}</label>\`
            ).join("")}
          </div>
        </fieldset>
        <label for="note-\${trial.id}">Optional note</label>
        <textarea id="note-\${trial.id}" name="note-\${trial.id}" rows="2" maxlength="500"></textarea>
      \`;
      trialsRoot.append(card);
    }

    document.querySelector("#response-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      const form = new FormData(event.currentTarget);
      const response = {
        schemaVersion: 1,
        studyId: ${JSON.stringify(studyId)},
        submittedAt: new Date().toISOString(),
        listenerCode: document.querySelector("#listener").value.trim() || null,
        headphoneUse: form.get("headphones"),
        judgments: trials.map((trial) => ({
          trialId: trial.id,
          stem: trial.stem,
          differenceRating: Number(form.get("difference-" + trial.id)),
          preference: form.get("preference-" + trial.id),
          note: String(form.get("note-" + trial.id) || "").trim() || null,
        })),
      };
      const file = new Blob([JSON.stringify(response, null, 2) + "\\n"], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = "waveyard-listening-response.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
  </script>
</body>
</html>
`;
}

export async function createBlindListeningKit({ outputDirectory, sourceFilesByMode, metadata }) {
  for (const mode of MODES) {
    if (!sourceFilesByMode[mode]) throw new Error(`Missing ${mode} audition source directory.`);
  }
  if (!metadata?.input?.processedExcerptSha256 || !Array.isArray(metadata?.input?.models)) {
    throw new Error("Blind listening metadata must include the processed excerpt and pinned model checksums.");
  }

  const participantDirectory = join(outputDirectory, "participant");
  const audioDirectory = join(participantDirectory, "audio");
  const organizerDirectory = join(outputDirectory, "organizer");
  await mkdir(audioDirectory, { recursive: true });
  await mkdir(organizerDirectory, { recursive: true });

  const trials = [];
  const answerKey = [];
  const studyId = randomUUID();
  for (const stem of shuffled(STEMS)) {
    const labels = shuffled(MODES);
    const trialId = randomUUID();
    const trialNumber = trials.length + 1;
    const audioFiles = {};
    const mappings = {};
    for (const [index, label] of ["A", "B"].entries()) {
      const mode = labels[index];
      const sourcePath = join(sourceFilesByMode[mode], `${stem}-estimate.wav`);
      const filename = `${trialNumber}-${label.toLowerCase()}.wav`;
      const targetPath = join(audioDirectory, filename);
      await copyFile(sourcePath, targetPath);
      audioFiles[label.toLowerCase()] = `audio/${filename}`;
      mappings[label] = {
        setting: mode,
        sourceFilename: basename(sourcePath),
        sha256: await sha256(targetPath),
      };
    }
    trials.push({ id: trialId, stem, ...audioFiles });
    answerKey.push({ trialId, stem, versions: mappings });
  }
  const byteIdenticalStemTypes = answerKey
    .filter(({ versions }) => versions.A.sha256 === versions.B.sha256)
    .map(({ stem }) => stem);
  const matchedOutputEquality = {
    byteIdenticalStemTypes,
    identicalStemCount: byteIdenticalStemTypes.length,
    allMatchedOutputsByteIdentical: byteIdenticalStemTypes.length === STEMS.length,
  };

  const key = {
    schemaVersion: 1,
    studyId,
    createdAt: new Date().toISOString(),
    protocol: "First matched repetition; the two CPU settings are randomly assigned to A/B independently for each stem, and stem order is randomized.",
    input: metadata.input,
    settings: metadata.settings,
    outputChecksums: answerKey.map(({ stem, trialId, versions }) => ({ stem, trialId, versions })),
    matchedOutputEquality,
    trials: answerKey,
    listenerSample: {
      status: "not-collected",
      responses: 0,
      limitation: "No listener responses are included until response JSON files are collected and reviewed.",
    },
  };

  await writeFile(join(participantDirectory, "index.html"), htmlForTrials(trials, studyId));
  await writeFile(
    join(organizerDirectory, "answer-key.json"),
    `${JSON.stringify(key, null, 2)}\n`,
  );
  return {
    participantPage: join(participantDirectory, "index.html"),
    answerKey: join(organizerDirectory, "answer-key.json"),
    listenerSample: key.listenerSample,
    outputChecksums: key.outputChecksums,
    matchedOutputEquality,
  };
}
