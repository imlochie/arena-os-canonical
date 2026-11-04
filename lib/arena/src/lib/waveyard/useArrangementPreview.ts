"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clipFadeShapeOrLinear, fadeCurveSamples, fadeGainAt } from "./fades";
import { clearArrangementPreviewGraph } from "./arrangement-preview-graph";
import { selectArrangementPreviewTracks } from "./arrangement-preview-selection";
import {
  ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
  arrangementPreviewBufferBytes,
  estimateArrangementPreviewMemory,
  formatArrangementPreviewMiB,
  releaseInactiveArrangementPreviewBuffers,
  type ArrangementPreviewAssetMetadata,
} from "./arrangement-preview-memory";
import type { RemixTrackInput } from "./remix";

type PreviewClip = RemixTrackInput["clips"][number];
type PreviewTrack = RemixTrackInput;
type PreviewState = {
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: PreviewTrack[];
  previewAssets?: ArrangementPreviewAssetMetadata[];
};

const EMPTY_PREVIEW_ASSETS: ArrangementPreviewAssetMetadata[] = [];
type ScheduledSource = { source: AudioBufferSourceNode; gain: GainNode };

function clipLevelAt(clip: PreviewClip, offsetMs: number) {
  const shape = clipFadeShapeOrLinear(clip.fadeShape);
  if (clip.fadeInMs > 0 && offsetMs < clip.fadeInMs) return fadeGainAt(shape, offsetMs / clip.fadeInMs);
  const fadeOutStart = clip.durationMs - clip.fadeOutMs;
  if (clip.fadeOutMs > 0 && offsetMs > fadeOutStart) return fadeGainAt(shape, (clip.durationMs - offsetMs) / clip.fadeOutMs);
  return 1;
}

/**
 * A deliberately browser-only audition graph. It reads the same private asset
 * route as the stem inspector but never writes audio or becomes an export
 * source; persisted clips and the worker snapshot remain authoritative.
 */
export function useArrangementPreview(
  onPosition: (milliseconds: number) => void,
  supplementalAssets: ArrangementPreviewAssetMetadata[] = EMPTY_PREVIEW_ASSETS,
) {
  const context = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const decodeQueue = useRef<Promise<void>>(Promise.resolve());
  const scheduled = useRef<ScheduledSource[]>([]);
  const graphNodes = useRef(new Set<AudioNode>());
  const raf = useRef<number | null>(null);
  const origin = useRef({ contextTime: 0, positionMs: 0 });
  const currentState = useRef<PreviewState | null>(null);
  const playbackGeneration = useRef(0);
  const pendingStartMs = useRef<number | null>(null);
  const recoveryInFlight = useRef(false);
  const wasBackgrounded = useRef(false);
  const recoverAudioContext = useRef<() => void>(() => undefined);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    for (const item of scheduled.current) {
      try { item.source.stop(); } catch { /* already finished */ }
    }
    clearArrangementPreviewGraph(graphNodes.current);
    scheduled.current = [];
  }, []);

  const ensureContext = useCallback(() => {
    if (!context.current) {
      context.current = new AudioContext();
      context.current.addEventListener("statechange", () => recoverAudioContext.current());
    }
    return context.current;
  }, []);
  const ensureBuffer = useCallback((assetId: string, generation: number) => {
    const existing = buffers.current.get(assetId);
    if (existing) return Promise.resolve(existing);
    const pending = decodeQueue.current.then(async () => {
      if (generation !== playbackGeneration.current) return null;
      const cached = buffers.current.get(assetId);
      if (cached) return cached;
      const response = await fetch(`/api/assets/${assetId}`);
      if (!response.ok) throw new Error("A stem could not be loaded for arrangement preview.");
      const data = await response.arrayBuffer();
      const decoded = await ensureContext().decodeAudioData(data);
      if (generation !== playbackGeneration.current) return null;
      buffers.current.set(assetId, decoded);
      return decoded;
    });
    // Keep a rejected decode from poisoning the queue, and serialize future
    // decodes so fast arrangement switches cannot decode two large files at once.
    decodeQueue.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [ensureContext]);

  const schedule = useCallback(async (state: PreviewState, startMs: number, generation: number) => {
    if (generation !== playbackGeneration.current) return false;
    pendingStartMs.current = startMs;
    setPending(true);
    const audio = ensureContext();
    const { audibleTracks, assetIds } = selectArrangementPreviewTracks(state.tracks);
    const activeAssetIds = new Set(assetIds);
    // Stop the old graph before releasing donor buffers. This prevents old and
    // new arrangements from retaining two sets of AudioBuffers during a switch.
    clear();
    releaseInactiveArrangementPreviewBuffers(buffers.current, activeAssetIds);
    await decodeQueue.current;
    if (generation !== playbackGeneration.current) return false;

    const metadataById = new Map(
      [...supplementalAssets, ...(state.previewAssets ?? [])].map((asset) => [asset.id, asset]),
    );
    const estimate = estimateArrangementPreviewMemory(
      assetIds,
      [...metadataById.values()],
      audio.sampleRate,
    );
    if (!estimate.ok) {
      buffers.current.clear();
      throw new Error(
        "Studio can't safely estimate the memory needed for this arrangement. Reopen the session to refresh its audio details, then try again.",
      );
    }
    if (estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
      buffers.current.clear();
      throw new Error(
        `This arrangement is estimated to need ${formatArrangementPreviewMiB(estimate.estimatedPeakBytes)} MiB for browser preview, above the ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB safety limit. Mute or solo fewer stems, or choose shorter audio source files; Studio decodes each whole source even when a clip uses only a short section.`,
      );
    }

    for (const assetId of assetIds) {
      if (generation !== playbackGeneration.current) return false;
      const buffer = await ensureBuffer(assetId, generation);
      if (generation !== playbackGeneration.current || !buffer) return false;
      if (arrangementPreviewBufferBytes(buffers.current) > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
        buffers.current.clear();
        throw new Error(
          `The decoded audio exceeded Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB preview safety limit. Mute or solo fewer stems, or choose shorter audio source files; Studio decodes each whole source even when a clip uses only a short section.`,
        );
      }
    }
    if (generation !== playbackGeneration.current) return false;
    const master = audio.createGain();
    master.gain.value = state.masterVolume;
    master.connect(audio.destination);
    graphNodes.current.add(master);
    for (const track of audibleTracks) {
      for (const clip of track.clips) {
        const elapsedMs = Math.max(0, startMs - clip.timelineStartMs);
        if (elapsedMs >= clip.durationMs) continue;
        const buffer = buffers.current.get(clip.stemAssetId);
        if (!buffer) continue;
        const source = audio.createBufferSource();
        const gain = audio.createGain();
        const panner = "createStereoPanner" in audio ? audio.createStereoPanner() : null;
        graphNodes.current.add(source);
        graphNodes.current.add(gain);
        if (panner) graphNodes.current.add(panner);
        source.buffer = buffer;
        source.connect(gain);
        if (panner) { gain.connect(panner); panner.pan.value = track.pan; panner.connect(master); }
        else gain.connect(master);
        const baseGain = track.volume * clip.gain;
        const startAt = audio.currentTime + Math.max(0, (clip.timelineStartMs - startMs) / 1000);
        const remainingMs = clip.durationMs - elapsedMs;
        const level = baseGain * clipLevelAt(clip, elapsedMs);
        gain.gain.setValueAtTime(level, startAt);
        const fadeShape = clipFadeShapeOrLinear(clip.fadeShape);
        const fadeOutStart = clip.durationMs - clip.fadeOutMs;
        if (fadeShape === "linear") {
          if (clip.fadeInMs > elapsedMs)
            gain.gain.linearRampToValueAtTime(baseGain, startAt + (clip.fadeInMs - elapsedMs) / 1000);
          if (clip.fadeOutMs > 0) {
            const untilFadeMs = fadeOutStart - elapsedMs;
            const endAt = startAt + remainingMs / 1000;
            if (untilFadeMs > 0) {
              gain.gain.setValueAtTime(baseGain, startAt + untilFadeMs / 1000);
              gain.gain.linearRampToValueAtTime(0, endAt);
            } else gain.gain.linearRampToValueAtTime(0, endAt);
          }
        } else {
          // Shaped fades: exact curve segments sampled from the same
          // fadeGainAt the ffmpeg render uses (qsin/hsin), so preview and
          // export agree by construction.
          if (clip.fadeInMs > elapsedMs) {
            const curve = fadeCurveSamples(fadeShape, elapsedMs / clip.fadeInMs, 1, 65);
            for (let i = 0; i < curve.length; i += 1) curve[i] *= baseGain;
            gain.gain.setValueCurveAtTime(curve, startAt, (clip.fadeInMs - elapsedMs) / 1000);
          }
          if (clip.fadeOutMs > 0 && fadeOutStart > elapsedMs) {
            const curve = fadeCurveSamples(fadeShape, 1, 0, 65);
            for (let i = 0; i < curve.length; i += 1) curve[i] *= baseGain;
            gain.gain.setValueCurveAtTime(curve, startAt + (fadeOutStart - elapsedMs) / 1000, clip.fadeOutMs / 1000);
          } else if (clip.fadeOutMs > 0) {
            // Resuming inside the fade-out: curve from the current position.
            const curve = fadeCurveSamples(fadeShape, remainingMs / clip.fadeOutMs, 0, 65);
            for (let i = 0; i < curve.length; i += 1) curve[i] *= baseGain;
            gain.gain.setValueCurveAtTime(curve, startAt, remainingMs / 1000);
          }
        }
        source.start(startAt, (clip.sourceOffsetMs + elapsedMs) / 1000, remainingMs / 1000);
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
          panner?.disconnect();
          graphNodes.current.delete(source);
          graphNodes.current.delete(gain);
          if (panner) graphNodes.current.delete(panner);
        };
        scheduled.current.push({ source, gain });
      }
    }
    origin.current = { contextTime: audio.currentTime, positionMs: startMs };
    pendingStartMs.current = null;
    setPending(false);
    return true;
  }, [clear, ensureBuffer, ensureContext, supplementalAssets]);

  const failPreview = useCallback((cause: unknown, generation: number) => {
    if (generation !== playbackGeneration.current) return;
    pendingStartMs.current = null;
    currentState.current = null;
    clear();
    setPending(false);
    setPlaying(false);
    setError(cause instanceof Error ? cause.message : "Arrangement preview could not start.");
  }, [clear]);

  const pause = useCallback(() => {
    if (!context.current && pendingStartMs.current === null) return;
    const next = pendingStartMs.current ?? (
      origin.current.positionMs + ((context.current?.currentTime ?? origin.current.contextTime) - origin.current.contextTime) * 1000
    );
    playbackGeneration.current += 1;
    pendingStartMs.current = null;
    currentState.current = null;
    clear();
    origin.current = { contextTime: context.current?.currentTime ?? 0, positionMs: next };
    onPosition(next);
    setPending(false);
    setPlaying(false);
  }, [clear, onPosition]);

  const startClock = useCallback((generation: number) => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    const tick = () => {
      if (generation !== playbackGeneration.current) return;
      const active = currentState.current;
      const audio = context.current;
      if (!active || !audio) return;
      const positionMs = origin.current.positionMs + (audio.currentTime - origin.current.contextTime) * 1000;
      if (active.loopEndMs !== null && active.loopEndMs > active.loopStartMs && positionMs >= active.loopEndMs) {
        void schedule(active, active.loopStartMs, generation)
          .then((loopScheduled) => {
            if (loopScheduled && generation === playbackGeneration.current) startClock(generation);
          })
          .catch((cause) => failPreview(cause, generation));
        return;
      }
      const endMs = Math.max(0, ...active.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStartMs + clip.durationMs)));
      if (positionMs >= endMs) { pause(); return; }
      onPosition(positionMs);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [failPreview, onPosition, pause, schedule]);

  const play = useCallback(async (state: PreviewState, fromMs: number) => {
    const generation = ++playbackGeneration.current;
    pendingStartMs.current = fromMs;
    currentState.current = state;
    setPending(true);
    try {
      setError(null);
      const audio = ensureContext();
      if (audio.state === "suspended") await audio.resume();
      if (audio.state !== "running")
        throw new Error("Audio playback was interrupted. Activate Preview arrangement to resume.");
      if (generation !== playbackGeneration.current) return;
      const didSchedule = await schedule(state, fromMs, generation);
      if (!didSchedule || generation !== playbackGeneration.current) return;
      setPlaying(true);
      startClock(generation);
    } catch (cause) {
      const blocked = typeof cause === "object" && cause !== null && "name" in cause && cause.name === "NotAllowedError";
      failPreview(
        blocked ? new Error("Audio playback was interrupted. Activate Preview arrangement to resume.") : cause,
        generation,
      );
    }
  }, [ensureContext, failPreview, schedule, startClock]);

  const seek = useCallback((positionMs: number) => {
    const active = currentState.current;
    if (!active || (!playing && !pending)) return;
    void play(active, Math.max(0, positionMs));
  }, [pending, play, playing]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== "visible") {
        wasBackgrounded.current = true;
        return;
      }
      const returnedFromBackground = wasBackgrounded.current;
      wasBackgrounded.current = false;
      if (recoveryInFlight.current || pendingStartMs.current !== null) return;
      const active = currentState.current;
      const audio = context.current;
      if (!active || !audio || (!returnedFromBackground && audio.state === "running")) return;

      const generation = playbackGeneration.current;
      const resumeAt =
        origin.current.positionMs +
        (audio.currentTime - origin.current.contextTime) * 1000;
      setPlaying(false);
      recoveryInFlight.current = true;
      void (async () => {
        try {
          if (audio.state !== "running") await audio.resume();
          if (audio.state !== "running")
            throw new Error("Audio did not resume after the app returned.");
          if (generation !== playbackGeneration.current || currentState.current !== active) return;
          const didSchedule = await schedule(active, resumeAt, generation);
          if (didSchedule && generation === playbackGeneration.current) {
            setPlaying(true);
            startClock(generation);
          }
        } catch {
          failPreview(
            new Error("Audio couldn't resume automatically. Activate Preview arrangement to try again."),
            generation,
          );
        } finally {
          recoveryInFlight.current = false;
        }
      })();
    };
    recoverAudioContext.current = recover;
    document.addEventListener("visibilitychange", recover);
    window.addEventListener("pageshow", recover);
    window.addEventListener("focus", recover);
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    mediaDevices?.addEventListener("devicechange", recover);
    return () => {
      document.removeEventListener("visibilitychange", recover);
      window.removeEventListener("pageshow", recover);
      window.removeEventListener("focus", recover);
      mediaDevices?.removeEventListener("devicechange", recover);
      recoverAudioContext.current = () => undefined;
    };
  }, [failPreview, schedule, startClock]);

  const stop = useCallback(() => {
    playbackGeneration.current += 1;
    pendingStartMs.current = null;
    currentState.current = null;
    clear();
    origin.current = { contextTime: 0, positionMs: 0 };
    onPosition(0);
    setPending(false);
    setPlaying(false);
  }, [clear, onPosition]);
  useEffect(() => () => {
    playbackGeneration.current += 1;
    pendingStartMs.current = null;
    clear();
    void context.current?.close();
  }, [clear]);
  return { playing, pending, error, play, pause, seek, stop };
}
