"use client";

/**
 * CompareAB — the A//B showcase (vision: "an a // b comparison with album
 * covers and audiovisual comparisons to showcase remixes aesthetically on
 * youtube").
 *
 * Two slots (A // B): any source, stem, or arrangement layer — or a dropped
 * audio file. Each side shows its album cover: the REAL embedded artwork
 * when the MP3 carries it (parsed locally, no network), an uploaded image,
 * or a deterministic generative cover grown from the track's identity.
 *
 * The canvas is a split-screen audiovisual: A's spectrum flows left of the
 * divider, B's right of it, and dragging the divider live-crossfades the
 * audio (equal power). The showcase mode runs the YouTube timeline —
 * A solo → crossfade → B solo with the covers featured — and RECORDS it
 * (canvas + the comparison's own audio graph → MediaRecorder → .webm),
 * ready to upload.
 *
 * Pure logic (artwork parsing, covers, crossfade law, the timeline) lives
 * in the fully-tested lib/waveyard/studio/ab-compare.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildShowcasePlan,
  equalPowerCrossfade,
  parseId3Artwork,
  proceduralCoverSpec,
  showcaseDividerAt,
  type CoverSpec,
} from "@/lib/waveyard/studio/ab-compare";
import type { Stem, Source } from "./types";

type TransportLike = { pause(): void; playing: boolean };

type SlotKind = "source" | "stem" | "layer" | "file";
type Slot = { kind: SlotKind; id: string; label: string; sublabel: string; url: string; file?: File };

type LayerSummary = { id: string; instrument: string; audioUrl: string };

const A_COLOR = "#83e8ff";
const B_COLOR = "#d6fb54";
const COVER_PX = 600;
const ART_SCAN_BYTES = 262_144;

// ----------------------------------------------------------------- covers

type CoverArt = { image: CanvasImageSource | null; spec: CoverSpec | null; ready: boolean };

function drawSpecToCanvas(spec: CoverSpec): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = COVER_PX;
  canvas.height = COVER_PX;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return canvas;
  ctx.fillStyle = `hsl(${spec.backgroundHue} 42% 12%)`;
  ctx.fillRect(0, 0, COVER_PX, COVER_PX);
  const glow = ctx.createRadialGradient(COVER_PX / 2, COVER_PX / 2, 0, COVER_PX / 2, COVER_PX / 2, COVER_PX * 0.7);
  glow.addColorStop(0, `hsla(${spec.backgroundHue} 60% 30% 0.9)`);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, COVER_PX, COVER_PX);
  for (const shape of spec.shapes) {
    ctx.save();
    ctx.globalAlpha = shape.alpha;
    ctx.strokeStyle = ctx.fillStyle = `hsl(${shape.hue} 78% 62%)`;
    ctx.translate(shape.x * COVER_PX, shape.y * COVER_PX);
    ctx.rotate(shape.rotation);
    const size = shape.size * COVER_PX;
    if (shape.kind === "circle") {
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape.kind === "ring") {
      ctx.lineWidth = size * 0.06;
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shape.kind === "bar") {
      ctx.fillRect(-size / 2, -size * 0.08, size, size * 0.16);
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -size / 2);
      ctx.lineTo(size / 2, size / 2);
      ctx.lineTo(-size / 2, size / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  return canvas;
}

function imageFromBytes(mime: string, data: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([new Uint8Array(data)], { type: mime });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("cover decode failed")); };
    image.src = url;
  });
}

/** Resolve a slot's cover: embedded artwork → uploaded image → generative. */
function useCover(slot: Slot | null): CoverArt {
  const [art, setArt] = useState<CoverArt>({ image: null, spec: null, ready: false });
  useEffect(() => {
    let active = true;
    if (slot === null) {
      setArt({ image: null, spec: null, ready: false });
      return;
    }
    const fallback = () => {
      if (!active) return;
      setArt({ image: null, spec: proceduralCoverSpec(`${slot.kind}:${slot.id}:${slot.label}`, slot.label, slot.sublabel), ready: true });
    };
    void (async () => {
      try {
        let bytes: Uint8Array;
        if (slot.file !== undefined) {
          bytes = new Uint8Array(await slot.file.slice(0, ART_SCAN_BYTES).arrayBuffer());
        } else {
          const response = await fetch(slot.url, { headers: { Range: `bytes=0-${ART_SCAN_BYTES - 1}` } });
          if (!response.ok) { fallback(); return; }
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        const artwork = parseId3Artwork(bytes.length > ART_SCAN_BYTES ? bytes.subarray(0, ART_SCAN_BYTES) : bytes);
        if (artwork === null) { fallback(); return; }
        const image = await imageFromBytes(artwork.mime, artwork.data);
        if (!active) return;
        setArt({ image, spec: null, ready: true });
      } catch {
        fallback();
      }
    })();
    return () => { active = false; };
  }, [slot]);
  return art;
}

// ------------------------------------------------------------ component

export function CompareAB({ projectId, sources, stems, transport }: { projectId: string; sources: Source[]; stems: Stem[]; transport: TransportLike }) {
  const [slotA, setSlotA] = useState<Slot | null>(null);
  const [slotB, setSlotB] = useState<Slot | null>(null);
  const [layers, setLayers] = useState<LayerSummary[]>([]);
  const [divider, setDivider] = useState(0.5);
  const [mode, setMode] = useState<"manual" | "showcase">("manual");
  const [playing, setPlaying] = useState(false);
  const [showcaseActive, setShowcaseActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [volumeA, setVolumeA] = useState(0.9);
  const [volumeB, setVolumeB] = useState(0.9);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const gainARef = useRef<GainNode | null>(null);
  const gainBRef = useRef<GainNode | null>(null);
  const analyserARef = useRef<AnalyserNode | null>(null);
  const analyserBRef = useRef<AnalyserNode | null>(null);
  const streamDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const showcaseRef = useRef<{ start: number; plan: ReturnType<typeof buildShowcasePlan> } | null>(null);
  const liveRef = useRef({ divider, volumeA, volumeB, slotA, slotB, playing, mode, recording });
  const coverA = useCover(slotA);
  const coverB = useCover(slotB);

  useEffect(() => {
    liveRef.current = { divider, volumeA, volumeB, slotA, slotB, playing, mode, recording };
  }, [divider, volumeA, volumeB, slotA, slotB, playing, mode, recording]);

  // Layer list for the pickers.
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, { cache: "no-store" });
      if (!active || !response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (active) setLayers(body.layers ?? []);
    })();
    return () => { active = false; };
  }, [projectId]);

  // Default slots once data is visible: A = first source, B = first stem.
  useEffect(() => {
    setSlotA((current) => current ?? (sources[0] !== undefined ? slotFromSource(sources[0]) : null));
    setSlotB((current) => current ?? (stems[0] !== undefined ? slotFromStem(stems[0], sources) : null));
  }, [sources, stems]);

  const options = buildOptions(sources, stems, layers);

  const onPick = (side: "a" | "b", value: string) => {
    setError(null);
    const slot = resolveOption(value, sources, stems, layers);
    if (side === "a") setSlotA(slot);
    else setSlotB(slot);
  };

  const onFile = (side: "a" | "b", file: File) => {
    const slot: Slot = { kind: "file", id: `file-${file.name}-${file.size}`, label: file.name, sublabel: "local file", url: URL.createObjectURL(file), file };
    if (side === "a") setSlotA(slot);
    else setSlotB(slot);
  };

  const ensureGraph = useCallback(() => {
    if (ctxRef.current === null) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const makeSide = () => {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const gain = ctx.createGain();
        gain.connect(analyser);
        analyser.connect(master);
        return { analyser, gain };
      };
      const sideA = makeSide();
      const sideB = makeSide();
      const elementA = new Audio();
      const elementB = new Audio();
      elementA.crossOrigin = "anonymous";
      elementB.crossOrigin = "anonymous";
      const sourceA = ctx.createMediaElementSource(elementA);
      const sourceB = ctx.createMediaElementSource(elementB);
      sourceA.connect(sideA.gain);
      sourceB.connect(sideB.gain);
      ctxRef.current = ctx;
      audioARef.current = elementA;
      audioBRef.current = elementB;
      gainARef.current = sideA.gain;
      gainBRef.current = sideB.gain;
      analyserARef.current = sideA.analyser;
      analyserBRef.current = sideB.analyser;
    }
    return ctxRef.current;
  }, []);

  // Keep the audio elements' sources matched to the slots.
  useEffect(() => {
    if (audioARef.current !== null && slotA !== null && audioARef.current.src !== slotA.url) audioARef.current.src = slotA.url;
    if (audioBRef.current !== null && slotB !== null && audioBRef.current.src !== slotB.url) audioBRef.current.src = slotB.url;
  }, [slotA, slotB]);

  const stopPlayback = useCallback(() => {
    audioARef.current?.pause();
    audioBRef.current?.pause();
    setPlaying(false);
  }, []);

  const stopEverything = useCallback(() => {
    showcaseRef.current = null;
    setShowcaseActive(false);
    if (recorderRef.current !== null && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
    stopPlayback();
  }, [stopPlayback]);

  // The render + gain loop.
  useEffect(() => {
    let frame = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d === null) return;

      const live = liveRef.current;
      let effectiveDivider = live.divider;
      let phaseLabel: string | null = null;
      let progress: number | null = null;
      const showcase = showcaseRef.current;
      if (showcase !== null) {
        const elapsed = now - showcase.start;
        effectiveDivider = showcaseDividerAt(showcase.plan, elapsed);
        progress = Math.min(1, elapsed / showcase.plan.totalMs);
        const active = showcase.plan.phases.find((p) => elapsed >= p.startMs && elapsed < p.endMs) ?? showcase.plan.phases[showcase.plan.phases.length - 1];
        phaseLabel = active.phase === "a" ? "ORIGINAL" : active.phase === "crossfade" ? "A → B" : active.phase === "b" ? "REMIX" : null;
        if (elapsed >= showcase.plan.totalMs) {
          if (liveRef.current.recording) stopEverything();
          else { showcaseRef.current = null; setShowcaseActive(false); stopPlayback(); setMode("manual"); }
        }
      }

      // Live crossfade gains (equal power) × the side volumes.
      const gains = equalPowerCrossfade(effectiveDivider);
      if (gainARef.current !== null) gainARef.current.gain.value = gains.a * live.volumeA;
      if (gainBRef.current !== null) gainBRef.current.gain.value = gains.b * live.volumeB;

      // DPR-sharp backing store.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const box = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(box.width * dpr) || canvas.height !== Math.round(box.height * dpr)) {
        canvas.width = Math.max(1, Math.round(box.width * dpr));
        canvas.height = Math.max(1, Math.round(box.height * dpr));
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawComparison(ctx2d, box.width, box.height, {
        spectrumA: readSpectrum(analyserARef.current),
        spectrumB: readSpectrum(analyserBRef.current),
        divider: effectiveDivider,
        labelA: live.slotA?.label ?? "A",
        labelB: live.slotB?.label ?? "B",
        coverA: coverA.image ?? (coverA.spec !== null ? drawSpecToCanvas(coverA.spec) : null),
        coverB: coverB.image ?? (coverB.spec !== null ? drawSpecToCanvas(coverB.spec) : null),
        phaseLabel,
        progress,
      });
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [coverA.image, coverA.spec, coverB.image, coverB.spec, stopEverything, stopPlayback]);

  const startPlayback = useCallback(async () => {
    if (slotA === null || slotB === null) {
      setError("Pick (or drop) a track for both sides first.");
      return;
    }
    setError(null);
    setNotice(null);
    transport.pause();
    const ctx = ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();
    const a = audioARef.current!;
    const b = audioBRef.current!;
    if (a.src !== slotA.url) a.src = slotA.url;
    if (b.src !== slotB.url) b.src = slotB.url;
    try {
      await Promise.all([a.play(), b.play()]);
      setPlaying(true);
    } catch {
      setError("The browser blocked playback — click again to start.");
    }
  }, [ensureGraph, slotA, slotB, transport]);

  const startShowcase = useCallback(async (record: boolean) => {
    if (slotA === null || slotB === null) {
      setError("Pick (or drop) a track for both sides first.");
      return;
    }
    if (record && typeof MediaRecorder === "undefined") {
      setError("This browser cannot record video — Chrome or the desktop app can.");
      return;
    }
    setError(null);
    setNotice(null);
    if (videoUrl !== null) { URL.revokeObjectURL(videoUrl); setVideoUrl(null); }
    transport.pause();
    const ctx = ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();
    if (record && streamDestRef.current === null) {
      // The recorder's audio tap: each side's analyser output (post
      // crossfade gain) summed into one recording stream.
      streamDestRef.current = ctx.createMediaStreamDestination();
      analyserARef.current?.connect(streamDestRef.current);
      analyserBRef.current?.connect(streamDestRef.current);
    }
    const a = audioARef.current!;
    const b = audioBRef.current!;
    if (a.src !== slotA.url) a.src = slotA.url;
    if (b.src !== slotB.url) b.src = slotB.url;
    a.currentTime = 0;
    b.currentTime = 0;
    try {
      await Promise.all([a.play(), b.play()]);
    } catch {
      setError("The browser blocked playback — click again to start.");
      return;
    }
    setPlaying(true);
    const plan = buildShowcasePlan({});
    showcaseRef.current = { start: performance.now(), plan };
    setMode("showcase");
    setShowcaseActive(true);
    if (record) {
      const canvas = canvasRef.current;
      if (canvas === null || typeof canvas.captureStream !== "function") {
        setError("This browser cannot capture the canvas.");
        return;
      }
      const stream = canvas.captureStream(30);
      if (streamDestRef.current !== null) {
        for (const track of streamDestRef.current.stream.getAudioTracks()) stream.addTrack(track);
      }
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType !== undefined ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        setVideoUrl(URL.createObjectURL(blob));
        setNotice("Showcase recorded — the .webm downloads below and is ready for YouTube.");
      };
      recorder.start(250);
      recorderRef.current = recorder;
      setRecording(true);
    }
  }, [ensureGraph, slotA, slotB, transport, videoUrl]);

  const togglePlay = () => {
    if (playing) { stopEverything(); setMode("manual"); }
    else void startPlayback();
  };

  const onCanvasPointer = (event: React.PointerEvent<HTMLCanvasElement>, active: boolean) => {
    if (showcaseRef.current !== null) return; // the showcase owns the divider
    if (!active) return;
    const box = event.currentTarget.getBoundingClientRect();
    setDivider(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
  };

  const bothChosen = slotA !== null && slotB !== null;

  return (
    <section className="compare-ab" data-testid="compare-ab" aria-label="A B comparison">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Showcase</span>
          <h3>A // B comparison</h3>
        </div>
        <small>covers · split-screen audio · record for YouTube</small>
      </div>

      <div className="compare-pickers">
        <label>
          <span className="compare-side-a">A · original</span>
          <select aria-label="Side A track" value={slotA !== null && slotA.kind !== "file" ? `${slotA.kind}:${slotA.id}` : ""} onChange={(event) => onPick("a", event.target.value)}>
            <option value="">{slotA?.kind === "file" ? slotA.label : "Pick a track…"}</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <input aria-label="Side A audio file" type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) onFile("a", file); event.target.value = ""; }} />
        </label>
        <label>
          <span className="compare-side-b">B · remix / stem</span>
          <select aria-label="Side B track" value={slotB !== null && slotB.kind !== "file" ? `${slotB.kind}:${slotB.id}` : ""} onChange={(event) => onPick("b", event.target.value)}>
            <option value="">{slotB?.kind === "file" ? slotB.label : "Pick a track…"}</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <input aria-label="Side B audio file" type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) onFile("b", file); event.target.value = ""; }} />
        </label>
        <div className="compare-volumes">
          <label>A <input aria-label="Side A volume" type="range" min={0} max={1} step={0.01} value={volumeA} onChange={(event) => setVolumeA(Number(event.target.value))} style={{ accentColor: A_COLOR }} /></label>
          <label>B <input aria-label="Side B volume" type="range" min={0} max={1} step={0.01} value={volumeB} onChange={(event) => setVolumeB(Number(event.target.value))} style={{ accentColor: B_COLOR }} /></label>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <canvas
        ref={canvasRef}
        className={`compare-canvas ${playing ? "" : "idle"}`}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onCanvasPointer(event, true); }}
        onPointerMove={(event) => onCanvasPointer(event, event.buttons !== 0)}
        onPointerUp={(event) => onCanvasPointer(event, false)}
      />

      <div className="compare-actions">
        <button className="button" disabled={!bothChosen || recording} onClick={togglePlay}>
          {playing && !showcaseActive ? "Pause" : "Play both"}
        </button>
        <button className="button secondary" disabled={!bothChosen || recording} onClick={() => void startShowcase(false)}>
          Play A → B showcase
        </button>
        <button className="button" disabled={!bothChosen || recording} onClick={() => void startShowcase(true)}>
          {recording ? "Recording…" : "⏺ Record showcase (.webm)"}
        </button>
        <small>{mode === "showcase" ? "showcase running — the divider drives itself" : "drag the divider to crossfade live"}</small>
      </div>
      {notice && <p className="stem-layer-notice" role="status">{notice}</p>}
      {videoUrl !== null && (
        <div className="chop-render-result">
          <video controls src={videoUrl} />
          <a className="button" href={videoUrl} download="waveyard-comparison.webm">Download .webm</a>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- helpers

function readSpectrum(analyser: AnalyserNode | null): Uint8Array | null {
  if (analyser === null) return null;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  return bins;
}

function slotFromSource(source: Source): Slot {
  return { kind: "source", id: source.id, label: source.originalFilename, sublabel: "source", url: `/api/assets/${source.id}` };
}

function slotFromStem(stem: Stem, sources: Source[]): Slot {
  const owner = sources.find((source) => source.id === stem.sourceAssetId);
  const name = stem.stemType.split("/").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" · ");
  return { kind: "stem", id: stem.id, label: `${name} — ${owner?.originalFilename ?? "stem"}`, sublabel: "stem", url: `/api/assets/${stem.id}` };
}

function buildOptions(sources: Source[], stems: Stem[], layers: LayerSummary[]): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (const source of sources) options.push({ value: `source:${source.id}`, label: `♪ ${source.originalFilename}` });
  for (const stem of stems) options.push({ value: `stem:${stem.id}`, label: `▦ ${stem.stemType} · stem` });
  for (const layer of layers) options.push({ value: `layer:${layer.id}`, label: `♫ ${layer.instrument} · layer` });
  return options;
}

function resolveOption(value: string, sources: Source[], stems: Stem[], layers: LayerSummary[]): Slot | null {
  const [kind, id] = value.split(":");
  if (kind === "source") {
    const source = sources.find((item) => item.id === id);
    return source !== undefined ? slotFromSource(source) : null;
  }
  if (kind === "stem") {
    const stem = stems.find((item) => item.id === id);
    return stem !== undefined ? slotFromStem(stem, sources) : null;
  }
  if (kind === "layer") {
    const layer = layers.find((item) => item.id === id);
    return layer !== undefined ? { kind: "layer", id: layer.id, label: `${layer.instrument} layer`, sublabel: "arrangement layer", url: layer.audioUrl } : null;
  }
  return null;
}

function drawComparison(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  input: {
    spectrumA: Uint8Array | null;
    spectrumB: Uint8Array | null;
    divider: number;
    labelA: string;
    labelB: string;
    coverA: CanvasImageSource | null;
    coverB: CanvasImageSource | null;
    phaseLabel: string | null;
    progress: number | null;
  },
) {
  ctx.clearRect(0, 0, width, height);
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "#0b0f17");
  background.addColorStop(1, "#070a10");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const splitX = input.divider * width;

  const drawSide = (spectrum: Uint8Array | null, fromX: number, toX: number, color: string) => {
    if (spectrum === null || toX - fromX < 8) return;
    const barCount = Math.max(6, Math.min(72, Math.floor((toX - fromX) / 11)));
    const barWidth = (toX - fromX) / barCount;
    for (let bar = 0; bar < barCount; bar += 1) {
      // Log-ish bin sampling so bass doesn't eat the view.
      const bin = Math.min(spectrum.length - 1, Math.floor(Math.pow(bar / barCount, 1.6) * spectrum.length * 0.8));
      const value = spectrum[bin] / 255;
      const barHeight = value * height * 0.72;
      const x = fromX + bar * barWidth;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.28 + value * 0.7;
      ctx.fillRect(x + barWidth * 0.15, height - barHeight, barWidth * 0.7, barHeight);
    }
    ctx.globalAlpha = 1;
  };
  drawSide(input.spectrumA, 0, splitX, A_COLOR);
  drawSide(input.spectrumB, splitX, width, B_COLOR);

  // Covers + labels in the corners.
  const drawCorner = (cover: CanvasImageSource | null, label: string, color: string, right: boolean) => {
    const size = 64;
    const x = right ? width - size - 14 : 14;
    const y = 14;
    ctx.globalAlpha = 0.95;
    if (cover !== null) {
      ctx.drawImage(cover, x, y, size, size);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, size, size);
    }
    ctx.fillStyle = "rgba(245, 244, 240, 0.92)";
    ctx.font = "12px Arial, sans-serif";
    const text = label.length > 42 ? `${label.slice(0, 39)}…` : label;
    ctx.fillText(text, right ? x - ctx.measureText(text).width - 8 : x, y + size + 16);
    ctx.globalAlpha = 1;
  };
  drawCorner(input.coverA, `A · ${input.labelA}`, A_COLOR, false);
  drawCorner(input.coverB, `B · ${input.labelB}`, B_COLOR, true);

  // The divider + handle.
  ctx.strokeStyle = "rgba(245, 244, 240, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(splitX, 0);
  ctx.lineTo(splitX, height);
  ctx.stroke();
  ctx.fillStyle = "#0a0d14";
  ctx.beginPath();
  ctx.arc(splitX, height / 2, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#f5f4f0";
  ctx.stroke();
  ctx.fillStyle = "#f5f4f0";
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillText("A", splitX - 9, height / 2 + 3.5);
  ctx.fillText("B", splitX + 5, height / 2 + 3.5);

  // Showcase overlays: featured phase + progress.
  if (input.phaseLabel !== null) {
    ctx.fillStyle = "rgba(245, 244, 240, 0.95)";
    ctx.font = "bold 15px ui-monospace, monospace";
    ctx.fillText(input.phaseLabel, 14, height - 34);
  }
  if (input.progress !== null) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.fillRect(0, height - 8, width, 3);
    ctx.fillStyle = "#d6fb54";
    ctx.fillRect(0, height - 8, width * input.progress, 3);
  }

  if (!input.spectrumA && !input.spectrumB) {
    ctx.fillStyle = "rgba(127, 135, 150, 0.85)";
    ctx.font = "13px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("pick two sides and press play — then drag the divider to morph A into B", width / 2, height / 2);
    ctx.textAlign = "left";
  }
}
