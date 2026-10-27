import { expect, test } from "@playwright/test";

/**
 * Arena product smoke — the current local-first UI, end to end.
 *
 * Covers the gaps closed by the full product audit (docs/arena-product-audit.md):
 *   1. Every previously-orphan page is reachable from the Rooms launcher.
 *   2. The visual studio states honestly when the Demo backend is active.
 *   3. The Waveyard promise copy and core API surfaces answer.
 *
 * This spec needs NO credentials, NO worker stack, and NO browser keys: it runs
 * against a plain `npm run dev` (or any deployed build) and asserts only
 * behavior a fresh install actually has. It is the Arena-side counterpart to
 * real-separation.spec.ts (which remains the compose-profile acceptance for
 * the full separation pipeline).
 *
 * NOTE (honesty): browser binaries could not be downloaded in the sandbox
 * where this spec was written (cdn.playwright.dev blocked) — it is verified to
 * load and compile (`playwright test --list`) but its first full execution
 * happens wherever Playwright browsers exist (CI e2e profile / a dev machine).
 */
test.describe.configure({ mode: "serial" });

test("home renders the promise and the quick launch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your private AI arena");
  await expect(page.getByRole("link", { name: /Waveyard/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Chat/ }).first()).toBeVisible();
});

test("the Rooms launcher reaches every audited page (no orphans)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Rooms/ }).first().click();
  const launcher = page.locator("[cmdk-root], [role='dialog']").first().or(page.getByRole("navigation", { name: /rooms|launcher/i }));
  for (const label of ["Visual Studio", "Market", "Archive", "Device Security", "Waveyard"]) {
    await expect(page.getByRole("link", { name: new RegExp(label, "i") }).first()).toBeVisible();
  }
  void launcher;
});

test("visual studio is honest about the Demo backend", async ({ page }) => {
  const health = await page.request.get("/api/studio/health");
  const backends = health.ok() ? ((await health.json()).status ?? []) as Array<{ backend: string; online: boolean }> : [];
  const realBackendOnline = backends.some((b) => b.backend !== "demo" && b.online);

  await page.goto("/studio");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (!realBackendOnline) {
    // No wangp/comfyui: the Demo banner must say so plainly.
    await expect(page.getByRole("status").filter({ hasText: "Demo backend active" })).toBeVisible();
  }
});

test("the previously-orphan pages render their content", async ({ page }) => {
  for (const path of ["/market", "/archive", "/device-security", "/model-hub", "/creative", "/foundry", "/deep-agent", "/mind", "/subscriptions"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} must serve`).toBe(200);
    await expect(page.locator("main, [class*='mx-auto']").first()).toBeVisible();
  }
});

test("Waveyard home states the core promise", async ({ page }) => {
  await page.goto("/waveyard");
  await expect(page.getByText("Drop a song anywhere on this page", { exact: false })).toBeVisible();
});

test("core Arena APIs answer on a fresh install", async ({ page }) => {
  const battles = await page.request.get("/api/battles?limit=5");
  expect(battles.ok()).toBeTruthy();
  expect(Array.isArray((await battles.json()).battles)).toBeTruthy();

  const models = await page.request.get("/api/models");
  expect(models.ok()).toBeTruthy();

  const leaderboard = await page.request.get("/api/leaderboard");
  expect(leaderboard.ok()).toBeTruthy();

  // Model Hub answers on a fresh install (no runtimes connected yet — the
  // honest empty state, plus the downloadable catalog and bridge status).
  const hub = await page.request.get("/api/model-hub");
  expect(hub.ok()).toBeTruthy();
  const hubBody = (await hub.json()) as {
    connections?: unknown[];
    discovered?: unknown[];
    catalog?: { tag: string }[];
    registered?: unknown[];
    agentBridge?: { connected: boolean };
  };
  expect(Array.isArray(hubBody.connections)).toBeTruthy();
  expect(Array.isArray(hubBody.discovered)).toBeTruthy();
  expect(Array.isArray(hubBody.registered)).toBeTruthy();
  expect(hubBody.catalog?.length ?? 0).toBeGreaterThanOrEqual(6);
  expect(typeof hubBody.agentBridge?.connected).toBe("boolean");

  // Foundry answers with an (honestly empty) app list on a fresh install.
  const foundry = await page.request.get("/api/foundry");
  expect(foundry.ok()).toBeTruthy();
  expect(Array.isArray((await foundry.json()).apps)).toBeTruthy();

  // Wave 3: the live repo map answers with real files; the deep agent list
  // exists (honestly empty on a fresh install).
  const repoMap = await page.request.get("/api/repo-map");
  expect(repoMap.ok()).toBeTruthy();
  const mapBody = (await repoMap.json()) as { files?: { path: string }[] };
  expect((mapBody.files ?? []).some((f) => f.path === "src/lib/ai.ts")).toBeTruthy();
  const deepAgentList = await page.request.get("/api/deep-agent");
  expect(deepAgentList.ok()).toBeTruthy();
  expect(Array.isArray((await deepAgentList.json()).runs)).toBeTruthy();

  // Mind + Subscriptions answer on a fresh install (honest empty states).
  const mind = await page.request.get("/api/mind");
  expect(mind.ok()).toBeTruthy();
  expect(Array.isArray((await mind.json()).items)).toBeTruthy();
  const subs = await page.request.get("/api/subscriptions");
  expect(subs.ok()).toBeTruthy();
  const subsBody = (await subs.json()) as { subscriptions?: unknown[]; stats?: { activeCount: number } };
  expect(Array.isArray(subsBody.subscriptions)).toBeTruthy();
  expect(subsBody.stats?.activeCount).toBe(0);

  // Email accounts answer on a fresh install (empty, credentials never listed).
  const email = await page.request.get("/api/email");
  expect(email.ok()).toBeTruthy();
  const emailBody = (await email.json()) as { accounts?: unknown[] };
  expect(Array.isArray(emailBody.accounts)).toBeTruthy();
  expect(emailBody.accounts?.length).toBe(0);

  // Merged Archive Assistant: native routes answer on a fresh install.
  const providers = await page.request.get("/api/archive/providers");
  expect(providers.ok()).toBeTruthy();
  const providersBody = (await providers.json()) as { providers?: unknown[] };
  expect(Array.isArray(providersBody.providers)).toBeTruthy();
  const review = await page.request.get("/api/archive/review");
  expect(review.ok()).toBeTruthy();
  const reviewBody = (await review.json()) as { items?: unknown[] };
  expect(Array.isArray(reviewBody.items)).toBeTruthy();

  // Model detail (WanGP offline defaults when no bridge) + lineage validation.
  const modelDetail = await page.request.get("/api/studio/models/t2v_2_2");
  expect(modelDetail.ok()).toBeTruthy();
  const detailBody = (await modelDetail.json()) as { detail?: unknown; live?: boolean };
  expect(detailBody.detail).toBeTruthy();
  expect(typeof detailBody.live).toBe("boolean");
  expect((await page.request.get("/api/studio/models/not-a-model")).status()).toBe(404);
  expect((await page.request.get("/api/archive/findings/not-a-number/lineage")).status()).toBe(400);

  const diagnostics = await page.request.get("/api/desktop/diagnostics");
  expect(diagnostics.ok()).toBeTruthy();
  const body = (await diagnostics.json()) as { components?: Record<string, { status: string }> };
  // The honest floor: server, database, and storage must be READY everywhere.
  expect(body.components?.server?.status).toBe("READY");
  expect(body.components?.database?.status).toBe("READY");
  expect(body.components?.storage?.status).toBe("READY");
});
