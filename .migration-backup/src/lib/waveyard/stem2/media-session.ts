"use client";

/**
 * Waveyard P4 — the standard hardware media-key path (receive direction).
 *
 * Chromium exposes `navigator.mediaSession`: hardware/OS media commands
 * (keyboards, headset buttons, Bluetooth speakers whose playback buttons
 * send standard media commands) invoke the registered action handlers, and
 * now-playing metadata surfaces in the OS media UI. This is REAL standard
 * code — not a Stem2 protocol. Whether Stem2's physical buttons emit these
 * commands must be verified on the device; the capability matrix says
 * exactly that and claims nothing until then.
 *
 * The binding logic is pure (injectable session object) so it is fully
 * node-testable; the hook wraps it for React surfaces.
 */

import { useEffect } from "react";

export type HardwareMediaAction = "play" | "pause" | "previoustrack" | "nexttrack";

export interface MediaSessionLike {
  metadata: unknown;
  playbackState?: string;
  setActionHandler(action: HardwareMediaAction, handler: (() => void) | null): void;
}

export type MediaMetadataCtor = new (init: { title?: string; artist?: string; album?: string }) => unknown;

export interface HardwareMediaHandlers {
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export interface HardwareMediaNowPlaying {
  title: string;
  artist?: string | null;
  album?: string | null;
  playing: boolean;
}

const ACTIONS: HardwareMediaAction[] = ["play", "pause", "previoustrack", "nexttrack"];

/**
 * Apply (or release, when `nowPlaying`/`handlers` are null) the media-key
 * bindings on a mediaSession-like object. Release is explicit so a surface
 * never steals hardware keys after unmounting.
 */
export function applyHardwareMediaBindings(
  session: MediaSessionLike | null,
  metadataCtor: MediaMetadataCtor | null,
  nowPlaying: HardwareMediaNowPlaying | null,
  handlers: HardwareMediaHandlers | null,
): void {
  if (session === null) return;
  if (nowPlaying === null || handlers === null) {
    for (const action of ACTIONS) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Some runtimes reject unknown actions — releasing best-effort.
      }
    }
    session.metadata = null;
    session.playbackState = "none";
    return;
  }
  if (metadataCtor !== null) {
    session.metadata = new metadataCtor({
      title: nowPlaying.title,
      artist: nowPlaying.artist ?? undefined,
      album: nowPlaying.album ?? undefined,
    });
  }
  session.playbackState = nowPlaying.playing ? "playing" : "paused";
  session.setActionHandler("play", handlers.onPlayPause);
  session.setActionHandler("pause", handlers.onPlayPause);
  session.setActionHandler("nexttrack", handlers.onNext);
  session.setActionHandler("previoustrack", handlers.onPrevious);
}

/**
 * Bind hardware media keys for one surface. `nowPlaying` null disables the
 * binding (nothing loaded). Handlers run through the surface's EXISTING
 * controls — playback stays authoritative in the player/session engine.
 */
export function useHardwareMediaKeys(input: {
  nowPlaying: HardwareMediaNowPlaying | null;
  handlers: HardwareMediaHandlers | null;
}): void {
  // Leaf values only — stable, lint-clean dependencies; the effect rebinds
  // whenever anything that matters changes.
  const disabled = input.nowPlaying === null || input.handlers === null;
  const title = input.nowPlaying?.title ?? null;
  const artist = input.nowPlaying?.artist ?? null;
  const album = input.nowPlaying?.album ?? null;
  const playing = input.nowPlaying?.playing ?? false;
  const onPlayPause = input.handlers?.onPlayPause ?? null;
  const onNext = input.handlers?.onNext ?? null;
  const onPrevious = input.handlers?.onPrevious ?? null;
  useEffect(() => {
    if (disabled) return;
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession as unknown as MediaSessionLike | undefined;
    if (session === undefined || typeof session.setActionHandler !== "function") return;
    const metadataCtor = (typeof MediaMetadata === "function" ? MediaMetadata : null) as MediaMetadataCtor | null;
    const nowPlaying: HardwareMediaNowPlaying = { title: title ?? "", artist, album, playing };
    const handlers: HardwareMediaHandlers | null =
      onPlayPause !== null && onNext !== null && onPrevious !== null
        ? { onPlayPause, onNext, onPrevious }
        : null;
    applyHardwareMediaBindings(session, metadataCtor, nowPlaying, handlers);
    return () => {
      applyHardwareMediaBindings(session, metadataCtor, null, null);
    };
  }, [disabled, title, artist, album, playing, onPlayPause, onNext, onPrevious]);
}
