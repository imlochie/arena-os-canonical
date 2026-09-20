import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, request as playwrightRequest, test } from "@playwright/test";

const fixture = resolve(process.cwd(), "tests/fixtures/copyright-safe-fixture.wav");
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner = { username: `owner_${stamp}`, displayName: "Waveyard E2E Owner", email: `owner-${stamp}@example.test`, password: "long-test-password-123" };
let projectId = "";
let stemIds: string[] = [];


test.describe.configure({ mode: "serial" });
test.describe("real Compose separation pipeline", () => {
  test("registers, uploads an original fixture, separates it, validates stored stems, and plays them", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[name="username"]').fill(owner.username);
    await page.locator('input[name="displayName"]').fill(owner.displayName);
    await page.locator('input[name="email"]').fill(owner.email);
    await page.locator('input[name="password"]').fill(owner.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/create");

    await page.locator('input[name="title"]').fill("Original deterministic fixture");
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await page.getByRole("button", { name: "Separate this track" }).click();
    await page.waitForURL(/\/projects\/[\w-]+/);
    projectId = page.url().split("/").at(-1) ?? "";
    expect(projectId).not.toBe("");

    await expect.poll(async () => {
      const response = await page.request.get(`/api/projects/${projectId}`);
      if (!response.ok()) return { status: "http", count: 0 };
      const body = await response.json();
      return { status: body.jobs.at(-1)?.status, count: body.stems.length };
    }, { timeout: 11 * 60 * 1000, intervals: [2_000, 5_000, 10_000] }).toEqual({ status: "complete", count: 4 });

    const project = await (await page.request.get(`/api/projects/${projectId}`)).json();
    const expectedStemTypes = ["bass", "drums", "other", "vocals"];
    expect(project.stems.map((stem: { stemType: string }) => stem.stemType).sort()).toEqual(expectedStemTypes);
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
    expect(project.sources[0].checksumSha256).toBe(createHash("sha256").update(readFileSync(fixture)).digest("hex"));

    for (const type of expectedStemTypes) await expect(page.getByTestId(`stem-${type}`)).toBeVisible();
    await page.getByTestId("play-all").click();
    await expect.poll(async () => page.locator("audio").evaluateAll((audio) => audio.every((element) => !(element as HTMLAudioElement).paused))).toBe(true);
    const partial = await page.request.get(`/api/assets/${stemIds[0]}`, { headers: { Range: "bytes=0-2047" } });
    expect(partial.status()).toBe(206);
    expect(partial.headers()["content-type"]).toContain("audio/wav");
  });

  test("enforces project and private-media isolation, including collaborator roles", async ({ page, request, baseURL }) => {
    const intruder = await playwrightRequest.newContext({ baseURL });
    const intruderRegistration = await intruder.post("/api/auth/register", { data: { username: `intruder_${stamp}`, displayName: "Intruder", email: `intruder-${stamp}@example.test`, password: "long-test-password-123" } });
    expect(intruderRegistration.status()).toBe(201);
    expect((await intruder.get(`/api/projects/${projectId}`)).status()).toBe(403);
    expect((await intruder.get(`/api/assets/${stemIds[0]}`)).status()).toBe(403);
    expect((await request.get(`${baseURL}/api/assets/${stemIds[0]}`)).status()).toBe(401);
    expect((await page.request.get("/api/assets/00000000-0000-0000-0000-000000000000")).status()).toBe(404);

    const viewer = await playwrightRequest.newContext({ baseURL });
    const viewerName = `viewer_${stamp}`;
    const viewerRegistration = await viewer.post("/api/auth/register", { data: { username: viewerName, displayName: "Viewer", email: `viewer-${stamp}@example.test`, password: "long-test-password-123" } });
    expect(viewerRegistration.status()).toBe(201);
    const invite = await page.request.post(`/api/projects/${projectId}/members`, { data: { identity: viewerName, role: "viewer" } });
    expect(invite.status()).toBe(201);
    expect((await viewer.get(`/api/projects/${projectId}`)).status()).toBe(200);
    const deniedUpload = await viewer.post("/api/uploads", { multipart: { projectId, model: "htdemucs", device: "cpu", file: { name: "fixture.wav", mimeType: "audio/wav", buffer: readFileSync(fixture) } } });
    expect(deniedUpload.status()).toBe(403);
    await intruder.dispose(); await viewer.dispose();
  });

  test("rejects corrupt audio before persistence and records a terminal real-Demucs failure without stems", async ({ page }) => {
    const create = await page.request.post("/api/projects", { data: { title: "Invalid input guard" } });
    expect(create.status()).toBe(201); const invalidProject = (await create.json()).project.id;
    const corrupt = await page.request.post("/api/uploads", { multipart: { projectId: invalidProject, model: "htdemucs", device: "cpu", file: { name: "not-a-track.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("this is not audio") } } });
    expect(corrupt.status()).toBe(422);
    const invalidProjectState = await (await page.request.get(`/api/projects/${invalidProject}`)).json();
    expect(invalidProjectState.sources).toHaveLength(0);
    expect(invalidProjectState.jobs).toHaveLength(0);

    const failureProjectResponse = await page.request.post("/api/projects", { data: { title: "Real Demucs model failure" } });
    expect(failureProjectResponse.status()).toBe(201); const failureProject = (await failureProjectResponse.json()).project.id;
    const failedUpload = await page.request.post("/api/uploads", { multipart: { projectId: failureProject, model: "definitely-not-a-demucs-model", device: "cpu", file: { name: "fixture.wav", mimeType: "audio/wav", buffer: readFileSync(fixture) } } });
    expect(failedUpload.status()).toBe(201); const failedJobId = (await failedUpload.json()).job.id;
    await expect.poll(async () => (await (await page.request.get(`/api/jobs/${failedJobId}`)).json()).job.status, { timeout: 120_000, intervals: [2_000, 5_000] }).toBe("failed");
    const failureState = await (await page.request.get(`/api/projects/${failureProject}`)).json();
    expect(failureState.stems).toHaveLength(0);
    expect(failureState.jobs.at(-1).errorMessage).toBeTruthy();
  });
});
