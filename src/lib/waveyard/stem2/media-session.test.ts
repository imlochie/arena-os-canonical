/**
 * Stem2 adapter — hardware media-key binding tests (SIMULATED session
 * object; unit tests only, never hardware verification).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyHardwareMediaBindings,
  type HardwareMediaHandlers,
  type MediaMetadataCtor,
  type MediaSessionLike,
} from "./media-session";

/** SIMULATED navigator.mediaSession. */
function fakeSession() {
  const handlers = new Map<string, (() => void) | null>();
  const session: MediaSessionLike = {
    metadata: null,
    playbackState: undefined,
    setActionHandler(action, handler) {
      handlers.set(action, handler);
    },
  };
  const fire = (action: string) => handlers.get(action)?.();
  return { session, handlers, fire };
}

/** SIMULATED MediaMetadata constructor. */
const FakeMetadata: MediaMetadataCtor = class {
  title?: string;
  artist?: string;
  album?: string;
  constructor(init: { title?: string; artist?: string; album?: string }) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
  }
};

const handlers = (log: string[]): HardwareMediaHandlers => ({
  onPlayPause: () => log.push("playpause"),
  onNext: () => log.push("next"),
  onPrevious: () => log.push("previous"),
});

describe("applyHardwareMediaBindings", () => {
  it("binds metadata, playback state, and all hardware actions", () => {
    const { session, fire } = fakeSession();
    const log: string[] = [];
    applyHardwareMediaBindings(
      session,
      FakeMetadata,
      { title: "Windowlicker", artist: "Aphex Twin", playing: true },
      handlers(log),
    );
    const metadata = session.metadata as { title?: string; artist?: string };
    assert.equal(metadata.title, "Windowlicker");
    assert.equal(metadata.artist, "Aphex Twin");
    assert.equal(session.playbackState, "playing");

    fire("play");
    fire("pause");
    fire("nexttrack");
    fire("previoustrack");
    assert.deepEqual(log, ["playpause", "playpause", "next", "previous"]);
  });

  it("reflects paused state", () => {
    const { session } = fakeSession();
    applyHardwareMediaBindings(session, FakeMetadata, { title: "X", playing: false }, handlers([]));
    assert.equal(session.playbackState, "paused");
  });

  it("releases every handler and clears metadata on unbind", () => {
    const { session, handlers: bound, fire } = fakeSession();
    const log: string[] = [];
    applyHardwareMediaBindings(session, FakeMetadata, { title: "X", playing: true }, handlers(log));
    applyHardwareMediaBindings(session, FakeMetadata, null, null);
    for (const action of ["play", "pause", "nexttrack", "previoustrack"]) {
      assert.equal(bound.get(action), null, action);
    }
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, "none");
    fire("play"); // nothing bound — no crash, no log
    assert.deepEqual(log, []);
  });

  it("binds handlers even when MediaMetadata is unavailable", () => {
    const { session, fire } = fakeSession();
    const log: string[] = [];
    applyHardwareMediaBindings(session, null, { title: "X", playing: true }, handlers(log));
    assert.equal(session.metadata, null);
    fire("nexttrack");
    assert.deepEqual(log, ["next"]);
  });

  it("is a no-op without a mediaSession", () => {
    assert.doesNotThrow(() => {
      applyHardwareMediaBindings(null, FakeMetadata, { title: "X", playing: true }, handlers([]));
    });
  });

  it("tolerates runtimes that reject releasing unknown actions", () => {
    const session: MediaSessionLike = {
      metadata: null,
      setActionHandler(action, handler) {
        if (handler === null && action === "previoustrack") throw new Error("simulated unknown action");
      },
    };
    assert.doesNotThrow(() => {
      applyHardwareMediaBindings(session, FakeMetadata, null, null);
    });
  });
});
