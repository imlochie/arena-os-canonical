import assert from "node:assert/strict";

// No real library, model processing, or unrelated room workflows are needed.
export async function verifyFullscreenKeyboard({ page, base, makePcmWav }) {
  const projectId = "00000000-0000-4000-8000-000000000210";
  const remixId = "00000000-0000-4000-8000-000000000211";
  const stems = [{ id: "fullscreen-stem", sourceAssetId: "fullscreen-source", stemType: "vocals",
    durationSeconds: 30, sampleRate: 16000, channels: 1, codec: "pcm_s16le", format: "wav",
    fileSizeBytes: 960044, checksumSha256: "fullscreen-fixture", model: "fixture", modelVersion: "1" }];
  const sources = [{ id: "fullscreen-source", originalFilename: "Fullscreen keyboard.wav", durationSeconds: 30, linkedFromLibrary: true }];
  const audio = makePcmWav(220, 0.2, 30);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/assets/fullscreen-stem") return route.fulfill({ contentType: "audio/wav", body: audio });
    if (path.endsWith("/waveform")) return json({ peaks: [], durationSeconds: 30 });
    if (path === `/api/waveyard/projects/${projectId}`) return json({
      project: { title: "Fullscreen keyboard", licenseCode: "private", visibility: "private", publicationStatus: "draft" },
      role: "owner", build: null, sources: [], studioSources: sources, stems, waveforms: [], waveformJobs: [], jobs: [],
    });
    if (path === `/api/waveyard/projects/${projectId}/remixes`) return json({ remixes: [{ id: remixId }] });
    if (path === `/api/remixes/${remixId}`) return json({
      remix: { id: remixId, projectId, name: "Fullscreen keyboard", masterVolume: 1, masterInserts: "[]",
        loopStartMs: 0, loopEndMs: null, tempoBpm: 120, timeSignatureNumerator: 4,
        timeSignatureDenominator: 4, gridDivision: "beat", snapEnabled: true, targetKey: null, version: 1 },
      tracks: [{ id: "fullscreen-track", remixSessionId: remixId, stemAssetId: "fullscreen-stem",
        name: "Fullscreen vocals", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false, inserts: [],
        clips: [{ id: "fullscreen-clip", remixTrackId: "fullscreen-track", stemAssetId: "fullscreen-stem",
          timelineStartMs: 0, sourceOffsetMs: 0, durationMs: 30000, gain: 1, playbackRate: 1,
          fadeInMs: 0, fadeOutMs: 0 }] }], automation: [], stems,
    });
    if (path.endsWith("/publication")) return json({ publication: { visibility: "private", publicationStatus: "draft", tags: [] }, exports: [], exportJobs: [] });
    if (path.endsWith("/arena-handoff")) return json({ linked: false });
    if (path.endsWith("/versions")) return json({ versions: [] });
    return json({ tracks: [], sessions: [], events: [] });
  });
  await page.goto(`${base}/waveyard/projects/${projectId}?view=play`);
  const modes = page.getByRole("tablist", { name: "Waveyard presentation mode" });
  const activate = async (control, key = "Enter") => {
    await control.focus();
    await page.keyboard.press(key);
  };
  const assertFocus = async (control) => {
    const details = await control.evaluate((element) => ({
      active: document.activeElement?.outerHTML.slice(0, 220),
      rect: element.getBoundingClientRect().toJSON(),
      outline: getComputedStyle(element).outlineWidth,
      focusVisible: element.matches(":focus-visible"),
      overlays: element.closest(".cinematic-visual")?.getAttribute("data-overlays"),
      hit: document.elementFromPoint(element.getBoundingClientRect().left + element.clientWidth / 2,
        element.getBoundingClientRect().top + element.clientHeight / 2)?.outerHTML.slice(0, 220),
    }));
    assert(await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return document.activeElement === element && element.matches(":focus-visible") &&
        Number.parseFloat(style.outlineWidth) >= 3 && style.visibility === "visible" &&
        rect.top >= 0 && rect.bottom <= innerHeight &&
        element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) &&
        !element.closest("[inert]") &&
        (!element.closest(".cinematic-visual") || element.closest(".cinematic-visual").dataset.overlays === "visible");
    }), `Focus must be visible, onscreen and unobscured on the active control: ${JSON.stringify(details)}`);
  };
  for (const [mode, testId] of [["Play", "living-player"], ["Visual", "cinematic-visual"]]) {
    await activate(modes.getByRole("tab", { name: mode, exact: true }));
    const player = page.getByTestId(testId);
    await player.waitFor();
    for (const exit of ["Escape", "button"]) {
      const toggle = player.locator("[data-fullscreen-toggle]");
      await activate(toggle, exit === "Escape" ? "Enter" : "Space");
      assert(await player.evaluate((element) => element.classList.contains("fullscreen")));
      await assertFocus(toggle);
      // Cycle through every control and beyond both ends without background focus.
      for (const key of ["Tab", "Shift+Tab"]) {
        const count = await player.locator("button, input, select, a[href], [tabindex]").count();
        for (let index = 0; index < count + 2; index++) {
          await page.keyboard.press(key);
          assert(await player.evaluate((element) => element.contains(document.activeElement)),
            `${mode} fullscreen must contain ${key} navigation`);
        }
      }
      if (mode === "Visual") {
        await activate(player.getByRole("button", { name: "Play transport", exact: true }));
        await player.getByRole("button", { name: "Pause transport", exact: true }).waitFor({ timeout: 5000 }).catch(async (error) => {
          console.error(await page.locator("body").innerText());
          throw error;
        });
        // The ordinary overlay timer must not hide a keyboard user's controls.
        await page.waitForTimeout(4000);
        assert.equal(await player.locator(".visual-play").getAttribute("aria-label"), "Pause transport",
          `Playback fixture must still be running: ${await page.locator(".error").allTextContents()}`);
        await assertFocus(player.locator(".visual-play"));
      }
      if (exit === "Escape") await page.keyboard.press("Escape");
      else await activate(toggle, "Space");
      assert(!(await player.evaluate((element) => element.classList.contains("fullscreen"))));
      await assertFocus(toggle);
      if (mode === "Visual") await activate(player.getByRole("button", { name: "Pause transport", exact: true }));
      // Leaving via an in-player view switch must also clear background inertness.
      await activate(player.getByRole("button", { name: mode === "Play" ? "Open Studio" : "Studio", exact: true }));
      await assertFocus(modes.getByRole("tab", { name: "Studio", exact: true }));
      await activate(modes.getByRole("tab", { name: mode, exact: true }));
    }
    // Switching views while fullscreen unmounts the player rather than toggling it.
    await activate(player.locator("[data-fullscreen-toggle]"));
    await activate(player.getByRole("button", { name: mode === "Play" ? "Open Studio" : "Studio", exact: true }));
    await assertFocus(modes.getByRole("tab", { name: "Studio", exact: true }));
    assert.equal(await page.locator("[inert]").count(), 0, "Fullscreen must restore background navigation");
  }
  console.log("PASS: Play and Visual keyboard fullscreen entry, Escape/control exits, focus containment, overlay visibility and Studio handoff.");
}
