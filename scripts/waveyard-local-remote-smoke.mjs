import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  decryptLocalSessionPayload,
  encryptLocalSessionPayload,
  toBase64Url,
} from "../artifacts/arenaforge/src/components/waveyard/library/local-session-crypto.ts";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const baseUrl = process.env.TEST_BASE_URL || "http://localhost:80";
const key = toBase64Url(new Uint8Array(32).fill(57));
const hostSenderId = toBase64Url(new Uint8Array(16).fill(44));
const deviceId = toBase64Url(new Uint8Array(16).fill(11));
const controls = [];
const pageErrors = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__waveyardTestStreams = [];
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        window.__waveyardTestStreams.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          this.dispatchEvent(new Event("open"));
        });
      }

      emit(name, payload) {
        this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }));
      }

      close() {
        this.readyState = 2;
      }
    };
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/join") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          deviceId,
          deviceToken: "paired-phone-token",
          expiresAt: Date.now() + 60_000,
        }),
      });
      return;
    }
    if (url.pathname === "/control") {
      controls.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
      return;
    }
    await route.continue();
  });

  const invite = new URL("/waveyard-remote.html", baseUrl);
  await page.goto(invite.toString(), { waitUntil: "networkidle" });
  await page.getByText("Not paired yet").waitFor();
  invite.hash = new URLSearchParams({
    pair: "temporary-pairing-token",
    key,
    host: hostSenderId,
  }).toString();
  await page.goto("about:blank");
  await page.goto(invite.toString(), { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__waveyardTestStreams?.length === 1);
  const state = {
    sessionName: "Private session",
    trackId: "current-track",
    title: "Original test track",
    artist: "Local fixture",
    nextTitle: "Next test track",
    previousTitle: null,
    queue: [{ id: "current-track", title: "Original test track", artist: "Local fixture", durationSeconds: 240 }],
    stems: [
      { stemType: "vocals", level: 0.8, isolated: false },
      { stemType: "drums", level: 1, isolated: false },
      { stemType: "bass", level: 1, isolated: false },
      { stemType: "other", level: 1, isolated: false },
    ],
    positionSeconds: 28,
    durationSeconds: 240,
    playing: true,
    updatedAt: Date.now(),
  };
  const packet = encryptLocalSessionPayload(key, hostSenderId, 1, state);
  await page.evaluate((eventPacket) => {
    window.__waveyardTestStreams[0].emit("state", eventPacket);
  }, packet);

  await page.getByText("Connected to your laptop").waitFor();
  await page.getByRole("heading", { name: "Live stems" }).waitFor();
  const vocalsLevel = page.getByLabel("vocals level");
  assert.equal(await vocalsLevel.inputValue(), "0.8");
  assert.equal(await page.getByRole("button", { name: "Restore mix" }).isVisible(), true);
  assert.equal(new URL(page.url()).hash, "", "QR credentials should be removed from the address bar after pairing");

  const expectEncryptedCommand = async (expected, trigger) => {
    const requestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/control" && request.method() === "POST",
    );
    await trigger();
    const request = await requestPromise;
    const controlPacket = request.postDataJSON().packet;
    assert.deepEqual(decryptLocalSessionPayload(key, controlPacket), expected);
  };

  await expectEncryptedCommand(
    { type: "set-stem-level", stemType: "vocals", level: 0.79 },
    async () => {
      await vocalsLevel.focus();
      await vocalsLevel.press("ArrowLeft");
    },
  );
  await expectEncryptedCommand(
    { type: "isolate-stem", stemType: "bass" },
    () => page.getByRole("button", { name: "Isolate bass" }).click(),
  );
  await expectEncryptedCommand(
    { type: "restore-mix" },
    () => page.getByRole("button", { name: "Restore mix" }).click(),
  );
  assert.equal(controls.length, 3, "each live stem action should send exactly one encrypted command");
  assert.deepEqual(pageErrors, []);
  console.log("Verified mobile remote renders live stems and sends encrypted level, isolate, and restore controls.");
} finally {
  await browser.close();
}
