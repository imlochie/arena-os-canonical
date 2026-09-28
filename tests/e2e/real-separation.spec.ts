import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { alignSourceBeatToTimelineMs, nearestBeat } from "@waveyard/types";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";

const fixture = resolve(
  process.cwd(),
  "tests/fixtures/copyright-safe-fixture.wav",
);
const analysisFixture = resolve(
  process.cwd(),
  "tests/fixtures/analysis-fsharp-minor-120.wav",
);
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner = {
  username: `owner_${stamp}`,
  displayName: "Waveyard E2E Owner",
  email: `owner-${stamp}@example.test`,
  password: "long-test-password-123",
};
let projectId = "";
let stemIds: string[] = [];
let remixId = "";
let remixVersionId = "";
let exportJobId = "";
let retriedExportJobId = "";
const testFaultToken = process.env.WAVEYARD_TEST_FAULT_TOKEN;
const waveformFaults = [
  "waveform-storage-read",
  "waveform-storage-write",
  "waveform-after-write",
  "waveform-worker-restart",
] as const;
type WaveformFault = (typeof waveformFaults)[number];
type TestFault = WaveformFault | "analysis-engine" | "export-render";

async function armTestFault(
  context: APIRequestContext,
  fault: TestFault,
  count = 1,
) {
  const response = await context.post("/api/test/faults", {
    headers: { "x-waveyard-test-fault-token": testFaultToken! },
    data: { fault, count },
  });
  expect(response.status()).toBe(201);
}

async function faultEvents(context: APIRequestContext, fault: WaveformFault) {
  const response = await context.get(`/api/test/faults?fault=${fault}`, {
    headers: { "x-waveyard-test-fault-token": testFaultToken! },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).events as Array<{
    event: string;
    cleanupVerified?: boolean;
  }>;
}

function remixPayload(state: { remix: Record<string, unknown>; tracks: Array<Record<string, unknown>> }) {
  const remix = state.remix;
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
    targetKey: remix.targetKey,
    tracks: state.tracks.map((track) => ({
      id: track.id,
      stemAssetId: track.stemAssetId,
      name: track.name,
      sortOrder: track.sortOrder,
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
      clips: (track.clips as Array<Record<string, unknown>>).map((clip) => ({
        stemAssetId: clip.stemAssetId,
        timelineStartMs: clip.timelineStartMs,
        durationMs: clip.durationMs,
        sourceOffsetMs: clip.sourceOffsetMs,
        gain: clip.gain,
        fadeInMs: clip.fadeInMs,
        fadeOutMs: clip.fadeOutMs,
        tempoSyncEnabled: clip.tempoSyncEnabled === true,
        keySyncEnabled: clip.keySyncEnabled === true,
        beatSnapEnabled: clip.beatSnapEnabled === true,
      })),
    })),
  };
}

test.describe.configure({ mode: "serial" });
test.describe("real Compose separation pipeline", () => {
  test("registers, uploads an original fixture, separates it, validates stored stems, and plays them", async ({
    page,
  }) => {
    await page.goto("/waveyard");
    await page.locator('input[name="username"]').fill(owner.username);
    await page.locator('input[name="displayName"]').fill(owner.displayName);
    await page.locator('input[name="email"]').fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/create");

    await page
      .getByLabel("Optional project title")
      .fill("Original deterministic fixture");
    await page
      .getByLabel("Local audio files")
      .setInputFiles(fixture);
    await page
      .getByRole("button", { name: "BUILD" })
      .click();
    await page.waitForURL(/\/projects\/[\w-]+/);
    projectId = page.url().split("/").at(-1) ?? "";
    expect(projectId).not.toBe("");

    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/projects/${projectId}`);
          if (!response.ok())
            return { status: "http", count: 0, waveformJobs: [] as string[] };
          const body = await response.json();
          return {
            status: body.jobs.at(-1)?.status,
            count: body.stems.length,
            waveformJobs: body.waveformJobs.map(
              (job: { status: string }) => job.status,
            ),
          };
        },
        { timeout: 11 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual({
        status: "complete",
        count: 4,
        waveformJobs: [
          "complete",
          "complete",
          "complete",
          "complete",
          "complete",
        ],
      });

    const project = await (
      await page.request.get(`/api/projects/${projectId}`)
    ).json();
    const expectedStemTypes = ["bass", "drums", "other", "vocals"];
    expect(
      project.stems.map((stem: { stemType: string }) => stem.stemType).sort(),
    ).toEqual(expectedStemTypes);
    expect(project.stems).toHaveLength(4);
    for (const stem of project.stems) {
      expect(stem.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(stem.durationSeconds).toBeGreaterThanOrEqual(18);
      expect(stem.durationSeconds).toBeLessThanOrEqual(22);
      expect(stem.sampleRate).toBe(44_100);
      expect(stem.channels).toBe(2);
      expect(stem.fileSizeBytes).toBeGreaterThan(1000);
    }
    stemIds = project.stems.map((stem: { id: string }) => stem.id);
    expect(project.sources).toHaveLength(1);
    expect(project.sources[0].checksumSha256).toBe(
      createHash("sha256").update(readFileSync(fixture)).digest("hex"),
    );
    expect(project.waveforms).toHaveLength(5);
    for (const waveform of project.waveforms)
      expect(waveform.storageKey).toBeUndefined();

    for (const assetId of [project.sources[0].id, ...stemIds]) {
      const waveform = await page.request.get(
        `/api/assets/${assetId}/waveform`,
      );
      expect(waveform.status()).toBe(200);
      const body = await waveform.json();
      expect(body.storageKey).toBeUndefined();
      expect(body.waveform.format).toBe("waveyard-peaks-v1");
      expect(body.waveform.resolutions["4096"].min).toHaveLength(4096);
      expect(body.waveform.resolutions["4096"].max).toHaveLength(4096);
    }

    for (const type of expectedStemTypes)
      await expect(page.getByTestId(`stem-${type}`)).toBeVisible();
    await page.getByTestId("play-all").click();
    await expect
      .poll(async () =>
        page
          .locator("audio")
          .evaluateAll((audio) =>
            audio.every((element) => !(element as HTMLAudioElement).paused),
          ),
      )
      .toBe(true);
    const partial = await page.request.get(`/api/assets/${stemIds[0]}`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(partial.status()).toBe(206);
    expect(partial.headers()["content-type"]).toContain("audio/wav");
    const download = await page.request.get(
      `/api/assets/${stemIds[0]}?download=1`,
    );
    expect(download.status()).toBe(200);
    expect(download.headers()["content-disposition"]).toContain("attachment");

    await page.getByRole("button", { name: "Create remix session" }).click();
    await expect(
      page.getByRole("heading", { name: "Remix timeline" }),
    ).toBeVisible();
    await page
      .getByLabel("copyright-safe-fixture.wav — Vocals clip 1 start")
      .fill("2");
    await page.getByLabel("Tempo BPM").fill("98");
    await page.getByLabel("Time signature numerator").fill("3");
    await page.getByLabel("Grid division").selectOption("half-beat");
    await page.getByLabel("Snap enabled").uncheck();
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const remixes = await (
      await page.request.get(`/api/projects/${projectId}/remixes`)
    ).json();
    expect(remixes.remixes).toHaveLength(1);
    remixId = remixes.remixes[0].id;
    const savedRemix = await (
      await page.request.get(`/api/remixes/${remixId}`)
    ).json();
    expect(
      savedRemix.tracks.find(
        (track: { name: string }) =>
          track.name === "copyright-safe-fixture.wav — Vocals",
      ).clips[0].timelineStartMs,
    ).toBe(2000);
    expect(savedRemix.remix).toMatchObject({
      tempoBpm: 98,
      timeSignatureNumerator: 3,
      timeSignatureDenominator: 4,
      gridDivision: "half-beat",
      snapEnabled: false,
    });
    const version = await page.request.post(
      `/api/remixes/${remixId}/versions`,
      { data: { name: "Initial arrangement" } },
    );
    expect(version.status()).toBe(201);
    remixVersionId = (await version.json()).version.id;
    const restore = await page.request.post(
      `/api/remixes/${remixId}/versions/${remixVersionId}/restore`,
    );
    expect(restore.status()).toBe(200);
  });

  test("adds a second source through Studio, keeps source identity explicit, and snapshots all eight stems in a new remix", async ({
    page,
  }) => {
    test.setTimeout(25 * 60 * 1000);
    const response = await page.request.post("/api/auth/login", {
      data: { identity: owner.username, password: owner.password },
    });
    expect(response.status()).toBe(200);

    const create = await page.request.post("/api/projects", {
      data: { title: "Two source Studio workflow" },
    });
    expect(create.status()).toBe(201);
    const twoSourceProjectId = (await create.json()).project.id as string;
    const firstUpload = await page.request.post("/api/uploads", {
      multipart: {
        projectId: twoSourceProjectId,
        model: "htdemucs",
        device: "cpu",
        file: {
          name: "song-a.wav",
          mimeType: "audio/wav",
          buffer: readFileSync(fixture),
        },
      },
    });
    expect(firstUpload.status()).toBe(201);

    await expect
      .poll(
        async () => {
          const project = await page.request.get(
            `/api/projects/${twoSourceProjectId}`,
          );
          if (!project.ok()) return { sources: 0, stems: 0, waveformJobs: 0 };
          const state = await project.json();
          return {
            sources: state.sources.length,
            stems: state.stems.length,
            waveformJobs: state.waveformJobs.filter(
              (job: { status: string }) => job.status === "complete",
            ).length,
          };
        },
        { timeout: 11 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual({ sources: 1, stems: 4, waveformJobs: 5 });

    await page.goto(`/projects/${twoSourceProjectId}`);
    const initialStemGroups = page.locator('[data-testid^="source-stems-"]');
    await expect(initialStemGroups).toHaveCount(1);
    await expect(initialStemGroups).toBeVisible();
    await page
      .locator('input[type="file"][name="file"][aria-label="Add source audio"]')
      .setInputFiles({
        name: "song-b.wav",
        mimeType: "audio/wav",
        buffer: readFileSync(fixture),
      });
    await page.getByRole("button", { name: "Separate added source" }).click();
    await expect(page.getByText(/Queued song-b\.wav/)).toBeVisible();

    await expect
      .poll(
        async () => {
          const project = await page.request.get(
            `/api/projects/${twoSourceProjectId}`,
          );
          if (!project.ok())
            return { sources: 0, stems: 0, jobs: 0, waveforms: 0 };
          const state = await project.json();
          return {
            sources: state.sources.length,
            stems: state.stems.length,
            jobs: state.jobs.filter(
              (job: { status: string }) => job.status === "complete",
            ).length,
            waveforms: state.waveformJobs.filter(
              (job: { status: string }) => job.status === "complete",
            ).length,
          };
        },
        { timeout: 11 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual({ sources: 2, stems: 8, jobs: 2, waveforms: 10 });

    const completedProject = await (
      await page.request.get(`/api/projects/${twoSourceProjectId}`)
    ).json();
    const sourceA = completedProject.sources.find(
      (source: { originalFilename: string }) => source.originalFilename === "song-a.wav",
    );
    const sourceB = completedProject.sources.find(
      (source: { originalFilename: string }) => source.originalFilename === "song-b.wav",
    );
    expect(sourceA).toBeTruthy();
    expect(sourceB).toBeTruthy();
    expect(
      completedProject.stems.filter(
        (stem: { sourceAssetId: string }) => stem.sourceAssetId === sourceA.id,
      ),
    ).toHaveLength(4);
    expect(
      completedProject.stems.filter(
        (stem: { sourceAssetId: string }) => stem.sourceAssetId === sourceB.id,
      ),
    ).toHaveLength(4);

    await page.reload();
    await expect(page.getByTestId(`source-stems-${sourceA.id}`)).toContainText("song-a.wav");
    await expect(page.getByTestId(`source-stems-${sourceB.id}`)).toContainText("song-b.wav");
    const sourceBVocalsSelect = page
      .getByTestId(`source-stems-${sourceB.id}`)
      .locator("button.stem-select")
      .filter({ hasText: /^song-b\.wav — Vocals/ });
    await expect(sourceBVocalsSelect).toHaveCount(1);
    await sourceBVocalsSelect.click();
    await expect(
      page.getByRole("heading", { name: "song-b.wav — Vocals" }),
    ).toBeVisible();
    await expect(page.getByText("Source · song-b.wav")).toBeVisible();
    await expect(
      page.getByLabel("song-b.wav — Vocals audio"),
    ).toHaveCount(1);

    await page.getByRole("button", { name: "Create remix session" }).click();
    await expect(page.locator(".timeline-direct .timeline-track")).toHaveCount(8);
    const remixes = await (
      await page.request.get(`/api/projects/${twoSourceProjectId}/remixes`)
    ).json();
    expect(remixes.remixes).toHaveLength(1);
    const twoSourceRemixId = remixes.remixes[0].id as string;
    const initialRemix = await (
      await page.request.get(`/api/remixes/${twoSourceRemixId}`)
    ).json();
    expect(initialRemix.tracks).toHaveLength(8);
    for (const sourceName of ["song-a.wav", "song-b.wav"])
      for (const stemType of ["Bass", "Drums", "Other", "Vocals"])
        expect(initialRemix.tracks.map((track: { name: string }) => track.name)).toContain(
          `${sourceName} — ${stemType}`,
        );

    await page
      .getByLabel("song-a.wav — Vocals clip 1 start")
      .fill("1");
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept("Two source snapshot"));
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(
      page.getByRole("button", { name: "Two source snapshot" }),
    ).toBeVisible();
    await page
      .getByLabel("song-a.wav — Vocals clip 1 start")
      .fill("2");
    await page.getByRole("button", { name: "Save now" }).click();
    await page.reload();
    await expect(
      page.getByLabel("song-a.wav — Vocals clip 1 start"),
    ).toHaveValue("2");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Two source snapshot" }).click();
    await expect(
      page.getByLabel("song-a.wav — Vocals clip 1 start"),
    ).toHaveValue("1");

    const sourceBStem = completedProject.stems.find(
      (stem: { sourceAssetId: string }) => stem.sourceAssetId === sourceB.id,
    );
    const privateStem = await page.request.get(`/api/assets/${sourceBStem.id}`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(privateStem.status()).toBe(206);
    expect(privateStem.headers()["content-type"]).toContain("audio/wav");
  });

  test("runs local musical analysis for two sources, persists real beat knowledge, and retries without duplicate analysis rows", async ({
    page,
  }) => {
    test.skip(!testFaultToken, "The analysis retry path is enabled by npm run test:compose.");
    test.setTimeout(25 * 60 * 1000);
    const login = await page.request.post("/api/auth/login", {
      data: { identity: owner.username, password: owner.password },
    });
    expect(login.status()).toBe(200);
    const create = await page.request.post("/api/projects", {
      data: { title: "Deterministic musical analysis" },
    });
    expect(create.status()).toBe(201);
    const analysisProjectId = (await create.json()).project.id as string;

    const uploadA = await page.request.post("/api/uploads", {
      multipart: {
        projectId: analysisProjectId,
        model: "htdemucs",
        device: "cpu",
        file: {
          name: "analysis-song-a-fsharp-minor.wav",
          mimeType: "audio/wav",
          buffer: readFileSync(analysisFixture),
        },
      },
    });
    expect(uploadA.status()).toBe(201);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/projects/${analysisProjectId}`);
          if (!response.ok()) return { stems: 0, waveforms: 0, status: "http" };
          const state = await response.json();
          return {
            stems: state.stems.length,
            waveforms: state.waveformJobs.filter(
              (job: { status: string }) => job.status === "complete",
            ).length,
            status: state.sources[0]?.analysis?.status,
          };
        },
        { timeout: 12 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual({ stems: 4, waveforms: 5, status: "complete" });

    const firstState = await (
      await page.request.get(`/api/projects/${analysisProjectId}`)
    ).json();
    const sourceA = firstState.sources[0];
    expect(sourceA.analysis).toMatchObject({
      analysisEngine: "waveyard-numpy-dsp",
      analysisEngineVersion: "1.0.0",
      musicalKey: "F# minor",
    });
    // The fixture is intentionally 120 BPM F# minor. Spectral-flux tracking is
    // asserted within ±4 BPM, 44–51 detected positions, and a 470–530ms grid
    // interval tolerance to allow deterministic frame-boundary placement.
    expect(sourceA.analysis.bpm).toBeGreaterThanOrEqual(116);
    expect(sourceA.analysis.bpm).toBeLessThanOrEqual(124);
    expect(sourceA.analysis.beatGrid.length).toBeGreaterThanOrEqual(44);
    expect(sourceA.analysis.beatGrid.length).toBeLessThanOrEqual(51);
    const sourceAIntervals = sourceA.analysis.beatGrid
      .slice(1)
      .map((position: number, index: number) => position - sourceA.analysis.beatGrid[index]);
    const sourceAMedianInterval = [...sourceAIntervals].sort((left, right) => left - right)[Math.floor(sourceAIntervals.length / 2)];
    expect(sourceAMedianInterval).toBeGreaterThanOrEqual(470);
    expect(sourceAMedianInterval).toBeLessThanOrEqual(530);
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const source = state.sources.find((candidate: { id: string }) => candidate.id === sourceA.id);
      return { status: source?.eventAnalysis?.status, count: source?.events?.length ?? 0 };
    }, { timeout: 4 * 60 * 1000, intervals: [1_000, 2_000, 5_000] }).toMatchObject({ status: "complete" });
    const eventsState = await (await page.request.get(`/api/sources/${sourceA.id}/events`)).json();
    expect(eventsState.analysis).toMatchObject({ sourceAssetId: sourceA.id, sourceChecksumSha256: sourceA.checksumSha256, analysisEngine: "waveyard-numpy-onsets", analysisEngineVersion: "1.0.0" });
    expect(eventsState.events).toEqual(expect.arrayContaining([expect.objectContaining({ timestampMs: expect.any(Number), strength: expect.any(Number) })]));
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const vocalStem = state.stems.find((candidate: { sourceAssetId: string; stemType: string }) => candidate.sourceAssetId === sourceA.id && candidate.stemType === "vocals");
      return { status: vocalStem?.vocalAnalysis?.status, frames: vocalStem?.vocalFrames?.length ?? 0 };
    }, { timeout: 4 * 60 * 1000, intervals: [1_000, 2_000, 5_000] }).toMatchObject({ status: "complete" });
    const vocalStem = firstState.stems.find((candidate: { sourceAssetId: string; stemType: string }) => candidate.sourceAssetId === sourceA.id && candidate.stemType === "vocals");
    expect(vocalStem).toBeTruthy();
    const vocalState = await (await page.request.get(`/api/stems/${vocalStem.id}/vocal-analysis`)).json();
    expect(vocalState.analysis).toMatchObject({ sourceAssetId: sourceA.id, stemAssetId: vocalStem.id, sourceChecksumSha256: sourceA.checksumSha256, stemChecksumSha256: vocalStem.checksumSha256, analysisEngine: "waveyard-numpy-monophonic-pitch", analysisEngineVersion: "1.0.0" });
    expect(vocalState.frames).toEqual(expect.arrayContaining([expect.objectContaining({ timestampMs: expect.any(Number), voiced: expect.any(Boolean), confidence: expect.any(Number) })]));
    for (const frame of vocalState.frames) {
      if (frame.voiced) expect(frame).toEqual(expect.objectContaining({ frequencyHz: expect.any(Number), midiFloat: expect.any(Number), nearestMidiNote: expect.any(Number) }));
      else expect(frame).toMatchObject({ frequencyHz: null, midiFloat: null, nearestMidiNote: null });
    }
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const drumStem = state.stems.find((candidate: { sourceAssetId: string; stemType: string }) => candidate.sourceAssetId === sourceA.id && candidate.stemType === "drums");
      return { status: drumStem?.drumAnalysis?.status, events: drumStem?.drumEvents?.length ?? 0 };
    }, { timeout: 4 * 60 * 1000, intervals: [1_000, 2_000, 5_000] }).toMatchObject({ status: "complete" });
    const drumStem = firstState.stems.find((candidate: { sourceAssetId: string; stemType: string }) => candidate.sourceAssetId === sourceA.id && candidate.stemType === "drums");
    const drumState = await (await page.request.get(`/api/stems/${drumStem.id}/drum-analysis`)).json();
    expect(drumState.analysis).toMatchObject({ sourceAssetId: sourceA.id, stemAssetId: drumStem.id, sourceChecksumSha256: sourceA.checksumSha256, stemChecksumSha256: drumStem.checksumSha256, analysisEngine: "waveyard-numpy-drum-transients", analysisEngineVersion: "1.0.0" });
    for (const event of drumState.events) {
      expect(event).toEqual(expect.objectContaining({ timestampMs: expect.any(Number), strength: expect.any(Number), confidence: expect.any(Number) }));
      expect(["kick", "snare", "hat", "other", null]).toContain(event.rhythmicClass);
    }
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const candidate = state.sources.find((item: { id: string }) => item.id === sourceA.id);
      return { status: candidate?.harmonyAnalysis?.status, events: candidate?.harmonyEvents?.length ?? 0 };
    }, { timeout: 4 * 60 * 1000, intervals: [1_000, 2_000, 5_000] }).toMatchObject({ status: "complete" });
    const harmonyState = await (await page.request.get(`/api/sources/${sourceA.id}/harmony-analysis`)).json();
    expect(harmonyState.analysis).toMatchObject({ sourceAssetId: sourceA.id, sourceChecksumSha256: sourceA.checksumSha256, analysisEngine: "waveyard-numpy-chroma-chords", analysisEngineVersion: "1.0.0" });
    for (const event of harmonyState.events) {
      expect(event).toEqual(expect.objectContaining({ startMs: expect.any(Number), endMs: expect.any(Number), confidence: expect.any(Number) }));
      expect(["major", "minor", "dominant7", "minor7", "major7", "diminished", "augmented", "unknown"]).toContain(event.quality);
    }

    // Two injected worker attempts leave a durable failure. The UI retry must
    // then enqueue the exact same analysis row for a real engine execution.
    await armTestFault(page.request, "analysis-engine", 2);
    const uploadB = await page.request.post("/api/uploads", {
      multipart: {
        projectId: analysisProjectId,
        model: "htdemucs",
        device: "cpu",
        file: {
          name: "analysis-song-b-fsharp-minor.wav",
          mimeType: "audio/wav",
          buffer: readFileSync(analysisFixture),
        },
      },
    });
    expect(uploadB.status()).toBe(201);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/projects/${analysisProjectId}`);
          if (!response.ok()) return { sources: 0, stems: 0, waveforms: 0, status: "http", attempts: 0 };
          const state = await response.json();
          const source = state.sources.find(
            (candidate: { originalFilename: string }) => candidate.originalFilename === "analysis-song-b-fsharp-minor.wav",
          );
          return {
            sources: state.sources.length,
            stems: state.stems.length,
            waveforms: state.waveformJobs.filter(
              (job: { status: string }) => job.status === "complete",
            ).length,
            status: source?.analysis?.status,
            attempts: source?.analysis?.attempts ?? 0,
          };
        },
        { timeout: 12 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual({ sources: 2, stems: 8, waveforms: 10, status: "failed", attempts: 2 });

    const failedState = await (
      await page.request.get(`/api/projects/${analysisProjectId}`)
    ).json();
    const sourceB = failedState.sources.find(
      (source: { originalFilename: string }) => source.originalFilename === "analysis-song-b-fsharp-minor.wav",
    );
    expect(sourceB.analysis).toMatchObject({ status: "failed", errorCode: "analysis_failed" });
    expect(sourceB.sectionAnalysis).toMatchObject({ status: "unavailable", errorCode: "insufficient_analysis" });

    // The failure is terminal and explicit: sync is never silently bypassed when
    // its source has no complete BPM analysis. Keep this same two-source remix
    // to exercise the successful worker path after the retry below.
    const remixCreate = await page.request.post(`/api/projects/${analysisProjectId}/remixes`, {
      data: { name: "Tempo sync analysis remix" },
    });
    expect(remixCreate.status()).toBe(201);
    const tempoRemixId = (await remixCreate.json()).remix.id as string;
    const tempoState = await (await page.request.get(`/api/remixes/${tempoRemixId}`)).json();
    const tempoPayload = remixPayload(tempoState);
    tempoPayload.tempoBpm = 96;
    const sourceBStem = failedState.stems.find(
      (stem: { sourceAssetId: string }) => stem.sourceAssetId === sourceB.id,
    );
    expect(sourceBStem).toBeTruthy();
    const sourceBTrack = tempoPayload.tracks.find(
      (track) => track.stemAssetId === sourceBStem.id,
    );
    expect(sourceBTrack).toBeTruthy();
    const sourceBClip = sourceBTrack!.clips[0] as Record<string, unknown>;
    sourceBClip.durationMs = 4_000;
    sourceBClip.sourceOffsetMs = 137;
    sourceBClip.tempoSyncEnabled = true;
    sourceBClip.beatSnapEnabled = true;
    const unavailableBeatSave = await page.request.put(`/api/remixes/${tempoRemixId}`, { data: tempoPayload });
    expect(unavailableBeatSave.status()).toBe(200);
    const unavailableBeatState = await unavailableBeatSave.json();
    expect(unavailableBeatState.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id).clips[0]).toMatchObject({
      sourceOffsetMs: 137,
      beatSnapEnabled: true,
    });
    const unavailableVersion = await page.request.post(`/api/remixes/${tempoRemixId}/versions`, {
      data: { name: "Sync requires analysis" },
    });
    expect(unavailableVersion.status()).toBe(201);
    const unavailableVersionId = (await unavailableVersion.json()).version.id as string;
    const unavailableExport = await page.request.post(`/api/remix-versions/${unavailableVersionId}/exports`, {
      data: { format: "wav" },
    });
    expect(unavailableExport.status()).toBe(201);
    const unavailableExportId = (await unavailableExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${unavailableExportId}`)).json();
      return { status: body.job.status, errorCode: body.job.errorCode };
    }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
      status: "failed", errorCode: "tempo_sync_analysis_missing",
    });

    // Key sync has an independently explicit failure boundary. The target is
    // persisted on the remix; no source key is copied into clip state.
    const keyRemixCreate = await page.request.post(`/api/projects/${analysisProjectId}/remixes`, {
      data: { name: "Key sync analysis remix" },
    });
    expect(keyRemixCreate.status()).toBe(201);
    const keyRemixId = (await keyRemixCreate.json()).remix.id as string;
    const keyState = await (await page.request.get(`/api/remixes/${keyRemixId}`)).json();
    const keyPayload = remixPayload(keyState);
    keyPayload.targetKey = "D minor";
    const keySourceBTrack = keyPayload.tracks.find((track) => track.stemAssetId === sourceBStem.id);
    expect(keySourceBTrack).toBeTruthy();
    const keySourceBClip = keySourceBTrack!.clips[0] as Record<string, unknown>;
    keySourceBClip.durationMs = 4_000;
    keySourceBClip.sourceOffsetMs = 0;
    keySourceBClip.keySyncEnabled = true;
    expect((await page.request.put(`/api/remixes/${keyRemixId}`, { data: keyPayload })).status()).toBe(200);
    const unavailableKeyVersion = await page.request.post(`/api/remixes/${keyRemixId}/versions`, {
      data: { name: "Key sync requires analysis" },
    });
    expect(unavailableKeyVersion.status()).toBe(201);
    const unavailableKeyVersionId = (await unavailableKeyVersion.json()).version.id as string;
    const unavailableKeyExport = await page.request.post(`/api/remix-versions/${unavailableKeyVersionId}/exports`, {
      data: { format: "wav" },
    });
    expect(unavailableKeyExport.status()).toBe(201);
    const unavailableKeyExportId = (await unavailableKeyExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${unavailableKeyExportId}`)).json();
      return { status: body.job.status, errorCode: body.job.errorCode };
    }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
      status: "failed", errorCode: "key_sync_analysis_missing",
    });

    await page.goto(`/projects/${analysisProjectId}`);
    const sourceBAnalysis = page
      .getByTestId(`project-source-${sourceB.id}`)
      .getByTestId(`source-analysis-${sourceB.id}`);
    await expect(sourceBAnalysis).toContainText("Analysis unavailable");
    await expect(page.getByTestId(`source-sections-${sourceB.id}`)).toContainText("needs a complete usable beat grid");
    await sourceBAnalysis.getByRole("button", { name: "Retry analysis" }).click();
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/projects/${analysisProjectId}`);
          const state = await response.json();
          return state.sources.find(
            (source: { id: string }) => source.id === sourceB.id,
          )?.analysis?.status;
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe("complete");

    // Structural analysis is a second durable worker lifecycle over the same
    // original source and persisted beat coordinates, never over rendered audio.
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const source = state.sources.find((candidate: { id: string }) => candidate.id === sourceB.id);
      return { status: source?.sectionAnalysis?.status, count: source?.sections?.length ?? 0 };
    }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toMatchObject({ status: "complete" });

    const completeState = await (
      await page.request.get(`/api/projects/${analysisProjectId}`)
    ).json();
    expect(completeState.sources).toHaveLength(2);
    const analyses = completeState.sources.map((source: { analysis: { id: string } | null }) => source.analysis);
    expect(analyses).toHaveLength(2);
    expect(new Set(analyses.map((analysis: { id: string }) => analysis.id)).size).toBe(2);
    const completedSourceB = completeState.sources.find(
      (source: { id: string }) => source.id === sourceB.id,
    );
    expect(completedSourceB.analysis).toMatchObject({
      status: "complete",
      musicalKey: "F# minor",
    });
    expect(completedSourceB.analysis.attempts).toBeGreaterThanOrEqual(3);
    expect(completedSourceB.sectionAnalysis).toMatchObject({
      status: "complete",
      analysisEngine: "waveyard-numpy-structure",
      analysisEngineVersion: "1.0.0",
    });
    expect(completedSourceB.sections.length).toBeGreaterThanOrEqual(2);
    const completedSourceA = completeState.sources.find((source: { id: string }) => source.id === sourceA.id);
    expect(completedSourceA.sectionAnalysis).toMatchObject({ status: "complete" });
    // Both uploads deliberately use byte-identical audio. Their globally keyed
    // durable rows still need distinct deterministic IDs per source asset.
    const sourceASectionIds = new Set(completedSourceA.sections.map((section: { id: string }) => section.id));
    expect(completedSourceB.sections.some((section: { id: string }) => sourceASectionIds.has(section.id))).toBe(false);
    expect(completedSourceB.sections.map((section: { sectionIndex: number }) => section.sectionIndex)).toEqual(
      completedSourceB.sections.map((_: unknown, index: number) => index),
    );
    expect(completedSourceB.sections.every((section: { label: string; startBeatIndex: number; endBeatIndex: number; startMs: number; endMs: number; analysisEngine: string; sourceChecksumSha256: string }) =>
      section.label === "section" && section.endBeatIndex > section.startBeatIndex
      && section.startMs === completedSourceB.analysis.beatGrid[section.startBeatIndex]
      && section.endMs === completedSourceB.analysis.beatGrid[section.endBeatIndex]
      && section.analysisEngine === "waveyard-numpy-structure"
      && section.sourceChecksumSha256 === completedSourceB.checksumSha256,
    )).toBe(true);
    const sectionBeforeRetry = completedSourceB.sections.map((section: { id: string }) => section.id);
    const sectionRetry = await page.request.post(`/api/source-section-analyses/${completedSourceB.sectionAnalysis.id}/retry`);
    expect(sectionRetry.status()).toBe(200);
    await expect.poll(async () => {
      const state = await (await page.request.get(`/api/projects/${analysisProjectId}`)).json();
      const source = state.sources.find((candidate: { id: string }) => candidate.id === sourceB.id);
      return { status: source?.sectionAnalysis?.status, ids: source?.sections?.map((section: { id: string }) => section.id) ?? [] };
    }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", ids: sectionBeforeRetry });
    const sectionForSlice = completedSourceB.sections[0] as { id: string; startBeatIndex: number; endBeatIndex: number };
    expect(
      (
        await page.request.post(
          `/api/source-analyses/${completedSourceB.analysis.id}/retry`,
        )
      ).status(),
    ).toBe(409);

    // The same persisted source-B clip now derives target/source at render time
    // and produces a private worker-owned WAV with immutable version provenance.
    const syncedVersion = await page.request.post(`/api/remixes/${tempoRemixId}/versions`, {
      data: { name: "Source B synced to 96 BPM" },
    });
    expect(syncedVersion.status()).toBe(201);
    const syncedVersionId = (await syncedVersion.json()).version.id as string;
    const syncedExport = await page.request.post(`/api/remix-versions/${syncedVersionId}/exports`, {
      data: { format: "wav" },
    });
    expect(syncedExport.status()).toBe(201);
    const syncedExportId = (await syncedExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${syncedExportId}`)).json();
      return { status: body.job.status, asset: Boolean(body.asset) };
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", asset: true });
    const syncedResult = await (await page.request.get(`/api/exports/${syncedExportId}`)).json();
    expect(syncedResult.asset.remixVersionId).toBe(syncedVersionId);
    const syncedMedia = await page.request.get(`/api/exports/${syncedExportId}/media`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(syncedMedia.status()).toBe(206);
    expect(syncedMedia.headers()["content-type"]).toContain("audio/wav");

    const keySyncedVersion = await page.request.post(`/api/remixes/${keyRemixId}/versions`, {
      data: { name: "Source B shifted to D minor" },
    });
    expect(keySyncedVersion.status()).toBe(201);
    const keySyncedVersionId = (await keySyncedVersion.json()).version.id as string;
    const keySyncedExport = await page.request.post(`/api/remix-versions/${keySyncedVersionId}/exports`, {
      data: { format: "wav" },
    });
    expect(keySyncedExport.status()).toBe(201);
    const keySyncedExportId = (await keySyncedExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${keySyncedExportId}`)).json();
      return { status: body.job.status, asset: Boolean(body.asset) };
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", asset: true });
    const keySyncedResult = await (await page.request.get(`/api/exports/${keySyncedExportId}`)).json();
    expect(keySyncedResult.asset.remixVersionId).toBe(keySyncedVersionId);
    const keySyncedState = await (await page.request.get(`/api/remixes/${keyRemixId}`)).json();
    expect(keySyncedState.remix.targetKey).toBe("D minor");
    expect(keySyncedState.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id).clips[0]).toMatchObject({ keySyncEnabled: true, tempoSyncEnabled: false });
    const keySyncedMedia = await page.request.get(`/api/exports/${keySyncedExportId}/media`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(keySyncedMedia.status()).toBe(206);
    expect(keySyncedMedia.headers()["content-type"]).toContain("audio/wav");

    // Source-space beats resolve at persistence, while a source-A clip left
    // disabled remains freehand even though its own analysis is complete.
    expect(completedSourceB.analysis.beatGrid.length).toBeGreaterThan(3);
    const beatRemixCreate = await page.request.post(`/api/projects/${analysisProjectId}/remixes`, {
      data: { name: "Beat-aware source B remix" },
    });
    expect(beatRemixCreate.status()).toBe(201);
    const beatRemixId = (await beatRemixCreate.json()).remix.id as string;
    const beatState = await (await page.request.get(`/api/remixes/${beatRemixId}`)).json();
    const beatPayload = remixPayload(beatState);
    beatPayload.tempoBpm = 96;
    const beatSourceBTrack = beatPayload.tracks.find((track) => track.stemAssetId === sourceBStem.id);
    const sourceAStem = completeState.stems.find((stem: { sourceAssetId: string }) => stem.sourceAssetId === sourceA.id);
    const beatSourceATrack = beatPayload.tracks.find((track) => track.stemAssetId === sourceAStem.id);
    expect(beatSourceBTrack).toBeTruthy();
    expect(beatSourceATrack).toBeTruthy();
    const offGridOffset = completedSourceB.analysis.beatGrid[2] + 100;
    const expectedBeatOffset = nearestBeat(offGridOffset, completedSourceB.analysis.beatGrid);
    const beatSourceBClip = beatSourceBTrack!.clips[0] as Record<string, unknown>;
    beatSourceBClip.sourceOffsetMs = offGridOffset;
    beatSourceBClip.durationMs = 4_000;
    beatSourceBClip.tempoSyncEnabled = true;
    beatSourceBClip.beatSnapEnabled = true;
    const freeformClip = beatSourceATrack!.clips[0] as Record<string, unknown>;
    freeformClip.sourceOffsetMs = 133;
    freeformClip.durationMs = 4_000;
    freeformClip.beatSnapEnabled = false;
    const beatSaved = await page.request.put(`/api/remixes/${beatRemixId}`, { data: beatPayload });
    expect(beatSaved.status()).toBe(200);
    const beatArranged = await beatSaved.json();
    expect(beatArranged.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id).clips[0]).toMatchObject({
      sourceOffsetMs: expectedBeatOffset,
      beatSnapEnabled: true,
      tempoSyncEnabled: true,
    });
    expect(beatArranged.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceAStem.id).clips[0]).toMatchObject({
      sourceOffsetMs: 133,
      beatSnapEnabled: false,
    });
    const beatVersion = await page.request.post(`/api/remixes/${beatRemixId}/versions`, {
      data: { name: "Source B beat-aligned" },
    });
    expect(beatVersion.status()).toBe(201);
    const beatVersionId = (await beatVersion.json()).version.id as string;
    // A later freehand edit proves restoring the version preserves its beat-aligned metadata.
    const beatChanged = structuredClone(beatPayload);
    const changedSourceBTrack = beatChanged.tracks.find((track) => String(track.stemAssetId) === String(sourceBStem.id));
    expect(changedSourceBTrack).toBeTruthy();
    changedSourceBTrack!.clips[0].beatSnapEnabled = false;
    changedSourceBTrack!.clips[0].sourceOffsetMs = 177;
    expect((await page.request.put(`/api/remixes/${beatRemixId}`, { data: beatChanged })).status()).toBe(200);
    expect((await page.request.post(`/api/remixes/${beatRemixId}/versions/${beatVersionId}/restore`)).status()).toBe(200);
    const beatRestored = await (await page.request.get(`/api/remixes/${beatRemixId}`)).json();
    expect(beatRestored.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id).clips[0]).toMatchObject({
      sourceOffsetMs: expectedBeatOffset,
      beatSnapEnabled: true,
    });
    const beatExport = await page.request.post(`/api/remix-versions/${beatVersionId}/exports`, { data: { format: "wav" } });
    expect(beatExport.status()).toBe(201);
    const beatExportId = (await beatExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${beatExportId}`)).json();
      return { status: body.job.status, asset: Boolean(body.asset) };
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", asset: true });
    const beatExportResult = await (await page.request.get(`/api/exports/${beatExportId}`)).json();
    expect(beatExportResult.asset.remixVersionId).toBe(beatVersionId);
    const beatMedia = await page.request.get(`/api/exports/${beatExportId}/media`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(beatMedia.status()).toBe(206);
    expect(beatMedia.headers()["content-type"]).toContain("audio/wav");

    // Phase 9 treats beat cuts and repeats as ordinary immutable-stem clips.
    const sourceBAlignedClip = beatRestored.tracks
      .find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id)
      .clips.find((candidate: { beatSnapEnabled: boolean }) => candidate.beatSnapEnabled);
    expect(sourceBAlignedClip).toBeTruthy();

    // Phase 11 turns a current durable SourceSection into ordinary RemixClips.
    // A compatible selected clip supplies its established transform intent.
    const sectionInsert = await page.request.post(`/api/remixes/${beatRemixId}/clips/from-section`, {
      data: {
        sectionId: sectionForSlice.id,
        stemAssetId: sourceBStem.id,
        remixTrackId: beatSourceBTrack!.id,
        contextClipId: sourceBAlignedClip.id,
        action: "insert",
        timelineStartMs: 12_345,
      },
    });
    expect(sectionInsert.status()).toBe(201);
    const insertedSectionClip = (await sectionInsert.json()).clips[0];
    const sectionSourceRatio = 96 / completedSourceB.analysis.bpm;
    expect(insertedSectionClip).toMatchObject({
      stemAssetId: sourceBStem.id,
      timelineStartMs: 12_345,
      sourceOffsetMs: completedSourceB.analysis.beatGrid[sectionForSlice.startBeatIndex],
      durationMs: Math.round((completedSourceB.analysis.beatGrid[sectionForSlice.endBeatIndex] - completedSourceB.analysis.beatGrid[sectionForSlice.startBeatIndex]) / sectionSourceRatio),
      tempoSyncEnabled: true,
      keySyncEnabled: false,
      beatSnapEnabled: true,
    });
    const sectionAdd = await page.request.post(`/api/remixes/${beatRemixId}/clips/from-section`, {
      data: {
        sectionId: sectionForSlice.id,
        stemAssetId: sourceBStem.id,
        remixTrackId: beatSourceBTrack!.id,
        action: "add",
        timelineStartMs: 14_000,
      },
    });
    expect(sectionAdd.status()).toBe(201);
    const addedSectionClip = (await sectionAdd.json()).clips[0];
    expect(addedSectionClip).toMatchObject({ timelineStartMs: 14_000, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false });
    // Phase 12 moves only the timeline anchor. It resolves an authoritative
    // Source-B beat server-side and preserves the ordinary clip source window.
    const alignmentBeatIndex = sectionForSlice.startBeatIndex + 1;
    const alignmentTargetMs = 12_000;
    const alignResponse = await page.request.post(`/api/remixes/${beatRemixId}/clips/align-beat`, {
      data: { clipId: insertedSectionClip.id, sourceBeatIndex: alignmentBeatIndex, timelineTargetMs: alignmentTargetMs },
    });
    expect(alignResponse.status()).toBe(200);
    const alignedSectionClip = (await alignResponse.json()).clip;
    const expectedAlignedStart = alignSourceBeatToTimelineMs({
      sourceBeatMs: completedSourceB.analysis.beatGrid[alignmentBeatIndex],
      sourceOffsetMs: insertedSectionClip.sourceOffsetMs,
      timelineTargetMs: alignmentTargetMs,
      sourceBpm: completedSourceB.analysis.bpm,
      remixBpm: 96,
      tempoSyncEnabled: true,
    });
    expect(expectedAlignedStart).not.toBeNull();
    expect(alignedSectionClip).toMatchObject({
      id: insertedSectionClip.id,
      timelineStartMs: expectedAlignedStart,
      sourceOffsetMs: insertedSectionClip.sourceOffsetMs,
      durationMs: insertedSectionClip.durationMs,
      gain: insertedSectionClip.gain,
      fadeInMs: insertedSectionClip.fadeInMs,
      fadeOutMs: insertedSectionClip.fadeOutMs,
      tempoSyncEnabled: true,
      keySyncEnabled: false,
      beatSnapEnabled: true,
    });
    const unavailableAlignment = await page.request.post(`/api/remixes/${beatRemixId}/clips/align-beat`, {
      data: { clipId: addedSectionClip.id, sourceBeatIndex: 999_999, timelineTargetMs: 0 },
    });
    expect(unavailableAlignment.status()).toBe(422);
    expect((await unavailableAlignment.json()).errorCode).toBe("cross_source_alignment_unavailable");
    const sectionLoop = await page.request.post(`/api/remixes/${beatRemixId}/clips/from-section`, {
      data: {
        sectionId: sectionForSlice.id,
        stemAssetId: sourceBStem.id,
        remixTrackId: beatSourceBTrack!.id,
        contextClipId: sourceBAlignedClip.id,
        action: "loop",
        timelineStartMs: 16_000,
        repetitions: 2,
      },
    });
    expect(sectionLoop.status()).toBe(201);
    const sectionLoopClips = (await sectionLoop.json()).clips as Array<Record<string, number | string | boolean>>;
    expect(sectionLoopClips).toHaveLength(3);
    expect(new Set(sectionLoopClips.map((clip) => clip.id)).size).toBe(3);
    expect(sectionLoopClips.map((clip) => clip.timelineStartMs)).toEqual([
      16_000,
      16_000 + insertedSectionClip.durationMs,
      16_000 + 2 * insertedSectionClip.durationMs,
    ]);
    expect(sectionLoopClips.every((clip) => clip.sourceOffsetMs === insertedSectionClip.sourceOffsetMs && clip.durationMs === insertedSectionClip.durationMs && clip.tempoSyncEnabled === true && clip.beatSnapEnabled === true)).toBe(true);
    const staleSection = await page.request.post(`/api/remixes/${beatRemixId}/clips/from-section`, {
      data: { sectionId: sourceASectionIds.values().next().value, stemAssetId: sourceBStem.id, remixTrackId: beatSourceBTrack!.id, action: "insert", timelineStartMs: 0 },
    });
    expect(staleSection.status()).toBe(422);
    expect((await staleSection.json()).errorCode).toBe("section_action_unavailable");
    const sliceResponse = await page.request.post(`/api/remixes/${beatRemixId}/clips/slice`, {
      // The existing Phase 9 slice endpoint consumes the selected structural
      // source range; it still creates an ordinary RemixClip.
      data: { clipId: sourceBAlignedClip.id, startBeatIndex: sectionForSlice.startBeatIndex, endBeatIndex: sectionForSlice.endBeatIndex },
    });
    expect(sliceResponse.status()).toBe(201);
    const slice = (await sliceResponse.json()).clip;
    const sourceRatio = 96 / completedSourceB.analysis.bpm;
    expect(slice).toMatchObject({
      stemAssetId: sourceBStem.id,
      sourceOffsetMs: completedSourceB.analysis.beatGrid[sectionForSlice.startBeatIndex],
      durationMs: Math.round((completedSourceB.analysis.beatGrid[sectionForSlice.endBeatIndex] - completedSourceB.analysis.beatGrid[sectionForSlice.startBeatIndex]) / sourceRatio),
      tempoSyncEnabled: true,
      keySyncEnabled: false,
      beatSnapEnabled: true,
    });
    const slicedReload = await (await page.request.get(`/api/remixes/${beatRemixId}`)).json();
    const slicedTrack = slicedReload.tracks.find((track: { stemAssetId: string }) => track.stemAssetId === sourceBStem.id);
    expect(slicedTrack.clips.map((candidate: { id: string }) => candidate.id)).toEqual(expect.arrayContaining([
      slice.id,
      insertedSectionClip.id,
      addedSectionClip.id,
      ...sectionLoopClips.map((clip) => clip.id),
    ]));
    expect(slicedTrack.clips.find((candidate: { id: string }) => candidate.id === insertedSectionClip.id)).toMatchObject({
      timelineStartMs: expectedAlignedStart,
      sourceOffsetMs: insertedSectionClip.sourceOffsetMs,
      durationMs: insertedSectionClip.durationMs,
    });

    const loopResponse = await page.request.post(`/api/remixes/${beatRemixId}/clips/loop`, {
      data: { clipId: slice.id, repetitions: 3 },
    });
    expect(loopResponse.status()).toBe(201);
    const loopClips = (await loopResponse.json()).clips as Array<Record<string, unknown>>;
    expect(loopClips).toHaveLength(3);
    expect(loopClips.map((candidate) => candidate.timelineStartMs)).toEqual([
      slice.timelineStartMs + slice.durationMs,
      slice.timelineStartMs + 2 * slice.durationMs,
      slice.timelineStartMs + 3 * slice.durationMs,
    ]);
    expect(new Set(loopClips.map((candidate) => candidate.id)).size).toBe(3);
    expect(loopClips).toEqual(expect.arrayContaining([
      expect.objectContaining({ stemAssetId: sourceBStem.id, sourceOffsetMs: slice.sourceOffsetMs, durationMs: slice.durationMs, tempoSyncEnabled: true, keySyncEnabled: false, beatSnapEnabled: true }),
    ]));

    const choppedVersion = await page.request.post(`/api/remixes/${beatRemixId}/versions`, {
      data: { name: "Beat slice and independent loop" },
    });
    expect(choppedVersion.status()).toBe(201);
    const choppedVersionId = (await choppedVersion.json()).version.id as string;
    const choppedExport = await page.request.post(`/api/remix-versions/${choppedVersionId}/exports`, { data: { format: "wav" } });
    expect(choppedExport.status()).toBe(201);
    const choppedExportId = (await choppedExport.json()).job.id as string;
    await expect.poll(async () => {
      const body = await (await page.request.get(`/api/exports/${choppedExportId}`)).json();
      return { status: body.job.status, asset: Boolean(body.asset) };
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", asset: true });
    const choppedResult = await (await page.request.get(`/api/exports/${choppedExportId}`)).json();
    expect(choppedResult.asset.remixVersionId).toBe(choppedVersionId);
    const choppedMedia = await page.request.get(`/api/exports/${choppedExportId}/media`, {
      headers: { Range: "bytes=0-2047" },
    });
    expect(choppedMedia.status()).toBe(206);
    expect(choppedMedia.headers()["content-type"]).toContain("audio/wav");

    await page.reload();
    await expect(
      page
        .getByTestId(`project-source-${sourceA.id}`)
        .getByTestId(`source-analysis-${sourceA.id}`),
    ).toContainText("F# minor");
    await expect(
      page
        .getByTestId(`project-source-${sourceB.id}`)
        .getByTestId(`source-analysis-${sourceB.id}`),
    ).toContainText("Beat grid");
    const sourceBVocalsSelect = page
      .getByTestId(`source-stems-${sourceB.id}`)
      .locator("button.stem-select")
      .filter({ hasText: /^analysis-song-b-fsharp-minor\.wav — Vocals/ });
    await expect(sourceBVocalsSelect).toHaveCount(1);
    await sourceBVocalsSelect.click();
    const sourceSectionMap = page.getByTestId(`source-section-map-${sourceB.id}`);
    await expect(sourceSectionMap).toContainText("Detected structure");
    await sourceSectionMap.getByRole("listitem").first().click();
    await expect(sourceSectionMap).toContainText("Use these beats in Slice");
    await sourceSectionMap.getByRole("button", { name: "Use these beats in Slice" }).click();
    const selectedSourceAnalysis = page
      .locator(".inspector")
      .getByTestId(`source-analysis-${sourceB.id}`);
    await expect(selectedSourceAnalysis).toContainText("F# minor");
    await expect(selectedSourceAnalysis).toContainText("Beat grid");
  });

  test("persists timing, looped crossfades, track copies, restore, and authoritative arrangement export", async ({ baseURL }) => {
    test.setTimeout(6 * 60 * 1000);
    const context = await playwrightRequest.newContext({ baseURL });
    try {
      const login = await context.post("/api/auth/login", { data: { identity: owner.username, password: owner.password } });
      expect(login.status()).toBe(200);
      const before = await (await context.get(`/api/remixes/${remixId}`)).json();
      const sourceTrack = before.tracks[0] as Record<string, unknown>;
      const duplicate = await context.post(`/api/remixes/${remixId}/tracks`, { data: { sourceTrackId: sourceTrack.id } });
      expect(duplicate.status()).toBe(201);
      const duplicated = await duplicate.json();
      expect(duplicated.tracks).toHaveLength(5);
      const copied = duplicated.tracks.find((track: Record<string, unknown>) => track.id !== sourceTrack.id && track.stemAssetId === sourceTrack.stemAssetId);
      expect(copied).toMatchObject({ stemAssetId: sourceTrack.stemAssetId });
      expect(copied.clips).toHaveLength((sourceTrack.clips as unknown[]).length);

      const payload = remixPayload(duplicated);
      payload.tempoBpm = 96;
      payload.timeSignatureNumerator = 3;
      payload.timeSignatureDenominator = 4;
      payload.gridDivision = "half-beat";
      payload.snapEnabled = true;
      payload.loopStartMs = 1_000;
      payload.loopEndMs = 9_000;
      for (const track of payload.tracks) {
        const stemAssetId = String(track.stemAssetId);
        track.clips = [{ stemAssetId, timelineStartMs: 0, durationMs: 8_000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false }];
      }
      // The first track has two overlapping clips. Equal one-second boundary
      // fades make this the supported deterministic crossfade form.
      payload.tracks[0].clips = [
        { stemAssetId: String(payload.tracks[0].stemAssetId), timelineStartMs: 0, durationMs: 7_000, sourceOffsetMs: 0, gain: 0.8, fadeInMs: 0, fadeOutMs: 1_000, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false },
        { stemAssetId: String(payload.tracks[0].stemAssetId), timelineStartMs: 6_000, durationMs: 6_000, sourceOffsetMs: 6_000, gain: 1, fadeInMs: 1_000, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false },
      ];
      const saved = await context.put(`/api/remixes/${remixId}`, { data: payload });
      expect(saved.status()).toBe(200);
      const arranged = await saved.json();
      expect(arranged.remix).toMatchObject({ tempoBpm: 96, timeSignatureNumerator: 3, timeSignatureDenominator: 4, gridDivision: "half-beat", snapEnabled: true, loopStartMs: 1_000, loopEndMs: 9_000 });
      expect(arranged.tracks[0].clips).toMatchObject([{ fadeOutMs: 1_000, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false }, { timelineStartMs: 6_000, fadeInMs: 1_000, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false }]);

      const invalidCrossfade = structuredClone(payload);
      invalidCrossfade.tracks[0].clips[0].fadeOutMs = 500;
      const rejected = await context.put(`/api/remixes/${remixId}`, { data: invalidCrossfade });
      expect(rejected.status()).toBe(422);

      const version = await context.post(`/api/remixes/${remixId}/versions`, { data: { name: "Timed crossfade arrangement" } });
      expect(version.status()).toBe(201);
      const arrangementVersionId = (await version.json()).version.id as string;
      const changed = structuredClone(payload);
      changed.tempoBpm = 140;
      changed.loopEndMs = 10_000;
      expect((await context.put(`/api/remixes/${remixId}`, { data: changed })).status()).toBe(200);
      expect((await context.post(`/api/remixes/${remixId}/versions/${arrangementVersionId}/restore`)).status()).toBe(200);
      const restored = await (await context.get(`/api/remixes/${remixId}`)).json();
      expect(restored.remix).toMatchObject({ tempoBpm: 96, loopStartMs: 1_000, loopEndMs: 9_000, gridDivision: "half-beat", snapEnabled: true });
      expect(restored.tracks).toHaveLength(5);

      const requested = await context.post(`/api/remix-versions/${arrangementVersionId}/exports`, { data: { format: "wav" } });
      expect(requested.status()).toBe(201);
      const arrangementExportId = (await requested.json()).job.id as string;
      await expect.poll(async () => {
        const body = await (await context.get(`/api/exports/${arrangementExportId}`)).json();
        return { status: body.job.status, duration: body.asset?.durationSeconds, asset: Boolean(body.asset) };
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ status: "complete", duration: 12, asset: true });
      const exportMedia = await context.get(`/api/exports/${arrangementExportId}/media`, { headers: { Range: "bytes=0-2047" } });
      expect(exportMedia.status()).toBe(206);
      expect(exportMedia.headers()["content-type"]).toContain("audio/wav");

      // Phase 13 remains a narrow, persisted ordinary-clip workflow: source
      // provenance and transforms survive each move/nudge/trim/slip/duplicate
      // action, while split replaces the one source-bounded clip transactionally.
      const phase13State = await (await context.get(`/api/remixes/${remixId}`)).json();
      const phase13Track = phase13State.tracks[0] as Record<string, unknown>;
      const phase13Clip = (phase13Track.clips as Array<Record<string, unknown>>)[0];
      const edit = async (operation: string, data: Record<string, unknown> = {}) => context.post(
        `/api/remixes/${remixId}/clips/edit`,
        { data: { operation, clipId: phase13Clip.id, ...data } },
      );
      const moved = await edit("move", { timelineStartMs: 2_000, snapMode: "free" });
      expect(moved.status()).toBe(200);
      expect((await moved.json()).clip).toMatchObject({ timelineStartMs: 2_000, sourceOffsetMs: 0, gain: 0.8 });
      const nudged = await edit("nudge", { amount: "10ms", direction: "forward" });
      expect(nudged.status()).toBe(200);
      expect((await nudged.json()).clip).toMatchObject({ timelineStartMs: 2_010, sourceOffsetMs: 0 });
      const leftTrim = await edit("trim-left", { timelineDeltaMs: 100 });
      expect(leftTrim.status()).toBe(200);
      expect((await leftTrim.json()).clip).toMatchObject({ timelineStartMs: 2_110, sourceOffsetMs: 100, durationMs: 6_900 });
      const rightTrim = await edit("trim-right", { timelineDeltaMs: -100 });
      expect(rightTrim.status()).toBe(200);
      expect((await rightTrim.json()).clip).toMatchObject({ timelineStartMs: 2_110, sourceOffsetMs: 100, durationMs: 6_800 });
      const slipped = await edit("slip", { sourceOffsetMs: 200 });
      expect(slipped.status()).toBe(200);
      expect((await slipped.json()).clip).toMatchObject({ timelineStartMs: 2_110, sourceOffsetMs: 200, durationMs: 6_800, gain: 0.8, fadeOutMs: 1_000 });
      const duplicateClip = await edit("duplicate");
      expect(duplicateClip.status()).toBe(201);
      const duplicateBody = await duplicateClip.json();
      expect(duplicateBody.clip).toMatchObject({ timelineStartMs: 8_910, sourceOffsetMs: 200, durationMs: 6_800, gain: 0.8, fadeOutMs: 1_000 });
      const split = await edit("split", { timelineMs: 5_000 });
      expect(split.status()).toBe(200);
      const splitBody = await split.json();
      expect(splitBody.clips).toHaveLength(2);
      expect(splitBody.clips).toMatchObject([
        { timelineStartMs: 2_110, durationMs: 2_890, sourceOffsetMs: 200, gain: 0.8, fadeOutMs: 0 },
        { timelineStartMs: 5_000, durationMs: 3_910, sourceOffsetMs: 3_090, gain: 0.8, fadeInMs: 0, fadeOutMs: 1_000 },
      ]);
      const phase13Reloaded = await (await context.get(`/api/remixes/${remixId}`)).json();
      expect((phase13Reloaded.tracks[0].clips as Array<Record<string, unknown>>).some((clip) => clip.id === phase13Clip.id)).toBe(false);
      expect(phase13Reloaded.tracks[0].clips).toHaveLength(4);

      // Phase 14 composes IDs only in the UI, but persists each multi-clip
      // operation atomically. The same delta retains selected-clip spacing.
      const phase14Ids = (phase13Reloaded.tracks[0].clips as Array<Record<string, unknown>>)
        .slice(0, 2).map((clip) => String(clip.id));
      const phase14Starts = (phase13Reloaded.tracks[0].clips as Array<Record<string, unknown>>)
        .slice(0, 2).map((clip) => Number(clip.timelineStartMs));
      const groupMove = await context.post(`/api/remixes/${remixId}/clips/batch-edit`, {
        data: { operation: "move", clipIds: phase14Ids, timelineDeltaMs: 250 },
      });
      expect(groupMove.status()).toBe(200);
      const groupMoveBody = await groupMove.json();
      const movedStarts = groupMoveBody.clips.map((clip: Record<string, unknown>) => Number(clip.timelineStartMs)).sort((a: number, b: number) => a - b);
      const expectedMovedStarts = phase14Starts.map((start) => start + 250).sort((a, b) => a - b);
      expect(movedStarts).toEqual(expectedMovedStarts);
      expect(movedStarts[1] - movedStarts[0]).toBe(expectedMovedStarts[1] - expectedMovedStarts[0]);
      const groupDuplicate = await context.post(`/api/remixes/${remixId}/clips/batch-edit`, {
        data: { operation: "duplicate", clipIds: phase14Ids },
      });
      expect(groupDuplicate.status()).toBe(200);
      const groupDuplicateBody = await groupDuplicate.json();
      expect(groupDuplicateBody.clips).toHaveLength(2);
      const invalidGroupMove = await context.post(`/api/remixes/${remixId}/clips/batch-edit`, {
        data: { operation: "move", clipIds: phase14Ids, timelineDeltaMs: -20_000 },
      });
      expect(invalidGroupMove.status()).toBe(422);
      const afterRejectedGroupMove = await (await context.get(`/api/remixes/${remixId}`)).json();
      const afterRejectedStarts = (afterRejectedGroupMove.tracks[0].clips as Array<Record<string, unknown>>)
        .filter((clip) => phase14Ids.includes(String(clip.id))).map((clip) => Number(clip.timelineStartMs));
      expect(afterRejectedStarts.sort((a, b) => a - b)).toEqual(phase14Starts.map((start) => start + 250).sort((a, b) => a - b));
      const groupDelete = await context.post(`/api/remixes/${remixId}/clips/batch-edit`, {
        data: { operation: "delete", clipIds: groupDuplicateBody.clips.map((clip: Record<string, unknown>) => clip.id) },
      });
      expect(groupDelete.status()).toBe(200);
      expect((await groupDelete.json()).removedClipIds).toHaveLength(2);

      // Phase 15 automation has one project/remix/track scope, survives reload
      // and a RemixVersion snapshot, and never accepts a sibling-remix track.
      const automationTrackId = String(phase13Reloaded.tracks[0].id);
      const addAutomation = (data: Record<string, unknown>) => context.post(`/api/remixes/${remixId}/automation`, { data });
      expect((await addAutomation({ operation: "upsert", remixTrackId: automationTrackId, parameter: "volume", timelineMs: 0, value: 0.25 })).status()).toBe(200);
      expect((await addAutomation({ operation: "upsert", remixTrackId: automationTrackId, parameter: "volume", timelineMs: 1_000, value: 1 })).status()).toBe(200);
      const duplicateTimestamp = await addAutomation({ operation: "upsert", remixTrackId: automationTrackId, parameter: "volume", timelineMs: 1_000, value: 1.25 });
      expect(duplicateTimestamp.status()).toBe(200);
      const automationReload = await (await context.get(`/api/remixes/${remixId}`)).json();
      const volumeLane = automationReload.automation.find((lane: Record<string, unknown>) => lane.remixTrackId === automationTrackId && lane.parameter === "volume");
      expect(volumeLane.points).toEqual(expect.arrayContaining([{ timelineMs: 0, value: 0.25 }, { timelineMs: 1_000, value: 1.25 }]));
      const automationVersion = await context.post(`/api/remixes/${remixId}/versions`, { data: { name: "Automation V1 snapshot" } });
      expect(automationVersion.status()).toBe(201);
      const automationVersionId = (await automationVersion.json()).version.id as string;
      const firstPointId = volumeLane.points.find((point: Record<string, unknown>) => point.timelineMs === 0).id as string;
      expect((await addAutomation({ operation: "delete", remixTrackId: automationTrackId, parameter: "volume", pointId: firstPointId })).status()).toBe(200);
      expect((await context.post(`/api/remixes/${remixId}/versions/${automationVersionId}/restore`)).status()).toBe(200);
      const restoredAutomation = await (await context.get(`/api/remixes/${remixId}`)).json();
      expect(restoredAutomation.automation.find((lane: Record<string, unknown>) => lane.remixTrackId === automationTrackId && lane.parameter === "volume").points).toHaveLength(2);
      const sibling = await context.post(`/api/projects/${projectId}/remixes`, { data: { name: "Automation isolation sibling" } });
      expect(sibling.status()).toBe(201);
      const siblingId = (await sibling.json()).remix.id as string;
      const siblingState = await (await context.get(`/api/remixes/${siblingId}`)).json();
      expect((await addAutomation({ operation: "upsert", remixTrackId: siblingState.tracks[0].id, parameter: "pan", timelineMs: 0, value: 0 })).status()).toBe(403);
    } finally {
      await context.dispose();
    }
  });

  test("recovers real waveform work after storage faults and a worker restart without duplicate artifacts", async ({
    baseURL,
  }) => {
    test.skip(!testFaultToken, "The fault-injection gate is enabled by npm run test:compose.");
    test.setTimeout(15 * 60 * 1000);
    const context = await playwrightRequest.newContext({ baseURL });
    try {
      const login = await context.post("/api/auth/login", {
        data: { identity: owner.username, password: owner.password },
      });
      expect(login.status()).toBe(200);
      for (const fault of waveformFaults) await armTestFault(context, fault);

      const create = await context.post("/api/projects", {
        data: { title: "Waveform recovery fixture" },
      });
      expect(create.status()).toBe(201);
      const recoveryProjectId = (await create.json()).project.id as string;
      const upload = await context.post("/api/uploads", {
        multipart: {
          projectId: recoveryProjectId,
          model: "htdemucs",
          device: "cpu",
          file: {
            name: "fixture.wav",
            mimeType: "audio/wav",
            buffer: readFileSync(fixture),
          },
        },
      });
      expect(upload.status()).toBe(201);

      await expect
        .poll(
          async () => {
            const response = await context.get(
              `/api/projects/${recoveryProjectId}`,
            );
            if (!response.ok()) return { stems: 0, jobs: [] as string[] };
            const body = await response.json();
            return {
              stems: body.stems.length,
              jobs: body.waveformJobs.map((job: { status: string }) => job.status),
            };
          },
          { timeout: 14 * 60 * 1000, intervals: [2_000, 5_000, 10_000] },
        )
        .toEqual({
          stems: 4,
          jobs: ["complete", "complete", "complete", "complete", "complete"],
        });

      const state = await (
        await context.get(`/api/projects/${recoveryProjectId}`)
      ).json();
      expect(state.sources).toHaveLength(1);
      expect(state.stems).toHaveLength(4);
      expect(state.waveformJobs).toHaveLength(5);
      expect(state.waveforms).toHaveLength(5);
      const stemWaveformJobs = state.waveformJobs.filter(
        (job: { stemAssetId: string | null }) => Boolean(job.stemAssetId),
      );
      expect(stemWaveformJobs).toHaveLength(4);
      expect(
        stemWaveformJobs.every((job: { attempts: number }) => job.attempts >= 2),
      ).toBe(true);
      expect(new Set(state.stems.map((stem: { id: string }) => stem.id)).size).toBe(4);
      expect(
        new Set(
          state.waveforms.map(
            (waveform: { sourceAssetId: string | null; stemAssetId: string | null }) =>
              waveform.sourceAssetId ?? waveform.stemAssetId,
          ),
        ).size,
      ).toBe(5);

      for (const fault of waveformFaults) {
        await expect.poll(() => faultEvents(context, fault)).toContainEqual(
          expect.objectContaining({ event: "injected" }),
        );
      }
      await expect
        .poll(() => faultEvents(context, "waveform-after-write"))
        .toContainEqual(
          expect.objectContaining({
            event: "cleanup",
            cleanupVerified: true,
          }),
        );
    } finally {
      await context.dispose();
    }
  });

  test("renders a persisted remix version through the worker and keeps export retries private and idempotent", async ({
    baseURL,
  }) => {
    test.skip(!testFaultToken, "The export failure path is enabled by npm run test:compose.");
    const context = await playwrightRequest.newContext({ baseURL });
    try {
      const login = await context.post("/api/auth/login", {
        data: { identity: owner.username, password: owner.password },
      });
      expect(login.status()).toBe(200);

      const requested = await context.post(
        `/api/remix-versions/${remixVersionId}/exports`,
        { data: { format: "wav" } },
      );
      expect(requested.status()).toBe(201);
      exportJobId = (await requested.json()).job.id;
      const repeated = await context.post(
        `/api/remix-versions/${remixVersionId}/exports`,
        { data: { format: "wav" } },
      );
      expect(repeated.status()).toBe(200);
      expect((await repeated.json()).job.id).toBe(exportJobId);

      await expect
        .poll(
          async () => {
            const response = await context.get(`/api/exports/${exportJobId}`);
            if (!response.ok()) return { status: "http", asset: false };
            const body = await response.json();
            return { status: body.job.status, asset: Boolean(body.asset) };
          },
          { timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toEqual({ status: "complete", asset: true });
      const completed = await (
        await context.get(`/api/exports/${exportJobId}`)
      ).json();
      expect(completed.asset.remixVersionId).toBe(remixVersionId);
      expect(completed.asset.storageKey).toBeUndefined();
      expect(completed.asset.format).toBe("wav");
      expect(completed.asset.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(completed.asset.fileSizeBytes).toBeGreaterThan(1000);
      const media = await context.get(`/api/exports/${exportJobId}/media`, {
        headers: { Range: "bytes=0-2047" },
      });
      expect(media.status()).toBe(206);
      expect(media.headers()["content-type"]).toContain("audio/wav");

      const failedVersion = await context.post(
        `/api/remixes/${remixId}/versions`,
        { data: { name: "Terminal export failure" } },
      );
      expect(failedVersion.status()).toBe(201);
      const failedVersionId = (await failedVersion.json()).version.id;
      await armTestFault(context, "export-render", 2);
      const failedRequest = await context.post(
        `/api/remix-versions/${failedVersionId}/exports`,
        { data: { format: "wav" } },
      );
      expect(failedRequest.status()).toBe(201);
      const failedExportId = (await failedRequest.json()).job.id;
      await expect
        .poll(
          async () =>
            (await (await context.get(`/api/exports/${failedExportId}`)).json())
              .job.status,
          { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe("failed");
      const failed = await (
        await context.get(`/api/exports/${failedExportId}`)
      ).json();
      expect(failed.asset).toBeNull();
      expect(failed.job.errorCode).toBe("render_failed");

      const retry = await context.post(`/api/exports/${failedExportId}/retry`);
      expect(retry.status()).toBe(200);
      await expect
        .poll(
          async () => {
            const body = await (
              await context.get(`/api/exports/${failedExportId}`)
            ).json();
            return { status: body.job.status, asset: Boolean(body.asset) };
          },
          { timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toEqual({ status: "complete", asset: true });
      retriedExportJobId = failedExportId;
      const retried = await (
        await context.get(`/api/exports/${failedExportId}`)
      ).json();
      expect(retried.job.attempts).toBeGreaterThanOrEqual(3);
      expect(retried.asset.remixVersionId).toBe(failedVersionId);
    } finally {
      await context.dispose();
    }
  });

  test("enforces project and private-media isolation, including collaborator roles", async ({
    page,
    request,
    baseURL,
  }) => {
    const intruder = await playwrightRequest.newContext({ baseURL });
    const intruderRegistration = await intruder.post("/api/auth/register", {
      data: {
        username: `intruder_${stamp}`,
        displayName: "Intruder",
        email: `intruder-${stamp}@example.test`,
        password: "long-test-password-123",
      },
    });
    expect(intruderRegistration.status()).toBe(201);
    expect((await intruder.get(`/api/projects/${projectId}`)).status()).toBe(
      403,
    );
    expect((await intruder.get(`/api/assets/${stemIds[0]}`)).status()).toBe(
      403,
    );
    expect(
      (await intruder.get(`/api/assets/${stemIds[0]}/waveform`)).status(),
    ).toBe(403);
    expect((await intruder.get(`/api/exports/${exportJobId}`)).status()).toBe(403);
    expect(
      (await intruder.get(`/api/exports/${exportJobId}/media`)).status(),
    ).toBe(403);
    expect(
      (await request.get(`${baseURL}/api/assets/${stemIds[0]}`)).status(),
    ).toBe(401);
    expect(
      (
        await request.get(`${baseURL}/api/assets/${stemIds[0]}/waveform`)
      ).status(),
    ).toBe(401);
    expect(
      (
        await intruder.get("/api/assets/00000000-0000-0000-0000-000000000000")
      ).status(),
    ).toBe(404);

    const ownerContext = await playwrightRequest.newContext({ baseURL });
    const ownerLogin = await ownerContext.post("/api/auth/login", {
      data: {
        identity: owner.username,
        password: owner.password,
      },
    });
    expect(ownerLogin.status()).toBe(200);

    const viewer = await playwrightRequest.newContext({ baseURL });
    const viewerName = `viewer_${stamp}`;
    const viewerRegistration = await viewer.post("/api/auth/register", {
      data: {
        username: viewerName,
        displayName: "Viewer",
        email: `viewer-${stamp}@example.test`,
        password: "long-test-password-123",
      },
    });
    expect(viewerRegistration.status()).toBe(201);
    const invite = await ownerContext.post(
      `/api/projects/${projectId}/members`,
      { data: { identity: viewerName, role: "viewer" } },
    );
    expect(invite.status()).toBe(201);
    expect((await viewer.get(`/api/projects/${projectId}`)).status()).toBe(200);
    expect(
      (await viewer.get(`/api/assets/${stemIds[0]}/waveform`)).status(),
    ).toBe(200);
    expect((await viewer.get(`/api/exports/${exportJobId}`)).status()).toBe(200);
    expect(
      (await viewer.get(`/api/exports/${exportJobId}/media`)).status(),
    ).toBe(200);
    expect(
      (
        await viewer.post(`/api/remix-versions/${remixVersionId}/exports`, {
          data: { format: "wav" },
        })
      ).status(),
    ).toBe(403);
    const remixes = await (
      await ownerContext.get(`/api/projects/${projectId}/remixes`)
    ).json();
    const remixId = remixes.remixes[0].id;
    expect((await viewer.get(`/api/remixes/${remixId}`)).status()).toBe(200);
    expect(
      (await viewer.put(`/api/remixes/${remixId}`, { data: {} })).status(),
    ).toBe(403);
    expect(
      (await viewer.post(`/api/remixes/${remixId}/clips/batch-edit`, {
        data: { operation: "delete", clipIds: ["00000000-0000-0000-0000-000000000000"] },
      })).status(),
    ).toBe(403);
    expect(
      (
        await viewer.post(`/api/remixes/${remixId}/versions`, {
          data: { name: "viewer cannot save" },
        })
      ).status(),
    ).toBe(403);
    const deniedUpload = await viewer.post("/api/uploads", {
      multipart: {
        projectId,
        model: "htdemucs",
        device: "cpu",
        file: {
          name: "fixture.wav",
          mimeType: "audio/wav",
          buffer: readFileSync(fixture),
        },
      },
    });
    expect(deniedUpload.status()).toBe(403);
    await intruder.dispose();
    await viewer.dispose();
  });

  test("rejects corrupt audio before persistence and records a terminal real-Demucs failure without stems", async ({
    baseURL,
  }) => {
    const ownerContext = await playwrightRequest.newContext({ baseURL });
    const ownerRegistration = await ownerContext.post("/api/auth/register", {
      data: {
        username: `fail_${stamp}`,
        displayName: "Waveyard Failure Owner",
        email: `failure-owner-${stamp}@example.test`,
        password: "long-test-password-123",
      },
    });
    expect(ownerRegistration.status()).toBe(201);
    const create = await ownerContext.post("/api/projects", {
      data: { title: "Invalid input guard" },
    });
    expect(create.status()).toBe(201);
    const invalidProject = (await create.json()).project.id;
    const corrupt = await ownerContext.post("/api/uploads", {
      multipart: {
        projectId: invalidProject,
        model: "htdemucs",
        device: "cpu",
        file: {
          name: "not-a-track.mp3",
          mimeType: "audio/mpeg",
          buffer: Buffer.from("this is not audio"),
        },
      },
    });
    expect(corrupt.status()).toBe(422);
    const invalidProjectState = await (
      await ownerContext.get(`/api/projects/${invalidProject}`)
    ).json();
    expect(invalidProjectState.sources).toHaveLength(0);
    expect(invalidProjectState.jobs).toHaveLength(0);

    const failureProjectResponse = await ownerContext.post("/api/projects", {
      data: { title: "Real Demucs model failure" },
    });
    expect(failureProjectResponse.status()).toBe(201);
    const failureProject = (await failureProjectResponse.json()).project.id;
    const failedUpload = await ownerContext.post("/api/uploads", {
      multipart: {
        projectId: failureProject,
        model: "definitely-not-a-demucs-model",
        device: "cpu",
        file: {
          name: "fixture.wav",
          mimeType: "audio/wav",
          buffer: readFileSync(fixture),
        },
      },
    });
    expect(failedUpload.status()).toBe(201);
    const failedJobId = (await failedUpload.json()).job.id;
    await expect
      .poll(
        async () =>
          (await (await ownerContext.get(`/api/jobs/${failedJobId}`)).json())
            .job.status,
        { timeout: 120_000, intervals: [2_000, 5_000] },
      )
      .toBe("failed");
    const failureState = await (
      await ownerContext.get(`/api/projects/${failureProject}`)
    ).json();
    expect(failureState.stems).toHaveLength(0);
    expect(failureState.jobs.at(-1).errorMessage).toBeTruthy();
  });


  test("publishes an explicit final export without exposing private media or project internals", async ({
    baseURL,
    request,
  }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL });
    const ownerContext = await playwrightRequest.newContext({ baseURL });
    try {
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(404);
      const privateCatalogue = await (await anonymous.get(`/api/public/projects?q=deterministic`)).json();
      expect(privateCatalogue.projects.some((project: { id: string }) => project.id === projectId)).toBe(false);
      const ownerLogin = await ownerContext.post("/api/auth/login", {
        data: { identity: owner.username, password: owner.password },
      });
      expect(ownerLogin.status()).toBe(200);
      const exportState = await (
        await ownerContext.get(`/api/exports/${exportJobId}`)
      ).json();
      const selectedAssetId = exportState.asset.id as string;
      // Keep this distinct from the earlier collaborator while remaining under
      // the production username limit of 32 characters.
      const viewerName = `pub_${stamp}`;
      const viewer = await playwrightRequest.newContext({ baseURL });
      try {
        expect((await viewer.post("/api/auth/register", { data: {
          username: viewerName,
          displayName: "Publication Viewer",
          email: `publication-viewer-${stamp}@example.test`,
          password: "long-test-password-123",
        } })).status()).toBe(201);
        expect((await ownerContext.post(`/api/projects/${projectId}/members`, {
          data: { identity: viewerName, role: "viewer" },
        })).status()).toBe(201);
        expect((await viewer.put(`/api/projects/${projectId}/publication`, {
          data: { visibility: "public", publishedExportAssetId: selectedAssetId, rightsAcknowledged: true },
        })).status()).toBe(403);
      } finally { await viewer.dispose(); }

      const missingAcknowledgement = await ownerContext.put(
        `/api/projects/${projectId}/publication`,
        { data: { visibility: "public", publishedExportAssetId: selectedAssetId } },
      );
      expect(missingAcknowledgement.status()).toBe(422);
      expect((await missingAcknowledgement.json()).code).toBe("rights_acknowledgement_required");
      const published = await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: {
          visibility: "public",
          publishedExportAssetId: selectedAssetId,
          rightsAcknowledged: true,
          downloadPermission: "public",
        },
      });
      expect(published.status()).toBe(200);
      expect((await published.json()).publication.visibility).toBe("public");

      const publicDetail = await anonymous.get(`/api/public/projects/${projectId}`);
      expect(publicDetail.status()).toBe(200);
      const publicBody = await publicDetail.json();
      expect(publicBody.project.title).toBe("Original deterministic fixture");
      expect(publicBody.release.storageKey).toBeUndefined();
      expect(publicBody.release.id).toBeUndefined();
      expect(JSON.stringify(publicBody)).not.toContain("storageKey");
      expect(JSON.stringify(publicBody)).not.toContain("remixVersionId");
      expect(JSON.stringify(publicBody)).not.toContain("exportJobId");
      expect(JSON.stringify(publicBody)).not.toContain("members");
      expect(JSON.stringify(publicBody)).not.toContain("stems");
      const publicRelease = await anonymous.get(`/api/public/projects/${projectId}/release`, {
        headers: { Range: "bytes=0-2047" },
        maxRedirects: 0,
      });
      expect(publicRelease.status()).toBe(206);
      expect(publicRelease.headers()["content-type"]).toContain("audio/wav");
      expect(publicRelease.headers()["location"]).toBeUndefined();
      const publicDownload = await anonymous.get(`/api/public/projects/${projectId}/release?download=1`);
      expect(publicDownload.status()).toBe(200);
      expect(publicDownload.headers()["content-disposition"]).toContain("attachment");
      expect((await anonymous.get(`/api/assets/${stemIds[0]}`)).status()).toBe(401);
      expect((await anonymous.get(`/api/exports/${exportJobId}`)).status()).toBe(401);
      expect((await anonymous.get(`/api/exports/${retriedExportJobId}`)).status()).toBe(401);

      const catalogue = await anonymous.get(`/api/public/projects?q=deterministic`);
      expect(catalogue.status()).toBe(200);
      expect((await catalogue.json()).projects.some((project: { id: string }) => project.id === projectId)).toBe(true);
      const audit = await ownerContext.get(`/api/projects/${projectId}/publication/audit`);
      expect(audit.status()).toBe(200);
      const auditEvents = (await audit.json()).events as Array<{ eventType: string; actorId: string; metadata: { before: unknown; after: { visibility: string } } }>;
      expect(auditEvents.some((event) => event.eventType === "rights_acknowledged" && Boolean(event.actorId))).toBe(true);
      expect(auditEvents.some((event) => event.eventType === "published" && event.metadata.after.visibility === "public")).toBe(true);

      const unlisted = await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: { visibility: "unlisted", publishedExportAssetId: selectedAssetId, rightsAcknowledged: true },
      });
      expect(unlisted.status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(200);
      const hiddenFromCatalogue = await (await anonymous.get(`/api/public/projects?q=deterministic`)).json();
      expect(hiddenFromCatalogue.projects.some((project: { id: string }) => project.id === projectId)).toBe(false);

      expect((await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: { visibility: "public", publishedExportAssetId: selectedAssetId, rightsAcknowledged: true },
      })).status()).toBe(200);
      expect((await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: { visibility: "private" },
      })).status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(404);
      expect((await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: { visibility: "public", publishedExportAssetId: selectedAssetId, rightsAcknowledged: true, downloadPermission: "public" },
      })).status()).toBe(200);
    } finally {
      await anonymous.dispose();
      await ownerContext.dispose();
    }
  });

  test("records reports and moderator hide, restore, and remove decisions without deleting owner data", async ({ baseURL }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL });
    const ownerContext = await playwrightRequest.newContext({ baseURL });
    const reporter = await playwrightRequest.newContext({ baseURL });
    const moderator = await playwrightRequest.newContext({ baseURL });
    try {
      expect((await ownerContext.post("/api/auth/login", { data: { identity: owner.username, password: owner.password } })).status()).toBe(200);
      expect((await reporter.post("/api/auth/register", { data: {
        username: `reporter_${stamp}`,
        displayName: "Reporter",
        email: `reporter-${stamp}@example.test`,
        password: "long-test-password-123",
      } })).status()).toBe(201);
      expect((await moderator.post("/api/auth/register", { data: {
        username: "moderator",
        displayName: "Waveyard Moderator",
        email: "moderator@waveyard.test",
        password: "long-test-password-123",
      } })).status()).toBe(201);
      const report = await reporter.post(`/api/public/projects/${projectId}/reports`, { data: { reason: "This needs a moderation review." } });
      expect(report.status()).toBe(201);
      expect((await reporter.post(`/api/public/projects/${projectId}/reports`, { data: { reason: "This needs a moderation review." } })).status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(200);
      expect((await reporter.post(`/api/moderation/projects/${projectId}/actions`, { data: { action: "hide", reason: "Not authorized." } })).status()).toBe(403);
      const queue = await moderator.get("/api/moderation/projects?status=reported");
      expect(queue.status()).toBe(200);
      expect((await queue.json()).projects.some((project: { id: string }) => project.id === projectId)).toBe(true);
      expect((await moderator.post(`/api/moderation/projects/${projectId}/actions`, { data: { action: "hide", reason: "Temporarily hidden for review." } })).status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(404);
      expect((await anonymous.get(`/api/public/projects/${projectId}/release`)).status()).toBe(404);
      expect((await ownerContext.get(`/api/projects/${projectId}`)).status()).toBe(200);
      expect((await moderator.post(`/api/moderation/projects/${projectId}/actions`, { data: { action: "restore", reason: "Review completed." } })).status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(200);
      expect((await moderator.post(`/api/moderation/projects/${projectId}/actions`, { data: { action: "remove", reason: "Final moderation removal." } })).status()).toBe(200);
      expect((await anonymous.get(`/api/public/projects/${projectId}`)).status()).toBe(404);
      expect((await ownerContext.get(`/api/projects/${projectId}`)).status()).toBe(200);
      const completedExport = await (
        await ownerContext.get(`/api/exports/${exportJobId}`)
      ).json();
      expect((await ownerContext.put(`/api/projects/${projectId}/publication`, {
        data: {
          visibility: "public",
          rightsAcknowledged: true,
          publishedExportAssetId: completedExport.asset.id,
        },
      })).status()).toBe(409);
      const audit = await (await ownerContext.get(`/api/projects/${projectId}/publication/audit`)).json();
      const events = audit.events as Array<{ eventType: string; reason: string | null }>;
      expect(events.some((event) => event.eventType === "report_submitted" && event.reason)).toBe(true);
      expect(events.some((event) => event.eventType === "hidden" && event.reason === "Temporarily hidden for review.")).toBe(true);
      expect(events.some((event) => event.eventType === "restored" && event.reason === "Review completed.")).toBe(true);
      expect(events.some((event) => event.eventType === "removed" && event.reason === "Final moderation removal.")).toBe(true);
    } finally {
      await anonymous.dispose(); await ownerContext.dispose(); await reporter.dispose(); await moderator.dispose();
    }
  });
});
