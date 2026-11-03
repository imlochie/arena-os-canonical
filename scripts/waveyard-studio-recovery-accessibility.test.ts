import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { DEFAULT_TIMING } from "../lib/arena/src/lib/waveyard/timing";
import { StudioTransport } from "../artifacts/arenaforge/src/components/waveyard/studio/StudioTransport";

const arenaForgeRequire = createRequire(new URL("../artifacts/arenaforge/package.json", import.meta.url));
const React = arenaForgeRequire("react");
const { renderToStaticMarkup } = arenaForgeRequire("react-dom/server");

function getButton(markup: string, accessibleName: string) {
  const escapedName = accessibleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = markup.match(new RegExp(`<button\\b(?=[^>]*aria-label="${escapedName}")[^>]*>`))?.[0];
  assert.ok(tag, `expected a button named "${accessibleName}"`);
  return tag;
}

function getAlertId(markup: string, message: string) {
  const alert = [...markup.matchAll(/<p\b([^>]*)>([^<]*)<\/p>/g)].find(([, attributes, body]) =>
    attributes.includes('role="alert"')
    && attributes.includes('aria-atomic="true"')
    && body.replace(/&#x27;/g, "'").includes(message),
  );
  assert.ok(alert, `expected an atomic alert containing "${message}"`);
  const id = alert[0].match(/\bid="([^"]+)"/)?.[1];
  assert.ok(id, `expected the alert "${message}" to have an id`);
  return id;
}

test("mobile audio recovery alerts are announced and linked to their usable controls", () => {
  const stemRecovery = "Audio playback was interrupted. Activate Play stems to resume.";
  const arrangementRecovery = "Audio couldn't resume automatically. Activate Preview arrangement to try again.";
  const markup = renderToStaticMarkup(
    React.createElement(StudioTransport, {
      transport: {
        playing: false,
        position: 0,
        duration: 10,
        masterVolume: 1,
        error: stemRecovery,
        seek: () => undefined,
        stop: () => undefined,
      },
      timing: DEFAULT_TIMING,
      loopStartMs: 0,
      loopEndMs: null,
      hasArrangement: true,
      onMasterVolume: () => undefined,
      onLoopChange: () => undefined,
      arrangementPlaying: false,
      arrangementPending: false,
      arrangementError: arrangementRecovery,
      onToggleArrangement: () => undefined,
      onToggleStemPreview: () => undefined,
    }),
  );

  const stemButton = getButton(markup, "Play stems");
  const arrangementButton = getButton(markup, "Preview arrangement");
  const stemAlertId = getAlertId(markup, stemRecovery);
  const arrangementAlertId = getAlertId(markup, arrangementRecovery);

  assert.notEqual(stemAlertId, arrangementAlertId, "each recovery message has its own description target");
  assert.match(stemButton, new RegExp(`aria-describedby="${stemAlertId}"`));
  assert.match(arrangementButton, new RegExp(`aria-describedby="${arrangementAlertId}"`));
  assert.doesNotMatch(stemButton, /\sdisabled(?:\s|=|>)/, "Play stems remains keyboard-focusable");
  assert.doesNotMatch(arrangementButton, /\sdisabled(?:\s|=|>)/, "Preview arrangement remains keyboard-focusable");
});
