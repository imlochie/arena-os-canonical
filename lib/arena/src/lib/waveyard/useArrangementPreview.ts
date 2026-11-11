"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clipFadeShapeOrLinear, fadeCurveSamples, fadeGainAt } from "./fades";
import { clearArrangementPreviewGraph } from "./arrangement-preview-graph";
import { selectArrangementPreviewTracks } from "./arrangement-preview-selection";
import { arrangementPreviewGainCurve, hasArrangementVolumeAutomation } from "./arrangement-preview-gain";
import {
  ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
  ARRANGEMENT_PREVIEW_MAX_STREAM_ASSET_BYTES,
  arrangementPreviewBufferBytes,
  estimateArrangementPreviewMemory,
  estimateArrangementPreviewSegmentMemory,
  estimateArrangementPreviewStreamingMemory,
  formatArrangementPreviewMiB,
  releaseInactiveArrangementPreviewBuffers,
  type ArrangementPreviewAssetMetadata,
} from "./arrangement-preview-memory";
import {
  parseHttpContentRange,
  parsePcm16WavHeader,
  pcm16WavSegmentRange,
  type Pcm16WavHeader,
} from "./arrangement-preview-segments";
import type { RemixTrackInput } from "./remix";
import type { RemixAutomationLane } from "./types/arrangement-automation";

type PreviewClip = RemixTrackInput["clips"][number];
type PreviewTrack = RemixTrackInput;
type PreviewState = {
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: PreviewTrack[];
  automation?: RemixAutomationLane[];
  previewAssets?: ArrangementPreviewAssetMetadata[];
};

const EMPTY_PREVIEW_ASSETS: ArrangementPreviewAssetMetadata[] = [];
const PREVIEW_SEGMENT_MS = 5_000;
const PREVIEW_LOOKAHEAD_SEGMENTS = 3;
type ScheduledSource = {
  source?: AudioBufferSourceNode;
  media?: HTMLAudioElement;
  mediaSource?: MediaElementAudioSourceNode;
  gain: GainNode;
  panner?: StereoPannerNode | null;
  startTimer?: number | null;
  stopTimer?: number | null;
  cleanup?: () => void;
};
type PlannedSegment = {
  key: string;
  assetId: string;
  clip: PreviewClip;
  track: PreviewTrack;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  clipElapsedMs: number;
};
type ReadySegment = PlannedSegment & { buffer: AudioBuffer };

function clipLevelAt(clip: PreviewClip, offsetMs: number) {
  const shape = clipFadeShapeOrLinear(clip.fadeShape);
  if (clip.fadeInMs > 0 && offsetMs < clip.fadeInMs) return fadeGainAt(shape, offsetMs / clip.fadeInMs);
  const fadeOutStart = clip.durationMs - clip.fadeOutMs;
  if (clip.fadeOutMs > 0 && offsetMs > fadeOutStart) return fadeGainAt(shape, (clip.durationMs - offsetMs) / clip.fadeOutMs);
  return 1;
}

function previewMimeTypeForCodec(codec: string) {
  const value = codec.trim().toLowerCase();
  if (/mp3|mpeg/.test(value)) return "audio/mpeg";
  if (/aac|mp4a/.test(value)) return "audio/mp4";
  if (/flac/.test(value)) return "audio/flac";
  if (/opus|vorbis/.test(value)) return "audio/ogg";
  if (/pcm|wav/.test(value)) return "audio/wav";
  return null;
}

function waitForMediaMetadata(media: HTMLAudioElement, signal: AbortSignal) {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error("The browser couldn't read this encoded audio file."));
    const onAbort = () => finish(new DOMException("Preview loading was cancelled.", "AbortError"));
    const timeout = window.setTimeout(
      () => finish(new Error("Studio timed out loading the encoded audio preview.")),
      15_000,
    );
    media.addEventListener("loadedmetadata", onLoaded, { once: true });
    media.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function seekMediaElement(media: HTMLAudioElement, seconds: number, signal: AbortSignal) {
  if (seconds <= 0.02 || Math.abs(media.currentTime - seconds) <= 0.02) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error("Studio couldn't seek within the encoded audio preview."));
    const onAbort = () => finish(new DOMException("Preview loading was cancelled.", "AbortError"));
    const timeout = window.setTimeout(
      () => finish(new Error("Studio timed out seeking within the encoded audio preview.")),
      15_000,
    );
    media.addEventListener("seeked", onSeeked, { once: true });
    media.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      media.currentTime = seconds;
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Studio couldn't seek within the encoded audio preview."));
    }
  });
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
  const wavHeaders = useRef(new Map<string, Pcm16WavHeader>());
  const scheduled = useRef<ScheduledSource[]>([]);
  const mediaElements = useRef(new Set<HTMLAudioElement>());
  const mediaAbort = useRef<AbortController | null>(null);
  const graphNodes = useRef(new Set<AudioNode>());
  const masterGain = useRef<GainNode | null>(null);
  const nextBufferKey = useRef(0);
  const scheduledUntilMs = useRef(0);
  const segmentedMode = useRef(false);
  const segmentPreparationInFlight = useRef(false);
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
    mediaAbort.current?.abort();
    mediaAbort.current = null;
    for (const item of [...scheduled.current]) {
      if (item.startTimer !== undefined && item.startTimer !== null) clearTimeout(item.startTimer);
      if (item.stopTimer !== undefined && item.stopTimer !== null) clearTimeout(item.stopTimer);
      if (item.cleanup) item.cleanup();
      if (item.source) {
        try { item.source.stop(); } catch { /* already finished */ }
        try { item.source.buffer = null; } catch { /* already released */ }
      }
      if (item.media) item.media.pause();
    }
    for (const media of mediaElements.current) {
      try {
        media.pause();
        media.removeAttribute("src");
        media.load();
      } catch {
        // A detached media element may already be releasing its decoder.
      }
    }
    mediaElements.current.clear();
    clearArrangementPreviewGraph(graphNodes.current);
    scheduled.current = [];
    masterGain.current = null;
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

  const ensurePcmWavHeader = useCallback(async (assetId: string, generation: number) => {
    const cached = wavHeaders.current.get(assetId);
    if (cached) return cached;
    const response = await fetch(`/api/assets/${assetId}`, {
      headers: { Range: "bytes=0-43" },
      cache: "no-store",
    });
    if (response.status !== 206) {
      throw new Error("Studio couldn't read a bounded PCM preview range for this stem.");
    }
    const contentRange = parseHttpContentRange(response.headers.get("content-range"));
    if (!contentRange || contentRange.start !== 0 || contentRange.end !== 43) {
      throw new Error("Studio received invalid byte-range metadata for this stem.");
    }
    const bytes = await response.arrayBuffer();
    const header = parsePcm16WavHeader(bytes, contentRange.total);
    if (!header) {
      throw new Error("This long source is not a supported PCM16 WAV stem. Separate it to a Waveyard stem before previewing.");
    }
    if (generation !== playbackGeneration.current) return null;
    wavHeaders.current.set(assetId, header);
    return header;
  }, []);

  const loadPcmWavSegment = useCallback(async (
    audio: AudioContext,
    segment: PlannedSegment,
    generation: number,
  ): Promise<ReadySegment | null> => {
    if (generation !== playbackGeneration.current) return null;
    const header = await ensurePcmWavHeader(segment.assetId, generation);
    if (!header || generation !== playbackGeneration.current) return null;
    const range = pcm16WavSegmentRange(header, segment.sourceOffsetMs, segment.durationMs);
    if (!range) return null;
    const response = await fetch(`/api/assets/${segment.assetId}`, {
      headers: { Range: `bytes=${range.byteStart}-${range.byteEnd}` },
      cache: "no-store",
    });
    if (response.status !== 206) {
      throw new Error("Studio couldn't load a bounded audio segment. Check the asset storage range support and try again.");
    }
    const contentRange = parseHttpContentRange(response.headers.get("content-range"));
    if (!contentRange || contentRange.start !== range.byteStart || contentRange.end !== range.byteEnd) {
      throw new Error("Studio received an audio range that does not match the requested clip position.");
    }
    const encoded = await response.arrayBuffer();
    if (encoded.byteLength !== range.frameCount * header.blockAlign) {
      throw new Error("Studio received an incomplete PCM preview segment.");
    }
    if (generation !== playbackGeneration.current) return null;

    const buffer = audio.createBuffer(header.channels, range.frameCount, header.sampleRate);
    const view = new DataView(encoded);
    for (let channel = 0; channel < header.channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < range.frameCount; frame += 1) {
        output[frame] = view.getInt16(frame * header.blockAlign + channel * 2, true) / 32768;
      }
    }
    const key = `segment:${generation}:${nextBufferKey.current++}`;
    buffers.current.set(key, buffer);
    return {
      ...segment,
      key,
      buffer,
      sourceOffsetMs: range.sourceOffsetMs,
      durationMs: range.durationMs,
    };
  }, [ensurePcmWavHeader]);

  const planSegmentWindow = useCallback((
    tracks: PreviewTrack[],
    windowStartMs: number,
    windowEndMs: number,
    scheduleFromMs: number,
  ): PlannedSegment[] => {
    const plans: PlannedSegment[] = [];
    for (const track of tracks) {
      for (const clip of track.clips) {
        const timelineStartMs = Math.max(windowStartMs, scheduleFromMs, clip.timelineStartMs);
        const timelineEndMs = Math.min(windowEndMs, clip.timelineStartMs + clip.durationMs);
        if (timelineEndMs <= timelineStartMs) continue;
        plans.push({
          key: `plan:${nextBufferKey.current++}`,
          assetId: clip.stemAssetId,
          clip,
          track,
          timelineStartMs,
          durationMs: timelineEndMs - timelineStartMs,
          sourceOffsetMs: clip.sourceOffsetMs + timelineStartMs - clip.timelineStartMs,
          clipElapsedMs: timelineStartMs - clip.timelineStartMs,
        });
      }
    }
    return plans;
  }, []);

  const checkSegmentMemory = useCallback((
    plans: PlannedSegment[],
    metadataById: Map<string, ArrangementPreviewAssetMetadata>,
    audio: AudioContext,
  ) => {
    const requests = plans.map((plan) => {
      const asset = metadataById.get(plan.assetId);
      if (!asset) return { assetId: plan.assetId, durationMs: plan.durationMs, encodedBytes: 0 };
      const frames = Math.ceil(plan.durationMs * asset.sampleRate / 1_000);
      return {
        assetId: plan.assetId,
        durationMs: plan.durationMs,
        encodedBytes: frames * asset.channels * 2,
      };
    });
    const estimate = estimateArrangementPreviewSegmentMemory(
      requests,
      [...metadataById.values()],
      audio.sampleRate,
      arrangementPreviewBufferBytes(buffers.current),
    );
    if (!estimate.ok) {
      throw new Error(
        "Studio can't safely estimate this preview window. Reopen the session to refresh its stem details, then try again.",
      );
    }
    if (estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
      throw new Error(
        `This preview window is estimated to need ${formatArrangementPreviewMiB(estimate.estimatedPeakBytes)} MiB, above Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB safety limit. Mute or solo fewer stems, or reduce overlapping clips.`,
      );
    }
  }, []);

  const loadSegmentPlans = useCallback(async (
    plans: PlannedSegment[],
    audio: AudioContext,
    generation: number,
  ) => {
    const ready: ReadySegment[] = [];
    for (const plan of plans) {
      if (generation !== playbackGeneration.current) return null;
      const segment = await loadPcmWavSegment(audio, plan, generation);
      if (generation !== playbackGeneration.current) return null;
      if (segment) ready.push(segment);
      if (arrangementPreviewBufferBytes(buffers.current) > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
        throw new Error(
          `Decoded preview windows exceeded Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB memory ceiling.`,
        );
      }
    }
    return ready;
  }, [loadPcmWavSegment]);

  const scheduleReadySegments = useCallback((
    ready: ReadySegment[],
    state: PreviewState,
    audio: AudioContext,
    generation: number,
  ) => {
    let master = masterGain.current;
    if (!master) {
      master = audio.createGain();
      master.gain.value = state.masterVolume;
      master.connect(audio.destination);
      graphNodes.current.add(master);
      masterGain.current = master;
    }
    for (const segment of ready) {
      if (generation !== playbackGeneration.current) return;
      const intendedStartAt = origin.current.contextTime
        + (segment.timelineStartMs - origin.current.positionMs) / 1_000;
      const lateMs = Math.max(0, (audio.currentTime - intendedStartAt) * 1_000);
      if (lateMs >= segment.durationMs) {
        buffers.current.delete(segment.key);
        continue;
      }
      const startAt = Math.max(audio.currentTime, intendedStartAt);
      const sourceOffsetSeconds = lateMs / 1_000;
      const remainingMs = segment.durationMs - lateMs;
      const playDurationSeconds = Math.min(remainingMs / 1_000, segment.buffer.duration - sourceOffsetSeconds);
      if (playDurationSeconds <= 0) {
        buffers.current.delete(segment.key);
        continue;
      }
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      const panner = "createStereoPanner" in audio ? audio.createStereoPanner() : null;
      graphNodes.current.add(source);
      graphNodes.current.add(gain);
      if (panner) graphNodes.current.add(panner);
      source.buffer = segment.buffer;
      source.connect(gain);
      if (panner) { gain.connect(panner); panner.pan.value = segment.track.pan; panner.connect(master); }
      else gain.connect(master);

      const clipElapsedMs = segment.clipElapsedMs + lateMs;
      const curve = arrangementPreviewGainCurve({
        trackId: segment.track.id,
        trackVolume: segment.track.volume,
        automation: state.automation,
        clip: segment.clip,
        clipElapsedMs,
        timelineStartMs: segment.timelineStartMs + lateMs,
        durationMs: remainingMs,
        samples: Math.max(33, Math.ceil(remainingMs / 20) + 1),
      });
      gain.gain.setValueCurveAtTime(curve, startAt, playDurationSeconds);
      source.start(startAt, sourceOffsetSeconds, playDurationSeconds);
      source.onended = () => {
        source.disconnect();
        source.buffer = null;
        gain.disconnect();
        panner?.disconnect();
        graphNodes.current.delete(source);
        graphNodes.current.delete(gain);
        if (panner) graphNodes.current.delete(panner);
        if (buffers.current.get(segment.key) === segment.buffer) buffers.current.delete(segment.key);
        scheduled.current = scheduled.current.filter((item) => item.source !== source);
      };
      scheduled.current.push({ source, gain });
    }
  }, []);

  const prepareSegmentWindow = useCallback(async (
    state: PreviewState,
    windowStartMs: number,
    windowEndMs: number,
    scheduleFromMs: number,
    generation: number,
    audio: AudioContext,
    metadataById: Map<string, ArrangementPreviewAssetMetadata>,
  ) => {
    const { audibleTracks } = selectArrangementPreviewTracks(state.tracks);
    const plans = planSegmentWindow(audibleTracks, windowStartMs, windowEndMs, scheduleFromMs);
    checkSegmentMemory(plans, metadataById, audio);
    const ready = await loadSegmentPlans(plans, audio, generation);
    if (!ready || generation !== playbackGeneration.current) return false;
    scheduleReadySegments(ready, state, audio, generation);
    return true;
  }, [checkSegmentMemory, loadSegmentPlans, planSegmentWindow, scheduleReadySegments]);

  const scheduleMediaPlans = useCallback(async (
    plans: PlannedSegment[],
    state: PreviewState,
    startMs: number,
    audio: AudioContext,
    generation: number,
  ) => {
    const aborter = new AbortController();
    mediaAbort.current = aborter;
    let master = masterGain.current;
    if (!master) {
      master = audio.createGain();
      master.gain.value = state.masterVolume;
      master.connect(audio.destination);
      graphNodes.current.add(master);
      masterGain.current = master;
    }

    const release = (item: ScheduledSource) => {
      if (item.startTimer !== undefined && item.startTimer !== null) clearTimeout(item.startTimer);
      if (item.stopTimer !== undefined && item.stopTimer !== null) clearTimeout(item.stopTimer);
      item.startTimer = null;
      item.stopTimer = null;
      if (item.media) {
        item.media.pause();
        item.media.removeAttribute("src");
        try { item.media.load(); } catch { /* decoder may already be detached */ }
        mediaElements.current.delete(item.media);
      }
      for (const node of [item.mediaSource, item.gain, item.panner]) {
        if (!node) continue;
        try { node.disconnect(); } catch { /* already detached */ }
        graphNodes.current.delete(node);
      }
      scheduled.current = scheduled.current.filter((candidate) => candidate !== item);
    };
    const failDelayedPlay = (cause: unknown) => {
      if (generation !== playbackGeneration.current) return;
      pendingStartMs.current = null;
      currentState.current = null;
      clear();
      setPending(false);
      setPlaying(false);
      setError(cause instanceof Error ? cause.message : "Encoded arrangement preview could not start.");
    };

    const ready: Array<{
      plan: PlannedSegment;
      item: ScheduledSource;
      playDurationMs: number;
    }> = [];
    try {
      for (const plan of plans) {
        if (generation !== playbackGeneration.current) return null;
        const asset = [...(state.previewAssets ?? []), ...supplementalAssets]
          .find((candidate) => candidate.id === plan.assetId);
        const mimeType = asset?.codec ? previewMimeTypeForCodec(asset.codec) : null;
        if (!mimeType) {
          throw new Error("Studio can't safely stream this audio format. Convert it to PCM WAV or refresh its audio details.");
        }
        const media = document.createElement("audio");
        media.preload = "metadata";
        if (!media.canPlayType(mimeType)) {
          throw new Error(`This browser can't preview ${asset?.codec ?? "this encoded audio format"}.`);
        }
        media.src = `/api/assets/${encodeURIComponent(plan.assetId)}`;
        mediaElements.current.add(media);
        media.load();
        await waitForMediaMetadata(media, aborter.signal);
        if (generation !== playbackGeneration.current) return null;
        if (!Number.isFinite(media.duration) || media.duration <= 0) {
          throw new Error("The encoded audio file has no readable duration.");
        }
        const sourceOffsetSeconds = plan.sourceOffsetMs / 1_000;
        if (sourceOffsetSeconds >= media.duration) continue;
        await seekMediaElement(media, sourceOffsetSeconds, aborter.signal);
        if (generation !== playbackGeneration.current) return null;
        const source = audio.createMediaElementSource(media);
        const gain = audio.createGain();
        const panner = "createStereoPanner" in audio ? audio.createStereoPanner() : null;
        graphNodes.current.add(source);
        graphNodes.current.add(gain);
        if (panner) graphNodes.current.add(panner);
        source.connect(gain);
        if (panner) {
          gain.connect(panner);
          panner.pan.value = plan.track.pan;
          panner.connect(master);
        } else gain.connect(master);

        const item: ScheduledSource = {
          media,
          mediaSource: source,
          gain,
          panner,
          startTimer: null,
          stopTimer: null,
        };
        item.cleanup = () => release(item);
        scheduled.current.push(item);
        const remainingMediaMs = Math.max(0, (media.duration * 1_000) - plan.sourceOffsetMs);
        ready.push({
          plan,
          item,
          playDurationMs: Math.min(plan.durationMs, remainingMediaMs),
        });
      }

      if (generation !== playbackGeneration.current) return null;
      const startContextTime = audio.currentTime + 0.03;
      const immediatePlay: Promise<void>[] = [];
      for (const { plan, item, playDurationMs } of ready) {
        const media = item.media!;
        const delayMs = Math.max(0, plan.timelineStartMs - startMs);
        const startAt = startContextTime + delayMs / 1_000;
        const remainingMs = playDurationMs;
        const clipElapsedMs = plan.clipElapsedMs;
        const baseGain = plan.track.volume * plan.clip.gain;
        item.gain.gain.setValueAtTime(0, audio.currentTime);
        if (hasArrangementVolumeAutomation(state.automation, plan.track.id)) {
          const curve = arrangementPreviewGainCurve({
            trackId: plan.track.id,
            trackVolume: plan.track.volume,
            automation: state.automation,
            clip: plan.clip,
            clipElapsedMs,
            timelineStartMs: plan.timelineStartMs,
            durationMs: remainingMs,
            samples: Math.max(65, Math.ceil(remainingMs / 20) + 1),
          });
          item.gain.gain.setValueCurveAtTime(curve, startAt, remainingMs / 1_000);
        } else {
          const initialGain = baseGain * clipLevelAt(plan.clip, clipElapsedMs);
          item.gain.gain.setValueAtTime(initialGain, startAt);
          const fadeShape = clipFadeShapeOrLinear(plan.clip.fadeShape);
          const fadeOutStart = plan.clip.durationMs - plan.clip.fadeOutMs;
          if (fadeShape === "linear") {
            if (plan.clip.fadeInMs > clipElapsedMs) {
              item.gain.gain.linearRampToValueAtTime(
                baseGain,
                startAt + (plan.clip.fadeInMs - clipElapsedMs) / 1_000,
              );
            }
            if (plan.clip.fadeOutMs > 0) {
              const untilFadeMs = fadeOutStart - clipElapsedMs;
              const endAt = startAt + remainingMs / 1_000;
              if (untilFadeMs > 0) {
                item.gain.gain.setValueAtTime(baseGain, startAt + untilFadeMs / 1_000);
              }
              item.gain.gain.linearRampToValueAtTime(0, endAt);
            }
          } else {
            if (plan.clip.fadeInMs > clipElapsedMs) {
              const curve = fadeCurveSamples(fadeShape, clipElapsedMs / plan.clip.fadeInMs, 1, 65);
              for (let index = 0; index < curve.length; index += 1) curve[index] *= baseGain;
              item.gain.gain.setValueCurveAtTime(
                curve,
                startAt,
                (plan.clip.fadeInMs - clipElapsedMs) / 1_000,
              );
            }
            if (plan.clip.fadeOutMs > 0 && fadeOutStart > clipElapsedMs) {
              const curve = fadeCurveSamples(fadeShape, 1, 0, 65);
              for (let index = 0; index < curve.length; index += 1) curve[index] *= baseGain;
              item.gain.gain.setValueCurveAtTime(
                curve,
                startAt + (fadeOutStart - clipElapsedMs) / 1_000,
                plan.clip.fadeOutMs / 1_000,
              );
            } else if (plan.clip.fadeOutMs > 0) {
              const curve = fadeCurveSamples(fadeShape, remainingMs / plan.clip.fadeOutMs, 0, 65);
              for (let index = 0; index < curve.length; index += 1) curve[index] *= baseGain;
              item.gain.gain.setValueCurveAtTime(curve, startAt, remainingMs / 1_000);
            }
          }
        }

        item.stopTimer = window.setTimeout(() => release(item), delayMs + playDurationMs);
        if (delayMs === 0) {
          immediatePlay.push(media.play());
        } else {
          item.startTimer = window.setTimeout(() => {
            item.startTimer = null;
            void media.play().catch(failDelayedPlay);
          }, delayMs);
        }
      }
      await Promise.all(immediatePlay);
      if (generation !== playbackGeneration.current) return null;
      origin.current = { contextTime: startContextTime, positionMs: startMs };
      return startContextTime;
    } catch (cause) {
      if (generation === playbackGeneration.current) {
        for (const item of [...scheduled.current]) item.cleanup?.();
        for (const media of mediaElements.current) {
          media.pause();
          media.removeAttribute("src");
          try { media.load(); } catch { /* decoder may already be detached */ }
        }
        mediaElements.current.clear();
        clearArrangementPreviewGraph(graphNodes.current);
        scheduled.current = [];
        masterGain.current = null;
      }
      throw cause;
    }
  }, [clear, supplementalAssets]);

  const schedule = useCallback(async (state: PreviewState, startMs: number, generation: number) => {
    if (generation !== playbackGeneration.current) return false;
    pendingStartMs.current = startMs;
    setPending(true);
    segmentPreparationInFlight.current = false;
    const audio = ensureContext();
    const { audibleTracks, assetIds } = selectArrangementPreviewTracks(state.tracks);
    const activeAssetIds = new Set(assetIds);
    clear();
    await decodeQueue.current;
    if (generation !== playbackGeneration.current) return false;

    const metadataById = new Map(
      [...supplementalAssets, ...(state.previewAssets ?? [])].map((asset) => [asset.id, asset]),
    );
    const metadata = [...metadataById.values()];
    const estimate = estimateArrangementPreviewMemory(assetIds, metadata, audio.sampleRate);
    if (!estimate.ok) {
      buffers.current.clear();
      throw new Error(
        "Studio can't safely estimate the memory needed for this arrangement. Reopen the session to refresh its audio details, then try again.",
      );
    }

    if (estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
      const hasEncodedCodec = assetIds.some((assetId) => {
        const codec = metadataById.get(assetId)?.codec;
        return Boolean(codec && !/^(pcm|wav)/i.test(codec.trim()));
      });
      const mediaCodecsKnown = assetIds.every((assetId) => {
        const codec = metadataById.get(assetId)?.codec;
        return typeof codec === "string" && Boolean(previewMimeTypeForCodec(codec));
      });
      if (hasEncodedCodec && mediaCodecsKnown) {
        const endMs = Math.max(0, ...state.tracks.flatMap((track) =>
          track.clips.map((clip) => clip.timelineStartMs + clip.durationMs),
        ));
        const streamEndMs = Math.min(
          endMs,
          state.loopEndMs !== null && state.loopEndMs > startMs ? state.loopEndMs : Infinity,
        );
        const mediaPlans = planSegmentWindow(audibleTracks, startMs, streamEndMs, startMs);
        const streamEstimate = estimateArrangementPreviewStreamingMemory(
          mediaPlans.map((plan) => plan.assetId),
          metadata,
          audio.sampleRate,
        );
        if (!streamEstimate.ok) {
          buffers.current.clear();
          if (streamEstimate.reason === "asset-too-large") {
            throw new Error(
              `This encoded file is larger than Studio's safe ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MAX_STREAM_ASSET_BYTES)} MiB streaming limit.`,
            );
          }
          throw new Error("Studio can't safely estimate the memory needed to stream this arrangement. Refresh its audio details and try again.");
        }
        if (streamEstimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
          buffers.current.clear();
          throw new Error(
            `This arrangement exceeds Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB streaming preview budget.`,
          );
        }
        buffers.current.clear();
        segmentedMode.current = false;
        scheduledUntilMs.current = 0;
        const streamStart = await scheduleMediaPlans(mediaPlans, state, startMs, audio, generation);
        if (streamStart === null || generation !== playbackGeneration.current) return false;
        pendingStartMs.current = null;
        setPending(false);
        return true;
      }

      segmentedMode.current = true;
      buffers.current.clear();
      const endMs = Math.max(0, ...state.tracks.flatMap((track) =>
        track.clips.map((clip) => clip.timelineStartMs + clip.durationMs),
      ));
      const segmentEndMs = Math.min(
        endMs,
        state.loopEndMs !== null && state.loopEndMs > startMs ? state.loopEndMs : Infinity,
      );
      const initialEndMs = Math.min(
        segmentEndMs,
        startMs + PREVIEW_SEGMENT_MS * PREVIEW_LOOKAHEAD_SEGMENTS,
      );
      const plans: PlannedSegment[] = [];
      for (let windowStartMs = startMs; windowStartMs < initialEndMs; windowStartMs += PREVIEW_SEGMENT_MS) {
        plans.push(...planSegmentWindow(
          audibleTracks,
          windowStartMs,
          Math.min(initialEndMs, windowStartMs + PREVIEW_SEGMENT_MS),
          startMs,
        ));
      }
      checkSegmentMemory(plans, metadataById, audio);
      const ready = await loadSegmentPlans(plans, audio, generation);
      if (!ready || generation !== playbackGeneration.current) return false;
      origin.current = { contextTime: audio.currentTime + 0.03, positionMs: startMs };
      scheduledUntilMs.current = initialEndMs;
      scheduleReadySegments(ready, state, audio, generation);
      pendingStartMs.current = null;
      setPending(false);
      return true;
    }

    segmentedMode.current = false;
    scheduledUntilMs.current = 0;
    releaseInactiveArrangementPreviewBuffers(buffers.current, activeAssetIds);
    if (estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
      buffers.current.clear();
      throw new Error(
        `This arrangement needs more than Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB browser preview budget.`,
      );
    }
    for (const assetId of assetIds) {
      if (generation !== playbackGeneration.current) return false;
      const buffer = await ensureBuffer(assetId, generation);
      if (generation !== playbackGeneration.current || !buffer) return false;
      if (arrangementPreviewBufferBytes(buffers.current) > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES) {
        buffers.current.clear();
        throw new Error(
          `The decoded audio exceeded Studio's ${formatArrangementPreviewMiB(ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES)} MiB preview safety limit.`,
        );
      }
    }
    if (generation !== playbackGeneration.current) return false;
    const master = audio.createGain();
    master.gain.value = state.masterVolume;
    master.connect(audio.destination);
    graphNodes.current.add(master);
    masterGain.current = master;
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
        const startAt = audio.currentTime + Math.max(0, (clip.timelineStartMs - startMs) / 1000);
        const remainingMs = clip.durationMs - elapsedMs;
        if (hasArrangementVolumeAutomation(state.automation, track.id)) {
          gain.gain.setValueAtTime(0, audio.currentTime);
          gain.gain.setValueCurveAtTime(arrangementPreviewGainCurve({
            trackId: track.id,
            trackVolume: track.volume,
            automation: state.automation,
            clip,
            clipElapsedMs: elapsedMs,
            timelineStartMs: clip.timelineStartMs + elapsedMs,
            durationMs: remainingMs,
            samples: Math.max(65, Math.ceil(remainingMs / 20) + 1),
          }), startAt, remainingMs / 1_000);
        } else {
          const baseGain = track.volume * clip.gain;
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
              const curve = fadeCurveSamples(fadeShape, remainingMs / clip.fadeOutMs, 0, 65);
              for (let i = 0; i < curve.length; i += 1) curve[i] *= baseGain;
              gain.gain.setValueCurveAtTime(curve, startAt, remainingMs / 1000);
            }
          }
        }
        source.start(startAt, (clip.sourceOffsetMs + elapsedMs) / 1000, remainingMs / 1000);
        source.onended = () => {
          source.disconnect();
          source.buffer = null;
          gain.disconnect();
          panner?.disconnect();
          graphNodes.current.delete(source);
          graphNodes.current.delete(gain);
          if (panner) graphNodes.current.delete(panner);
          scheduled.current = scheduled.current.filter((item) => item.source !== source);
        };
        scheduled.current.push({ source, gain });
      }
    }
    origin.current = { contextTime: audio.currentTime, positionMs: startMs };
    pendingStartMs.current = null;
    setPending(false);
    return true;
  }, [
    checkSegmentMemory,
    clear,
    ensureBuffer,
    ensureContext,
    loadSegmentPlans,
    planSegmentWindow,
    scheduleMediaPlans,
    scheduleReadySegments,
    supplementalAssets,
  ]);

  const failPreview = useCallback((cause: unknown, generation: number) => {
    if (generation !== playbackGeneration.current) return;
    pendingStartMs.current = null;
    currentState.current = null;
    clear();
    buffers.current.clear();
    segmentedMode.current = false;
    scheduledUntilMs.current = 0;
    segmentPreparationInFlight.current = false;
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
    if (segmentedMode.current) buffers.current.clear();
    segmentedMode.current = false;
    scheduledUntilMs.current = 0;
    segmentPreparationInFlight.current = false;
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
      const naturalEndMs = Math.max(0, ...active.tracks.flatMap((track) =>
        track.clips.map((clip) => clip.timelineStartMs + clip.durationMs),
      ));
      const endMs = active.loopEndMs !== null && active.loopEndMs > active.loopStartMs
        ? Math.min(naturalEndMs, active.loopEndMs)
        : naturalEndMs;
      if (positionMs >= endMs) { pause(); return; }
      onPosition(positionMs);
      if (
        segmentedMode.current &&
        !segmentPreparationInFlight.current &&
        scheduledUntilMs.current < endMs &&
        scheduledUntilMs.current - positionMs <= PREVIEW_SEGMENT_MS * 2
      ) {
        const windowStartMs = scheduledUntilMs.current;
        const windowEndMs = Math.min(endMs, windowStartMs + PREVIEW_SEGMENT_MS);
        scheduledUntilMs.current = windowEndMs;
        segmentPreparationInFlight.current = true;
        const metadataById = new Map(
          [...supplementalAssets, ...(active.previewAssets ?? [])].map((asset) => [asset.id, asset]),
        );
        void prepareSegmentWindow(
          active,
          windowStartMs,
          windowEndMs,
          positionMs,
          generation,
          audio,
          metadataById,
        )
          .catch((cause) => failPreview(cause, generation))
          .finally(() => {
            if (generation === playbackGeneration.current) segmentPreparationInFlight.current = false;
          });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [failPreview, onPosition, pause, prepareSegmentWindow, schedule, supplementalAssets]);

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
    buffers.current.clear();
    segmentedMode.current = false;
    scheduledUntilMs.current = 0;
    segmentPreparationInFlight.current = false;
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
