import assert from "node:assert/strict";

// Deliberately isolated from session handoff, playback, and clip-edit checks.
export async function verifyAutomationKeyboard({ page, base, makePcmWav }) {
  const projectId = "00000000-0000-4000-8000-000000000200";
  const remixId = "00000000-0000-4000-8000-000000000201";
  const trackId = "00000000-0000-4000-8000-000000000202";
  const stems = [{ id: "keyboard-stem", sourceAssetId: "keyboard-source", stemType: "vocals",
    durationSeconds: 8, sampleRate: 16000, channels: 1, codec: "pcm_s16le", format: "wav",
    fileSizeBytes: 256044, checksumSha256: "keyboard-fixture", model: "fixture", modelVersion: "1" }];
  const sources = [{ id: "keyboard-source", originalFilename: "Keyboard fixture.wav", durationSeconds: 8, linkedFromLibrary: true }];
  const audio = makePcmWav(220, 0.2);
  const fixture = {
    remix: { id: remixId, projectId, name: "Keyboard automation", masterVolume: 1, masterInserts: "[]",
      loopStartMs: 0, loopEndMs: null, tempoBpm: 120, timeSignatureNumerator: 4,
      timeSignatureDenominator: 4, gridDivision: "beat", snapEnabled: true, targetKey: null, version: 1 },
    tracks: [{ id: trackId, remixSessionId: remixId, stemAssetId: "keyboard-stem", name: "Keyboard lane",
      sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false, inserts: [], clips: [] }],
    automation: [], stems,
  };
  const requests = [];
  let failNext = false;
  let nextId = 0;
  let holdNextAutomationResponse = false;
  let automationResponseHeld = () => {};
  let releaseAutomationResponse = null;
  const respondToAutomation = (json, body) => {
    if (!holdNextAutomationResponse) return json(body);
    holdNextAutomationResponse = false;
    return new Promise((resolve) => {
      releaseAutomationResponse = () => { void json(body).then(resolve); };
      automationResponseHeld();
    });
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/assets/keyboard-stem") return route.fulfill({ status: 200, contentType: "audio/wav", body: audio });
    if (path.endsWith("/waveform")) return json({ peaks: [], durationSeconds: 8 });
    if (path === `/api/waveyard/projects/${projectId}`) return json({
      project: { title: "Keyboard automation", licenseCode: "private", visibility: "private", publicationStatus: "draft" },
      role: "owner", build: null, sources: [], studioSources: sources, stems, waveforms: [], waveformJobs: [], jobs: [],
    });
    if (path === `/api/waveyard/projects/${projectId}/remixes`) return json({ remixes: [{ id: remixId }] });
    if (path === `/api/remixes/${remixId}` && route.request().method() === "GET") return json(fixture);
    if (path === `/api/remixes/${remixId}/automation`) {
      const request = route.request().postDataJSON();
      requests.push(request);
      if (failNext) { failNext = false; return json({ error: "Automation save temporarily unavailable." }, 503); }
      let lane = fixture.automation.find((item) => item.parameter === request.parameter);
      if (!lane) { lane = { remixTrackId: trackId, parameter: request.parameter, points: [] }; fixture.automation.push(lane); }
      const removedPointIds = lane.points.filter((point) => point.id === request.pointId || point.timelineMs === request.timelineMs).map((point) => point.id);
      lane.points = lane.points.filter((point) => !removedPointIds.includes(point.id));
      if (request.operation === "delete") return respondToAutomation(json, { removedPointIds });
      const point = { id: request.pointId ?? `point-${++nextId}`, remixTrackId: trackId, parameter: request.parameter, timelineMs: request.timelineMs, value: request.value };
      lane.points.push(point);
      return respondToAutomation(json, { point, removedPointIds });
    }
    if (path === `/api/remixes/${remixId}` && route.request().method() === "PUT") {
      const state = route.request().postDataJSON();
      fixture.remix = { ...fixture.remix, ...state };
      if (Array.isArray(state.tracks)) fixture.tracks = state.tracks;
      if (Array.isArray(state.automation)) fixture.automation = state.automation;
      return json(fixture);
    }
    if (path.endsWith("/publication")) return json({ publication: { visibility: "private", publicationStatus: "draft", tags: [] }, exports: [], exportJobs: [] });
    if (path.endsWith("/arena-handoff")) return json({ linked: false });
    if (path.endsWith("/versions")) return json({ versions: [] });
    return json({ tracks: [], sessions: [], events: [] });
  });
  await page.goto(`${base}/waveyard/projects/${projectId}?view=studio`);
  const editor = page.getByRole("form", { name: "Automation point editor" });
  await editor.waitFor({ timeout: 15000 }).catch(async (error) => {
    console.error("Automation fixture page:", await page.locator("body").innerText());
    throw error;
  });
  const point = editor.getByLabel("Automation point", { exact: true });
  const time = editor.getByLabel("Automation time in milliseconds");
  const value = editor.getByLabel("Automation value");
  const parameter = editor.getByLabel("Automation parameter");
  const status = editor.getByRole("status");
  const typeNumber = async (input, text) => {
    await input.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(text);
  };
  const activate = async (button) => { await button.focus(); await page.keyboard.press("Enter"); };
  const waitMessage = (text) => page.waitForFunction(({ text }) =>
    document.querySelector(".automation-editor [role=status]")?.textContent.includes(text), { text });
  const assertFocus = async (locator) => assert(await locator.evaluate((element) => document.activeElement === element));

  // Use Tab between numeric controls and the action, not pointer interaction.
  await typeNumber(time, "1200");
  await page.keyboard.press("Tab");
  await assertFocus(value);
  await typeNumber(value, "1.5");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitMessage("saved at 1200");
  assert.equal(await point.inputValue(), "1200");
  await assertFocus(time);
  assert.deepEqual(requests.at(-1), { operation: "upsert", remixTrackId: trackId, parameter: "volume", timelineMs: 1200, value: 1.5 });

  // Hold the automation response while a different Studio control changes.
  // Undo must revert only the automation edit and retain the intervening fader change.
  let signalAutomationResponseHeld;
  const automationResponseIsHeld = new Promise((resolve) => { signalAutomationResponseHeld = resolve; });
  automationResponseHeld = () => signalAutomationResponseHeld();
  holdNextAutomationResponse = true;
  await typeNumber(time, "1800");
  await typeNumber(value, "1.4");
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  await Promise.race([
    automationResponseIsHeld,
    page.waitForTimeout(8000).then(() => { throw new Error("Automation response was not held for the race regression."); }),
  ]);
  const fader = page.getByRole("slider", { name: /Vocals fader/ });
  await fader.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await fader.inputValue(), "0.99");
  assert.equal(typeof releaseAutomationResponse, "function");
  releaseAutomationResponse();
  releaseAutomationResponse = null;
  await waitMessage("saved at 1800");

  const undoSave = page.waitForRequest((request) =>
    request.method() === "PUT" && new URL(request.url()).pathname === `/api/remixes/${remixId}`,
  );
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true,
  })));
  const undoPayload = (await undoSave).postDataJSON();
  assert.equal(
    undoPayload.tracks.find((track) => track.id === trackId)?.volume,
    0.99,
    "undoing the automation response must retain the mixer change made while it was pending",
  );
  assert.equal(
    undoPayload.automation.find((lane) => lane.parameter === "volume")?.points[0]?.timelineMs,
    1200,
    "undo must restore the previous automation point without discarding the intervening mixer edit",
  );
  await typeNumber(time, "86400001");
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  assert.equal(requests.length, 1, "Out-of-bounds time must not reach the API");
  await typeNumber(time, "2400");
  await typeNumber(value, "2.1");
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  assert.equal(requests.length, 1, "Out-of-bounds volume must not reach the API");
  await typeNumber(value, "2");
  failNext = true;
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  await waitMessage("temporarily unavailable");
  assert.equal(await time.inputValue(), "2400");
  assert.equal(await value.inputValue(), "2");
  await assertFocus(time);
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  await waitMessage("saved at 2400");
  assert.equal(requests.at(-1).pointId, "point-1", "Moving a point must update its existing ID");
  await page.getByRole("button", { name: /volume point at 2400 milliseconds$/ }).focus();
  await page.keyboard.press("Space");
  await assertFocus(time);
  await activate(editor.getByRole("button", { name: "Delete point", exact: true }));
  await waitMessage("deleted");
  await assertFocus(point);
  assert.equal(await point.inputValue(), "new");
  assert.equal(await editor.getByRole("button", { name: "Delete point", exact: true }).isDisabled(), true);

  await parameter.focus();
  await page.keyboard.press("p");
  await page.keyboard.press("Tab");
  assert.equal(await parameter.inputValue(), "pan");
  await typeNumber(time, "0");
  await typeNumber(value, "-1.1");
  const count = requests.length;
  await activate(editor.getByRole("button", { name: "Create point", exact: true }));
  assert.equal(requests.length, count, "Out-of-bounds pan must not reach the API");
  await typeNumber(value, "-1");
  await activate(editor.getByRole("button", { name: "Create point", exact: true }));
  await waitMessage("saved at 0");
  assert.equal(requests.at(-1).parameter, "pan");
  assert.equal(requests.at(-1).value, -1);
  await typeNumber(time, "86400000");
  await typeNumber(value, "1");
  await activate(editor.getByRole("button", { name: "Save point", exact: true }));
  await waitMessage("saved at 86400000");
  assert.equal(requests.at(-1).pointId, "point-2");
  await point.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  assert.equal(await point.inputValue(), "86400000", "Existing points can be selected without finding an offscreen dot");
  await activate(editor.getByRole("button", { name: "Delete point", exact: true }));
  await waitMessage("deleted");
  await assertFocus(point);
  assert.equal(await status.textContent(), "pan point deleted. Choose another point or create a new one.");
  console.log("AUTOMATION_KEYBOARD_ONLY_COMPLETE: create, select, move, bounds, failed save/retry, and delete with focus recovery for volume and pan.");
}
