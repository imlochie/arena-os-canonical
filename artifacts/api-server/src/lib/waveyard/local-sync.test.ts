import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWaveyardLocalSync, stopWaveyardLocalSync } from "./local-sync";

test("laptop sync relays encrypted packets only while the pairing is active", async () => {
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  const previousWebRoot = process.env.ARENA_WEB_ROOT;
  const webRoot = await mkdtemp(join(tmpdir(), "waveyard-local-sync-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "waveyard-remote.html"), "<!doctype html><main>Waveyard remote</main>");
  await writeFile(join(webRoot, "assets", "remote-test.js"), "export const remote = true;");
  process.env.ARENA_DESKTOP_MODE = "1";
  process.env.ARENA_WEB_ROOT = webRoot;

  let result: Awaited<ReturnType<typeof startWaveyardLocalSync>> | null = null;
  const hostOrigin = "http://127.0.0.1:5170";
  try {
    result = await startWaveyardLocalSync({
      hostOrigin,
    });
    const base = `http://127.0.0.1:${result.port}`;

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Waveyard remote/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");

    const asset = await fetch(`${base}/assets/remote-test.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "export const remote = true;");
    assert.equal((await fetch(`${base}/api/library/tracks`)).status, 404);

    const deniedJoin = await fetch(`${base}/join?pair=not-the-code`, {
      headers: { origin: base },
    });
    assert.equal(deniedJoin.status, 401);

    const joinedResponse = await fetch(`${base}/join?pair=${encodeURIComponent(result.pairingToken)}`, {
      headers: { origin: base },
    });
    assert.equal(joinedResponse.status, 200);
    const joined = await joinedResponse.json() as { deviceId: string; deviceToken: string };

    const hostState = await fetch(`${base}/host/state?token=${encodeURIComponent(result.hostToken)}`, {
      method: "POST",
      headers: { origin: hostOrigin, "content-type": "application/json" },
      body: JSON.stringify({ packet: { senderId: result.hostNoncePrefix, counter: 1, ciphertext: "opaque-state" } }),
    });
    assert.equal(hostState.status, 204);

    const events = await fetch(`${base}/events?token=${encodeURIComponent(joined.deviceToken)}`, {
      headers: { origin: base },
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    let eventText = "";
    while (!eventText.includes("opaque-state")) {
      const next = await reader.read();
      if (next.done) break;
      eventText += new TextDecoder().decode(next.value);
    }
    assert.match(eventText, /opaque-state/);
    await reader.cancel();

    const hostEvents = await fetch(`${base}/host/events?token=${encodeURIComponent(result.hostToken)}`, {
      headers: { origin: hostOrigin },
    });
    assert.equal(hostEvents.status, 200);
    const hostReader = hostEvents.body!.getReader();
    const controlResponse = await fetch(`${base}/control?token=${encodeURIComponent(joined.deviceToken)}`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        packet: {
          senderId: joined.deviceId,
          counter: 1,
          ciphertext: "opaque-control",
        },
      }),
    });
    assert.equal(controlResponse.status, 202);
    let controlEventText = "";
    while (!controlEventText.includes("opaque-control")) {
      const next = await hostReader.read();
      if (next.done) break;
      controlEventText += new TextDecoder().decode(next.value);
    }
    assert.match(controlEventText, /opaque-control/);
    await hostReader.cancel();

    const wrongOrigin = await fetch(`${base}/control?token=${encodeURIComponent(joined.deviceToken)}`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ packet: { ciphertext: "not-forwarded" } }),
    });
    assert.equal(wrongOrigin.status, 403);

    assert.equal(await stopWaveyardLocalSync(result.hostToken), true);
    result = null;
    await assert.rejects(fetch(base), /fetch failed|ECONNREFUSED/i);
  } finally {
    if (result) await stopWaveyardLocalSync(result.hostToken).catch(() => false);
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
    if (previousWebRoot === undefined) delete process.env.ARENA_WEB_ROOT;
    else process.env.ARENA_WEB_ROOT = previousWebRoot;
    await rm(webRoot, { recursive: true, force: true });
  }
});

test("local sync refuses hosted requests and non-local host origins", async () => {
  const previousDesktopMode = process.env.ARENA_DESKTOP_MODE;
  delete process.env.ARENA_DESKTOP_MODE;
  try {
    await assert.rejects(
      startWaveyardLocalSync({ hostOrigin: "http://127.0.0.1:5170" }),
      /LOCAL_SYNC_DESKTOP_ONLY/,
    );
    process.env.ARENA_DESKTOP_MODE = "1";
    await assert.rejects(
      startWaveyardLocalSync({ hostOrigin: "https://arena.example" }),
      /LOCAL_SYNC_HOST_ORIGIN_INVALID/,
    );
  } finally {
    if (previousDesktopMode === undefined) delete process.env.ARENA_DESKTOP_MODE;
    else process.env.ARENA_DESKTOP_MODE = previousDesktopMode;
  }
});
