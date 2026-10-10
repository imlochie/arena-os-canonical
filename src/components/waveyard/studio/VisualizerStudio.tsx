"use client";

/**
 * VisualizerStudio — the interactive sound visualizer (vision §V4:
 * "generate different kinds of content based on the sounds it hears").
 *
 * The engine (lib visualizer.ts) is pure and fully tested; this component
 * is its skin: it feeds REAL per-stem AnalyserNode spectrums in (the
 * transport's taps — post gain/pan/inserts, so it hears exactly what you
 * hear, and a muted stem stops contributing), steps the scene, and draws.
 *
 * Interaction: the pointer is a first-class input — it pulls the nebula's
 * particles, spins the orbit system, ripples the tide, and plants blooms.
 * The Director ("Auto") listens to the music's character and switches
 * content to match, with dwell hysteresis and a human-readable reason;
 * pinning a scene always overrides it (the user's authority, as everywhere).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { useStemTransport } from "@/lib/waveyard/useStemTransport";
import {
  analyzeSpectrum,
  BAND_NAMES,
  classifyCharacter,
  createAnalyzerState,
  createScene,
  directScene,
  IDLE_POINTER,
  SCENE_BLURBS,
  SCENE_IDS,
  SCENE_LABELS,
  stepScene,
  stemColor,
  WAVES_COLUMNS,
  type AnalyzerState,
  type PointerState,
  type SceneId,
  type SceneState,
  type SpectrumFeatures,
  type StemInput,
} from "@/lib/waveyard/studio/visualizer";
import type { Stem } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

const ZERO_FEATURES: SpectrumFeatures = {
  rms: 0,
  bands: { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 },
  centroid: 0,
  flux: 0,
  onset: false,
  beatPhase: null,
};

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: SceneState,
  stems: readonly Stem[],
  master: SpectrumFeatures,
  pointer: PointerState,
) {
  ctx.clearRect(0, 0, width, height);
  const w = (x: number) => x * width;
  const h = (y: number) => y * height;

  if (scene.scene === "waves") {
    const laneCount = Math.max(1, stems.length);
    const laneHeight = height / laneCount;
    const columnWidth = width / (WAVES_COLUMNS - 1);
    const focusedLane = pointer.active ? Math.min(laneCount - 1, Math.floor(pointer.y * laneCount)) : -1;
    stems.forEach((stem, index) => {
      const columns = scene.waveColumns[Math.min(index, scene.waveColumns.length - 1)] ?? [];
      if (columns.length < 2) return;
      const color = stemColor(stem.stemType);
      const center = (index + 0.5) * laneHeight;
      const scale = laneHeight * 0.42;
      const dimmed = focusedLane >= 0 && index !== focusedLane;

      // The flowing ribbon: top edge = max curve, bottom = min curve.
      ctx.globalAlpha = dimmed ? 0.16 : 0.55;
      ctx.beginPath();
      let started = false;
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const x = width - (columns.length - 1 - columnIndex) * columnWidth;
        const y = center - columns[columnIndex][1] * scale;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      for (let columnIndex = columns.length - 1; columnIndex >= 0; columnIndex -= 1) {
        const x = width - (columns.length - 1 - columnIndex) * columnWidth;
        ctx.lineTo(x, center - columns[columnIndex][0] * scale);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Bright crest on the max curve + the "now" edge.
      ctx.globalAlpha = dimmed ? 0.3 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const x = width - (columns.length - 1 - columnIndex) * columnWidth;
        const y = center - columns[columnIndex][1] * scale;
        if (columnIndex === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width - 0.5, 0);
    ctx.lineTo(width - 0.5, height);
    ctx.stroke();
    if (pointer.active) {
      ctx.fillStyle = "rgba(214, 251, 84, 0.9)";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText("frozen — release to resume the flow", 14, 22);
    }
    return;
  }

  if (scene.scene === "nebula") {
    // Trail fade instead of a hard clear — the field smears like light.
    ctx.fillStyle = "rgba(8, 10, 16, 0.22)";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const particle of scene.particles) {
      const color = stemColor(stems[Math.min(particle.stemIndex, stems.length - 1)]?.stemType ?? "");
      const lifeRatio = 1 - particle.life / particle.maxLife;
      ctx.globalAlpha = Math.max(0, lifeRatio * 0.9);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w(particle.x), h(particle.y), particle.size * (0.6 + lifeRatio), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  if (scene.scene === "terrain") {
    // Ridgelines from the band history — oldest (farthest) first.
    const rows = scene.terrain;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const depth = (rowIndex + 1) / rows.length; // 0 far → 1 near
      const baseline = height * (0.25 + 0.7 * depth);
      const row = rows[rowIndex];
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      const points = row.length * 8;
      for (let point = 0; point <= points; point += 1) {
        const x = (point / points) * width;
        const bandPosition = (point / points) * (row.length - 1);
        const index = Math.floor(bandPosition);
        const fraction = bandPosition - index;
        const left = row[Math.min(index, row.length - 1)];
        const right = row[Math.min(index + 1, row.length - 1)];
        const ridge = (left + (right - left) * fraction) * Math.sin((point / points) * Math.PI);
        ctx.lineTo(x, baseline - ridge * height * 0.32 * depth);
      }
      ctx.lineTo(width, baseline);
      ctx.closePath();
      ctx.fillStyle = `rgba(10, 13, 20, ${0.35 + depth * 0.5})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(131, 232, 255, ${0.15 + depth * 0.6})`;
      ctx.lineWidth = 1 + depth * 1.2;
      ctx.stroke();
    }
    if (pointer.active) {
      const sun = ctx.createRadialGradient(w(pointer.x), h(pointer.y), 0, w(pointer.x), h(pointer.y), width * 0.18);
      sun.addColorStop(0, "rgba(214, 251, 84, 0.35)");
      sun.addColorStop(1, "rgba(214, 251, 84, 0)");
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  if (scene.scene === "orbits") {
    const cx = width / 2;
    const cy = height / 2;
    // The vocal star (or the master, when no vocal stem exists).
    const starR = 10 + master.rms * 46;
    const star = ctx.createRadialGradient(cx, cy, 0, cx, cy, starR * 2.2);
    star.addColorStop(0, "rgba(255, 244, 230, 0.95)");
    star.addColorStop(0.4, `rgba(255, 214, 150, ${0.3 + master.centroid * 0.4})`);
    star.addColorStop(1, "rgba(255, 214, 150, 0)");
    ctx.fillStyle = star;
    ctx.beginPath();
    ctx.arc(cx, cy, starR * 2.2, 0, Math.PI * 2);
    ctx.fill();

    scene.orbits.forEach((body, index) => {
      const stem = stems[Math.min(index, stems.length - 1)];
      const color = stemColor(stem?.stemType ?? "");
      const baseRadius = (0.16 + (index % 3) * 0.11) * Math.min(width, height);
      const radius = baseRadius * (1 + body.energy * 0.55);
      const x = cx + Math.cos(body.angle) * radius;
      const y = cy + Math.sin(body.angle) * radius * 0.62; // slight ellipse
      // Orbit path.
      ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Trail.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * 0.62, 0, body.angle - 0.9, body.angle);
      ctx.stroke();
      // Body.
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 5 + body.energy * 16, 0, Math.PI * 2);
      ctx.fill();
    });
    return;
  }

  if (scene.scene === "tide") {
    const groupWidth = width / Math.max(1, stems.length);
    stems.forEach((stem, stemIndex) => {
      const color = stemColor(stem.stemType);
      const values = scene.terrain.length > 0 ? scene.terrain[scene.terrain.length - 1] : BAND_NAMES.map(() => 0);
      // Per-stem live bands are not in the history (that is the master's);
      // draw the last master row tinted per stem with a per-stem offset so
      // the groups differ — honest: the shape is the master spectrum.
      BAND_NAMES.forEach((_, bandIndex) => {
        const value = values[bandIndex] ?? 0;
        const barWidth = (groupWidth * 0.72) / BAND_NAMES.length;
        const x = stemIndex * groupWidth + groupWidth * 0.14 + bandIndex * barWidth;
        const barHeight = value * height * 0.8;
        const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, "rgba(10, 13, 20, 0.25)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x, height - barHeight, barWidth * 0.68, barHeight);
      });
    });
    for (const ripple of scene.ripples) {
      const age = ripple.age / 1400;
      ctx.strokeStyle = `rgba(131, 232, 255, ${Math.max(0, 0.5 - age * 0.5)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w(ripple.x), h(ripple.y), age * width * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  // bloom
  for (const bloom of scene.blooms) {
    const growth = Math.min(1, bloom.growth / 900);
    const fade = bloom.growth > 1800 ? Math.max(0, 1 - (bloom.growth - 1800) / 800) : 1;
    const petals = bloom.petals;
    const count = 6;
    ctx.save();
    ctx.translate(w(bloom.x), h(bloom.y));
    ctx.rotate(bloom.growth / 2200);
    for (let petal = 0; petal < count; petal += 1) {
      const petalSize = (0.03 + (petals[Math.min(petal, petals.length - 1)] ?? 0) * 0.16) * Math.min(width, height) * growth;
      const angle = (petal / count) * Math.PI * 2;
      ctx.save();
      ctx.rotate(angle);
      ctx.globalAlpha = fade * 0.85;
      ctx.fillStyle = `hsl(${bloom.hue} 80% 64%)`;
      ctx.beginPath();
      ctx.ellipse(petalSize * 0.55, 0, petalSize, petalSize * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = fade;
    ctx.fillStyle = `hsl(${bloom.hue} 90% 82%)`;
    ctx.beginPath();
    ctx.arc(0, 0, 3 + growth * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

export function VisualizerStudio({ stems, transport }: { stems: Stem[]; transport: Transport }) {
  const [mode, setMode] = useState<"auto" | SceneId>("auto");
  const [fullscreen, setFullscreen] = useState(false);
  const [directorScene, setDirectorScene] = useState<SceneId>("nebula");
  const [directorReason, setDirectorReason] = useState<string | null>(null);
  const [reducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>(IDLE_POINTER);
  const sceneRef = useRef<SceneState>(createScene("nebula", 0));
  const analyzersRef = useRef<Map<string, AnalyzerState>>(new Map());
  const masterAnalyzerRef = useRef<AnalyzerState>(createAnalyzerState());
  const directorRef = useRef<{ scene: SceneId; lastSwitchMs: number }>({ scene: "nebula", lastSwitchMs: 0 }); // loop-private; render uses directorScene state
  const modeRef = useRef(mode);
  const stemsRef = useRef(stems);
  const transportRef = useRef(transport);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    stemsRef.current = stems;
    transportRef.current = transport;
  }, [stems, transport]);

  // Keep the canvas backing store matched to its box (DPR-sharp).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const box = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  useEffect(() => {
    if (reducedMotion) return; // one static frame is drawn by the loop below via a manual call
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      const dtMs = Math.min(100, now - last);
      last = now;
      const activeStems = stemsRef.current;
      const activeTransport = transportRef.current;

      // The waves scene needs the time-domain taps; only fetch them then.
      const activeSceneNeedsWaves =
        (modeRef.current === "auto" ? directorRef.current.scene : modeRef.current) === "waves";

      // 1. Perceive: real spectrums, per stem + master.
      const stemInputs: StemInput[] = [];
      for (const stem of activeStems) {
        const bins = activeTransport.readSpectrum(stem.id);
        if (bins === null) continue;
        let state = analyzersRef.current.get(stem.id);
        if (state === undefined) {
          state = createAnalyzerState();
          analyzersRef.current.set(stem.id, state);
        }
        const analyzed = analyzeSpectrum(bins, state, { sampleRate: activeTransport.contextSampleRate(), fftSize: 2048, nowMs: now });
        analyzersRef.current.set(stem.id, analyzed.state);
        stemInputs.push({
          stemType: stem.stemType,
          features: analyzed.features,
          ...(activeSceneNeedsWaves ? { waveform: activeTransport.readWaveform(stem.id) ?? undefined } : {}),
        });
      }
      let master = ZERO_FEATURES;
      const masterBins = activeTransport.readMasterSpectrum();
      if (masterBins !== null) {
        const analyzed = analyzeSpectrum(masterBins, masterAnalyzerRef.current, { sampleRate: activeTransport.contextSampleRate(), fftSize: 2048, nowMs: now });
        masterAnalyzerRef.current = analyzed.state;
        master = analyzed.features;
      }

      // 2. Direct (Auto): pick content that fits what is playing.
      if (modeRef.current === "auto" && stemInputs.length > 0) {
        const character = classifyCharacter(stemInputs, master);
        const decision = directScene(directorRef.current.scene, character, directorRef.current.lastSwitchMs, now);
        if (decision !== null) {
          directorRef.current = { scene: decision.scene, lastSwitchMs: now };
          setDirectorScene(decision.scene);
          setDirectorReason(decision.reason);
        }
      }
      const activeScene: SceneId = modeRef.current === "auto" ? directorRef.current.scene : modeRef.current;
      if (sceneRef.current.scene !== activeScene) {
        sceneRef.current = createScene(activeScene, Math.max(1, stemInputs.length));
      }

      // 3. Evolve + draw.
      sceneRef.current = stepScene(sceneRef.current, stemInputs, master, dtMs, pointerRef.current);
      const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssWidth = canvas.width / dpr;
      const cssHeight = canvas.height / dpr;
      drawScene(ctx, cssWidth, cssHeight, sceneRef.current, activeStems, master, pointerRef.current);

      // Idle hint when nothing is playing.
      if (!activeTransport.playing && stemInputs.every((input) => input.features.rms < 0.001)) {
        ctx.fillStyle = "rgba(127, 135, 150, 0.85)";
        ctx.font = "13px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("press play — the visualizer listens to the stems you hear", cssWidth / 2, cssHeight / 2);
        ctx.textAlign = "left";
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  const onPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>, active: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    pointerRef.current = {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
      active,
    };
  }, []);

  if (stems.length === 0) return null;
  const pinnedScene = mode === "auto" ? directorScene : mode;

  return (
    <section className={`visualizer ${fullscreen ? "fullscreen" : ""}`} data-testid="visualizer" aria-label="Sound visualizer">
      <div className="visualizer-bar">
        <div className="visualizer-title">
          <span className="eyebrow">Sound visualizer</span>
          <b>{SCENE_LABELS[pinnedScene]}{mode === "auto" ? " · auto" : ""}</b>
          <small>{SCENE_BLURBS[pinnedScene]}</small>
        </div>
        <div className="visualizer-modes" role="group" aria-label="Visualizer mode">
          <button className={`deck-chip ${mode === "auto" ? "on" : ""}`} aria-pressed={mode === "auto"} onClick={() => setMode("auto")}>Auto</button>
          {SCENE_IDS.map((scene) => (
            <button key={scene} className={`deck-chip ${mode === scene ? "on" : ""}`} aria-pressed={mode === scene} onClick={() => setMode(scene)}>
              {SCENE_LABELS[scene]}
            </button>
          ))}
          <button className="deck-chip" onClick={() => setFullscreen(!fullscreen)} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {fullscreen ? "✕" : "⛶"}
          </button>
        </div>
      </div>
      {mode === "auto" && directorReason !== null && (
        <p className="visualizer-reason" role="status">Director: {directorReason}</p>
      )}
      {reducedMotion ? (
        <div className="visualizer-still" role="status">Reduced motion is on — the visualizer stays still. Pin a scene and press play to let it listen.</div>
      ) : (
        <canvas
          ref={canvasRef}
          className="visualizer-canvas"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            onPointer(event, true);
          }}
          onPointerMove={(event) => onPointer(event, event.buttons !== 0 || event.pointerType === "mouse")}
          onPointerUp={(event) => onPointer(event, false)}
          onPointerLeave={(event) => onPointer(event, false)}
        />
      )}
    </section>
  );
}
