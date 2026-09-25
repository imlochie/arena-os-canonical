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
const testFaultToken = process.env.WAVEYARD_TEST_FAULT_TOKEN;
const waveformFaults = [
  "waveform-storage-read",
  "waveform-storage-write",
  "waveform-after-write",
  "waveform-worker-restart",
] as const;
type WaveformFault = (typeof waveformFaults)[number];

async function armWaveformFault(
  context: APIRequestContext,
  fault: WaveformFault,
) {
  const response = await context.post("/api/test/faults", {
    headers: { "x-waveyard-test-fault-token": testFaultToken! },
    data: { fault },
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
    await page.getByLabel("Vocals clip 1 start").fill("2");
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const remixes = await (
      await page.request.get(`/api/projects/${projectId}/remixes`)
    ).json();
    expect(remixes.remixes).toHaveLength(1);
    const remixId = remixes.remixes[0].id;
    const savedRemix = await (
      await page.request.get(`/api/remixes/${remixId}`)
    ).json();
    expect(
      savedRemix.tracks.find(
        (track: { name: string }) => track.name === "Vocals",
      ).clips[0].timelineStartMs,
    ).toBe(2000);
    const version = await page.request.post(
      `/api/remixes/${remixId}/versions`,
      { data: { name: "Initial arrangement" } },
    );
    expect(version.status()).toBe(201);
    const versionId = (await version.json()).version.id;
    const restore = await page.request.post(
      `/api/remixes/${remixId}/versions/${versionId}/restore`,
    );
    expect(restore.status()).toBe(200);
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
      for (const fault of waveformFaults) await armWaveformFault(context, fault);

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
});
