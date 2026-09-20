import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request as playwrightRequest, test } from "@playwright/test";

const fixture = resolve(process.cwd(), "tests/fixtures/copyright-safe-fixture.wav");
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner = { username: `owner_${stamp}`, displayName: "Arena E2E Owner", email: `owner-${stamp}@example.test`, password: "long-test-password-123" };
let projectId = "";
let stemIds: string[] = [];

test.describe.configure({ mode: "serial" });
test.describe("real Arena Stem Lab Compose pipeline", () => {
  test("registers, creates a project, separates an original WAV, stores four stems, and plays private audio", async ({ page }) => {
    await expect.poll(async () => {
      const response = await page.request.get("/api/stems/health");
      return (await response.json()).available;
    }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(true);

    await page.goto("/stems");
    await page.locator('input[name="username"]').fill(owner.username);
    await page.locator('input[name="displayName"]').fill(owner.displayName);
    await page.locator('input[name="email"]').fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.getByRole("button", { name: "Create private account" }).click();
    await expect(page.getByText(`Signed in as ${owner.displayName}`)).toBeVisible();

    await page.getByPlaceholder("New private project name").fill("Original deterministic fixture");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator("select")).toHaveValue(/.+/);
    projectId = await page.locator("select").inputValue();

    await page.locator('input[type="file"]').setInputFiles(fixture);
    await page.getByRole("button", { name: "Queue real Demucs separation" }).click();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/stems/projects/${projectId}`);
      if (!response.ok()) return { status: "http", count: 0 };
      const body = await response.json();
      return { status: body.jobs[0]?.status, count: body.stems.length };
    }, { timeout: 11 * 60 * 1000, intervals: [2_000, 5_000, 10_000] }).toEqual({ status: "complete", count: 4 });

    const state = await (await page.request.get(`/api/stems/projects/${projectId}`)).json();
    expect(state.stems.map((stem: { stemType: string }) => stem.stemType).sort()).toEqual(["bass", "drums", "other", "vocals"]);
    for (const stem of state.stems) {
      expect(stem.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(stem.durationSeconds).toBeGreaterThanOrEqual(18);
      expect(stem.durationSeconds).toBeLessThanOrEqual(22);
      expect(stem.sampleRate).toBe(44_100);
      expect(stem.channels).toBe(2);
      expect(stem.fileSizeBytes).toBeGreaterThan(1_000);
    }
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].checksumSha256).toBe(createHash("sha256").update(readFileSync(fixture)).digest("hex"));
    stemIds = state.stems.map((stem: { id: string }) => stem.id);

    await page.goto(`/stems?projectId=${projectId}`);
    await expect(page.getByTestId("stem-vocals")).toBeVisible();
    const playback = await page.locator("audio").first().evaluate(async (element) => {
      const audio = element as HTMLAudioElement;
      await audio.play();
      return !audio.paused;
    });
    expect(playback).toBe(true);
    const partial = await page.request.get(`/api/stems/assets/${stemIds[0]}`, { headers: { Range: "bytes=0-2047" } });
    expect(partial.status()).toBe(206);
    expect(partial.headers()["content-type"]).toContain("audio/wav");
  });

  test("enforces private project/media isolation and collaborator roles", async ({ page, baseURL }) => {
    const intruder = await playwrightRequest.newContext({ baseURL });
    expect((await intruder.post("/api/stems/auth/register", { data: { username: `intruder_${stamp}`, displayName: "Intruder", email: `intruder-${stamp}@example.test`, password: "long-test-password-123" } })).status()).toBe(201);
    expect((await intruder.get(`/api/stems/projects/${projectId}`)).status()).toBe(403);
    expect((await intruder.get(`/api/stems/assets/${stemIds[0]}`)).status()).toBe(403);
    const anonymous = await playwrightRequest.newContext({ baseURL });
    expect((await anonymous.get(`/api/stems/assets/${stemIds[0]}`)).status()).toBe(401);
    expect((await page.request.get("/api/stems/assets/00000000-0000-0000-0000-000000000000")).status()).toBe(404);

    const viewer = await playwrightRequest.newContext({ baseURL });
    const viewerName = `viewer_${stamp}`;
    expect((await viewer.post("/api/stems/auth/register", { data: { username: viewerName, displayName: "Viewer", email: `viewer-${stamp}@example.test`, password: "long-test-password-123" } })).status()).toBe(201);
    expect((await page.request.post(`/api/stems/projects/${projectId}/members`, { data: { identity: viewerName, role: "viewer" } })).status()).toBe(201);
    expect((await viewer.get(`/api/stems/projects/${projectId}`)).status()).toBe(200);
    const deniedUpload = await viewer.post("/api/stems", { multipart: { projectId, model: "htdemucs", device: "cpu", file: { name: "fixture.wav", mimeType: "audio/wav", buffer: readFileSync(fixture) } } });
    expect(deniedUpload.status()).toBe(403);
    await intruder.dispose(); await anonymous.dispose(); await viewer.dispose();
  });

  test("rejects corrupt audio before persistence and records a terminal Demucs failure with no stems", async ({ page }) => {
    const corruptProjectResponse = await page.request.post("/api/stems/projects", { data: { name: "Invalid input guard" } });
    expect(corruptProjectResponse.status()).toBe(201);
    const corruptProject = (await corruptProjectResponse.json()).project.id;
    const corrupt = await page.request.post("/api/stems", { multipart: { projectId: corruptProject, file: { name: "not-a-track.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("this is not audio") } } });
    expect(corrupt.status()).toBe(422);
    const corruptState = await (await page.request.get(`/api/stems/projects/${corruptProject}`)).json();
    expect(corruptState.sources).toHaveLength(0); expect(corruptState.jobs).toHaveLength(0);

    const failureProjectResponse = await page.request.post("/api/stems/projects", { data: { name: "Real Demucs model failure" } });
    expect(failureProjectResponse.status()).toBe(201);
    const failureProject = (await failureProjectResponse.json()).project.id;
    const failedUpload = await page.request.post("/api/stems", { multipart: { projectId: failureProject, model: "definitely-not-a-demucs-model", device: "cpu", file: { name: "fixture.wav", mimeType: "audio/wav", buffer: readFileSync(fixture) } } });
    expect(failedUpload.status()).toBe(201);
    const failedJobId = (await failedUpload.json()).job.id;
    await expect.poll(async () => (await (await page.request.get(`/api/stems/jobs/${failedJobId}`)).json()).job.status, { timeout: 120_000, intervals: [2_000, 5_000] }).toBe("failed");
    const failureState = await (await page.request.get(`/api/stems/projects/${failureProject}`)).json();
    expect(failureState.stems).toHaveLength(0);
    expect(failureState.jobs[0].errorMessage).toBeTruthy();
    const attemptedBeforeRetry = failureState.jobs[0].attempts;
    expect((await page.request.post(`/api/stems/jobs/${failedJobId}/retry`)).status()).toBe(200);
    await expect.poll(async () => (await (await page.request.get(`/api/stems/jobs/${failedJobId}`)).json()).job, { timeout: 120_000, intervals: [2_000, 5_000] })
      .toMatchObject({ status: "failed", attempts: expect.any(Number) });
    const retried = await (await page.request.get(`/api/stems/jobs/${failedJobId}`)).json();
    expect(retried.job.attempts).toBeGreaterThan(attemptedBeforeRetry);
    const stateAfterRetry = await (await page.request.get(`/api/stems/projects/${failureProject}`)).json();
    expect(stateAfterRetry.stems).toHaveLength(0);
  });
});
