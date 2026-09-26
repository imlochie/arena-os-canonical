import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
type TestFault = WaveformFault | "export-render";

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
      })),
    })),
  };
}

test.describe.configure({ mode: "serial" });
test.describe("real Compose separation pipeline", () => {
  test("registers, uploads an original fixture, separates it, validates stored stems, and plays them", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('input[name="username"]').fill(owner.username);
    await page.locator('input[name="displayName"]').fill(owner.displayName);
    await page.locator('input[name="email"]').fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/create");

    await page
      .locator('input[name="title"]')
      .fill("Original deterministic fixture");
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await page.getByRole("button", { name: "Separate this track" }).click();
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
    await expect(page.locator('[data-testid^="source-stems-"]').first()).toBeVisible();
    await page
      .getByLabel("Add source audio")
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
    await page
      .getByRole("button", { name: /song-b\.wav — Vocals/ })
      .click();
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
        track.clips = [{ stemAssetId, timelineStartMs: 0, durationMs: 8_000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 }];
      }
      // The first track has two overlapping clips. Equal one-second boundary
      // fades make this the supported deterministic crossfade form.
      payload.tracks[0].clips = [
        { stemAssetId: String(payload.tracks[0].stemAssetId), timelineStartMs: 0, durationMs: 7_000, sourceOffsetMs: 0, gain: 0.8, fadeInMs: 0, fadeOutMs: 1_000 },
        { stemAssetId: String(payload.tracks[0].stemAssetId), timelineStartMs: 6_000, durationMs: 6_000, sourceOffsetMs: 6_000, gain: 1, fadeInMs: 1_000, fadeOutMs: 0 },
      ];
      const saved = await context.put(`/api/remixes/${remixId}`, { data: payload });
      expect(saved.status()).toBe(200);
      const arranged = await saved.json();
      expect(arranged.remix).toMatchObject({ tempoBpm: 96, timeSignatureNumerator: 3, timeSignatureDenominator: 4, gridDivision: "half-beat", snapEnabled: true, loopStartMs: 1_000, loopEndMs: 9_000 });
      expect(arranged.tracks[0].clips).toMatchObject([{ fadeOutMs: 1_000 }, { timelineStartMs: 6_000, fadeInMs: 1_000 }]);

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
