import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  decryptLocalSessionPayload,
  encryptLocalSessionPayload,
  toBase64Url,
} from "../artifacts/arenaforge/src/components/waveyard/library/local-session-crypto.ts";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const { build } = require("esbuild");
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
  await page.clock.install();
  await page.clock.fastForward(11_000);
  await page.getByRole("button", { name: "Retry connection" }).waitFor();
  await page.getByText(/If Wi-Fi changed, open Share on your laptop/).first().waitFor();
  assert.equal(await vocalsLevel.isDisabled(), true, "a stale phone cannot keep issuing mix controls");
  const stalePosition = await page.getByLabel("Seek current track").inputValue();
  await page.clock.fastForward(5000);
  assert.equal(await page.getByLabel("Seek current track").inputValue(), stalePosition,
    "the disconnected phone stops pretending its playback clock is live");
  await page.getByRole("button", { name: "Retry connection" }).click();
  await page.waitForFunction(() => window.__waveyardTestStreams.length === 2);
  await page.evaluate(eventPacket => window.__waveyardTestStreams[1].emit("state", eventPacket),
    encryptLocalSessionPayload(key, hostSenderId, 2, state));
  await page.getByText("Connected to your laptop").waitFor();
  await page.evaluate(() => window.__waveyardTestStreams[1].emit("ended", { reason: "replaced" }));
  await page.getByText(/This pairing ended or was replaced/).first().waitFor();
  assert.equal(await vocalsLevel.isDisabled(), true);
  await page.clock.fastForward(11_000);
  await page.getByText("Pairing ended", { exact: true }).waitFor();
  await page.clock.resume();

  // Bundle the real pairing component, not a reimplementation of its flow.
  const frontendRoot = fileURLToPath(new URL("../artifacts/arenaforge", import.meta.url));
  const fixture = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import LocalSessionPairing from "./src/components/waveyard/library/LocalSessionPairing";
        const snapshot = ${JSON.stringify(state)};
        window.pairingFixtureSnapshot = snapshot;
        createRoot(document.getElementById("root")).render(
          <LocalSessionPairing snapshot={snapshot} onCommand={() => {}} />
        );
      `,
      resolveDir: frontendRoot,
      loader: "tsx",
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const laptop = await browser.newPage();
  laptop.on("pageerror", error => pageErrors.push(error.message));
  await laptop.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async value => { window.pairingFixtureInvite = value; } },
      configurable: true,
    });
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  let starts = 0;
  let changedNetwork = false;
  let statusChecks = 0;
  const publishedStates = [];
  await laptop.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/pairing-fixture") {
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/pairing-fixture.js"></script>' });
    }
    if (url.pathname === "/pairing-fixture.js") {
      return route.fulfill({ contentType: "text/javascript", body: fixture.outputFiles[0].text });
    }
    if (url.pathname === "/api/waveyard/local-sync") {
      const body = route.request().postDataJSON();
      if (body.action === "status") {
        statusChecks++;
        const addresses = changedNetwork ? ["192.168.2.8"] : ["192.168.1.4"];
        return route.fulfill({ json: { active: true, addresses, selectedAddressAvailable: addresses.includes(body.selectedAddress) } });
      }
      if (body.action === "start") {
        starts++;
        return route.fulfill({ json: {
          addresses: changedNetwork ? ["192.168.2.8"] : ["192.168.1.4"],
          port: 18765, pairingToken: `pair-${starts}`, hostToken: `host-${starts}`,
          hostNoncePrefix: hostSenderId, expiresAt: Date.now() + 3_600_000, maxDevices: 4,
        } });
      }
      return route.fulfill({ json: { stopped: true } });
    }
    if (url.pathname === "/host/state") {
      const corsHeaders = {
        "access-control-allow-origin": new URL(baseUrl).origin,
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders });
      publishedStates.push(route.request().postDataJSON().packet);
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    return route.abort();
  });
  await laptop.goto(`${baseUrl}/pairing-fixture`);
  await laptop.getByTestId("waveyard-share-phone").click();
  await laptop.getByRole("button", { name: "Generate fresh QR" }).waitFor();
  await laptop.getByRole("button", { name: "Copy private link" }).click();
  const firstInvite = new URL(await laptop.evaluate(() => window.pairingFixtureInvite));
  const firstKey = new URLSearchParams(firstInvite.hash.slice(1)).get("key");
  const firstQr = await laptop.locator(".wy-sync-qr svg").innerHTML();
  await laptop.waitForFunction(() => document.querySelector(".wy-sync-qr"));
  assert.ok(statusChecks > 0, "the laptop polls its real status contract");
  changedNetwork = true;
  await laptop.evaluate(() => window.dispatchEvent(new Event("online")));
  await laptop.getByRole("alert").filter({ hasText: /network address changed/ }).waitFor();
  assert.equal(await laptop.locator(".wy-sync-qr").count(), 0, "a stale QR is not offered for scanning");
  assert.equal(await laptop.getByRole("button", { name: "Copy private link" }).isDisabled(), true);
  await laptop.getByRole("button", { name: "Generate fresh QR" }).click();
  await laptop.locator(".wy-sync-qr svg").waitFor();
  await laptop.getByRole("button", { name: "Copy private link" }).click();
  const nextInvite = new URL(await laptop.evaluate(() => window.pairingFixtureInvite));
  const nextKey = new URLSearchParams(nextInvite.hash.slice(1)).get("key");
  assert.notEqual(firstKey, nextKey, "a regenerated invitation uses a fresh encryption key");
  assert.equal(firstInvite.hostname, "192.168.1.4");
  assert.equal(nextInvite.hostname, "192.168.2.8");
  assert.notEqual(firstInvite.hash, nextInvite.hash, "the pairing token is rotated along with the key");
  assert.notEqual(await laptop.locator(".wy-sync-qr svg").innerHTML(), firstQr,
    "regeneration replaces the old network invitation");
  assert.equal(starts, 2);
  await laptop.waitForFunction(expected => JSON.stringify(window.pairingFixtureSnapshot) === expected, JSON.stringify(state));
  await laptop.waitForTimeout(900);
  assert.ok(publishedStates.length >= 2);
  await laptop.getByRole("button", { name: "End sharing" }).click();
  for (const sessionKey of [firstKey, nextKey]) {
    const snapshots = publishedStates.flatMap(packet => {
      try { return [decryptLocalSessionPayload(sessionKey, packet)]; } catch { return []; }
    });
    assert.ok(snapshots.length > 0, "both invitations publish an encrypted snapshot");
    for (const snapshot of snapshots) {
      const { updatedAt, ...values } = snapshot;
      const { updatedAt: _fixtureTime, ...expected } = state;
      assert.deepEqual(values, expected, "rotating the invitation does not alter the Waveyard session");
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log("Verified encrypted phone controls, bounded stale-connection recovery, fresh laptop QR after network change, and unchanged session state.");
} finally {
  await browser.close();
}
