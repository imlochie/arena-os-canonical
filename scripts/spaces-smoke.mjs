import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const base = "http://localhost:80";
await mkdir("generated-artifacts/spaces-smoke", { recursive: true });
const browser = await chromium.launch({
  headless: true, executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
let spaceId;
try {
  await page.goto(`${base}/spaces`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Browser tasks in private workspaces" }).waitFor();
  const creation = page.waitForResponse(response => response.url().endsWith("/api/spaces") && response.request().method() === "POST");
  await page.getByRole("button", { name: "New browser workspace", exact: true }).click();
  const created = await (await creation).json();
  spaceId = created.space.id;
  assert.equal(created.space.status, "paused", "A browser workspace must not secretly schedule recurring AI runs");
  const persisted = await (await context.request.get(`${base}/api/spaces/${spaceId}`)).json();
  assert.equal(persisted.space.status, "paused", "Schedule-off state must survive a database reload");

  const card = page.locator(`[data-space-id="${spaceId}"]`);
  await card.getByRole("textbox", { name: "Page URL" }).fill("https://example.com");
  await card.getByRole("button", { name: "Open page", exact: true }).click();
  const capture = card.getByRole("img", { name: "Last browser capture: Example Domain", exact: true });
  await capture.waitFor({ timeout: 45000 });
  await capture.evaluate(image => image.decode());
  await card.getByText("Read captured page text").click();
  await card.getByText("This domain is for use in documentation examples", { exact: false }).first().waitFor();

  await card.getByRole("textbox", { name: "Browser task", exact: true }).fill("Read this page and save a report.");
  const runTask = card.getByTestId("button-run-mission");
  assert.equal(await runTask.isDisabled(), true, "Automated tasks must not offer a dead-end run action without a model");
  await card.getByTestId("status-mission-model-required").getByRole("link", { name: "Open Model Hub to connect a model" }).waitFor();
  await card.getByText("Manual page browsing remains available without one.", { exact: false }).waitFor();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("img", { name: "Last browser capture: Example Domain", exact: true }).waitFor();
  const afterReload = await (await context.request.get(`${base}/api/spaces/${spaceId}`)).json();
  assert.equal(afterReload.space.status, "paused");
  assert.equal(afterReload.space.runCount, 0);
  const privateTarget = await context.request.post(`${base}/api/spaces/${spaceId}/browser`, { data: { url: "http://127.0.0.1:8080/api/health" } });
  assert.equal(privateTarget.status(), 400);
  const traversal = await context.request.get(`${base}/api/spaces/${spaceId}/browser?file=../browser-profile/Cookies`);
  assert.equal(traversal.status(), 400);
  assert.equal(errors.length, 0, errors.join("; "));
  await page.screenshot({ path: "generated-artifacts/spaces-smoke/workspace.jpg", fullPage: true });
  console.log("PASS: create paused browser workspace, real page capture/text, persisted observation, disabled task launch with model setup path, private-network refusal, and report-path protection.");
} finally {
  if (spaceId) await context.request.delete(`${base}/api/spaces/${spaceId}`);
  await browser.close();
}
