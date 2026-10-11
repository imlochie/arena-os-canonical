"use client";

/**
 * VisualizerStudio — the interactive sound visualizer (vision §V4:
 * "generate different kinds of content based on the sounds it hears",
 * plus the customization layers: palettes, reactivity, director policy,
 * overlays, post FX, profiles).
 *
 * The engine (lib visualizer.ts) is pure and fully tested; this component
 * is its skin: it feeds REAL per-stem AnalyserNode spectrums in (the
 * transport's taps — post gain/pan/inserts, so it hears exactly what you
 * hear, and a muted stem stops contributing), steps the scene, and draws.
 *
 * Thirteen scenes now (nebula, terrain, orbits, tide, bloom, waves, helix,
 * waterfall, beat city, harmony halo, circuit, phrase constellation, chop
 * galaxy). The data-driven ones read the project's REAL analyses — vocal
 * phrases, chords, the beat grid, the scanned chops, the arrangement
 * layers — through the engine's MusicContext.
 *
 * Interaction: the pointer pulls the nebula, spins the orbits, ripples the
 * tide, plants blooms, freezes waves/waterfall, twists the helix; LASSO
 * isolates stems (mute what you did not circle); TAP re-anchors the beat;
 * Web MIDI maps keys to scenes and faders to stems when the browser has
 * it. The Director ("Auto") listens to the music's character and switches
 * content to match, with dwell hysteresis and a human-readable reason;
 * pinning a scene always overrides it (the user's authority, as everywhere).
 *
 * The customization panel (⚙ Visuals) persists per project: reactivity
 * knobs, the director's policy + scene whitelist, palettes (including one
 * extracted from the source's embedded album artwork), overlay captions,
 * and post FX (grain, scanlines, aberration, vignette, 21:9 letterbox).
 * ⏺ records the canvas + the master bus to a YouTube-ready .webm.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseId3Artwork } from "@/lib/waveyard/studio/ab-compare";
import { extractPalette, paletteColorFor } from "@/lib/waveyard/studio/palette";
import {
  analyzeSpectrum,
  BAND_NAMES,
  bestChord,
  chordAt,
  chopStarLayout,
  classifyCharacter,
  circuitLayout,
  countLayersByStem,
  createAnalyzerState,
  createScene,
  detectChroma,
  directScene,
  estimateBpmFromTaps,
  fifthsSlot,
  IDLE_POINTER,
  lassoSelection,
  midiToHeight,
  PITCH_CLASS_NAMES,
  phraseMeanMidi,
  scaleFeatures,
  SCENE_BLURBS,
  SCENE_IDS,
  SCENE_LABELS,
  stepScene,
  stemColor,
  WAVES_COLUMNS,
  WATERFALL_COLUMNS,
  type AnalyzerState,
  type MusicContext,
  type PointerState,
  type SceneId,
  type SceneState,
  type SpectrumFeatures,
  type StemInput,
} from "@/lib/waveyard/studio/visualizer";
import {
  drawAberration,
  drawGrain,
  drawLetterbox,
  drawScanlines,
  drawVignette,
  midiControlToVolume,
  midiNoteToScene,
  overlayPositions,
  timecodeLabel,
} from "@/lib/waveyard/studio/viz-fx";
import {
  DEFAULT_VIZ_SETTINGS,
  loadVizSettings,
  saveVizSettings,
  type VizSettings,
} from "@/lib/waveyard/studio/viz-settings";
import type { MixerValues, useStemTransport } from "@/lib/waveyard/useStemTransport";
import type { Stem, Source, VocalPhrase, VocalPitchFrame } from "./types";

type Transport = ReturnType<typeof useStemTransport>;
type ControlPatch = (id: string, patch: Partial<MixerValues>) => void;

const ZERO_FEATURES: SpectrumFeatures = {
  rms: 0,
  bands: { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 },
  centroid: 0,
  flux: 0,
  onset: false,
  beatPhase: null,
};

const HELIX_TURNS = 3;
const LETTERBOX_RATIO = 21 / 9;
const CHROMA_LOW_HZ = 110;

// ------------------------------------------------------------------ drawing

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: SceneState,
  inputs: readonly StemInput[],
  master: SpectrumFeatures,
  pointer: PointerState,
  music: MusicContext,
  colorFor: (stemType: string) => string,
  trails: number,
) {
  const w = (x: number) => x * width;
  const h = (y: number) => y * height;
  const stemCount = Math.max(1, inputs.length);

  if (scene.scene === "helix") {
    const centerY = height / 2;
    const rungColumns = new Map<number, { min: number; max: number; glow: number; age: number }>();
    // Strands: each stem winds around the axis; loud stems breathe wider.
    inputs.forEach((input, index) => {
      const color = colorFor(input.stemType);
      const amplitude = (0.14 + Math.min(1, input.features.rms * 1.6) * 0.24) * (height / 2);
      const phase = (index / stemCount) * Math.PI * 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let step = 0; step <= 60; step += 1) {
        const t = step / 60;
        const y = centerY + Math.sin(t * HELIX_TURNS * Math.PI * 2 + scene.helixRotation + phase) * amplitude;
        if (step === 0) ctx.moveTo(w(t), y);
        else ctx.lineTo(w(t), y);
        // Collect strand y positions at rung x positions.
        for (const rung of scene.helixRungs) {
          if (Math.abs(rung.x - t) < 1 / 120) {
            const bucket = rungColumns.get(rung.x);
            if (bucket === undefined) rungColumns.set(rung.x, { min: y, max: y, glow: rung.glow, age: rung.age });
            else {
              bucket.min = Math.min(bucket.min, y);
              bucket.max = Math.max(bucket.max, y);
            }
          }
        }
      }
      ctx.stroke();
      // Depth shading: the strand's far side is dimmer.
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      for (let step = 0; step <= 60; step += 1) {
        const t = step / 60;
        const y = centerY + Math.sin(t * HELIX_TURNS * Math.PI * 2 + scene.helixRotation + phase + Math.PI) * amplitude;
        if (step === 0) ctx.moveTo(w(t), y);
        else ctx.lineTo(w(t), y);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    // Rungs: beats as the ladder between strands.
    for (const rung of scene.helixRungs) {
      const column = rungColumns.get(rung.x);
      if (column === undefined) continue;
      const fade = Math.max(0, 1 - rung.age / 2600);
      ctx.strokeStyle = `rgba(245, 244, 240, ${0.15 + rung.glow * 0.65 * fade})`;
      ctx.lineWidth = 1 + rung.glow * 3 * fade;
      ctx.beginPath();
      ctx.moveTo(w(rung.x), column.min);
      ctx.lineTo(w(rung.x), column.max);
      ctx.stroke();
    }
    if (pointer.active) {
      ctx.fillStyle = "rgba(214, 251, 84, 0.9)";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText("drag to twist the helix", 14, 22);
    }
    return;
  }

  if (scene.scene === "waterfall") {
    const laneWidth = width / stemCount;
    const rowCount = Math.max(1, Math.max(...scene.waterfallColumns.map((columns) => columns.length), 1));
    const rowHeight = height / Math.min(rowCount, WATERFALL_COLUMNS);
    inputs.forEach((input, index) => {
      const columns = scene.waterfallColumns[Math.min(index, scene.waterfallColumns.length - 1)] ?? [];
      const color = colorFor(input.stemType);
      const laneX = index * laneWidth;
      columns.forEach((column, rowIndex) => {
        const y = rowIndex * rowHeight; // newest at the top, history falls
        BAND_NAMES.forEach((band, bandIndex) => {
          const value = column[bandIndex] ?? 0;
          if (value <= 0.01) return;
          const cellWidth = (laneWidth * 0.86) / BAND_NAMES.length;
          ctx.globalAlpha = Math.min(1, 0.12 + value * 1.1);
          ctx.fillStyle = color;
          ctx.fillRect(laneX + laneWidth * 0.07 + bandIndex * cellWidth, y, cellWidth * 0.82, Math.max(1, rowHeight - 0.5));
        });
      });
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = color;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(input.stemType.split("/")[0], laneX + 6, 14);
    });
    ctx.globalAlpha = 1;
    if (pointer.active) {
      ctx.fillStyle = "rgba(214, 251, 84, 0.9)";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText("frozen — release to let it fall", 14, height - 12);
    }
    return;
  }

  if (scene.scene === "beatcity") {
    const visibleBars = 32;
    const newest = Math.max(0, scene.cityLastBar);
    const barWidth = width / visibleBars;
    for (let offset = 0; offset < visibleBars; offset += 1) {
      const bar = newest - (visibleBars - 1 - offset);
      if (bar < 0) continue;
      const height01 = scene.cityHeights[bar % scene.cityHeights.length] ?? 0;
      const buildingHeight = height01 * height * 0.82;
      const x = offset * barWidth;
      const gradient = ctx.createLinearGradient(0, height - buildingHeight, 0, height);
      gradient.addColorStop(0, `rgba(131, 232, 255, ${0.25 + height01 * 0.65})`);
      gradient.addColorStop(1, "rgba(10, 13, 20, 0.9)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x + barWidth * 0.12, height - buildingHeight, barWidth * 0.76, buildingHeight);
      // Windows: deterministic dots that light with the level.
      const columns = 3;
      const rows = Math.max(1, Math.floor(buildingHeight / 14));
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          if (((bar * 31 + row * 7 + column * 13) % 10) / 10 > height01) continue;
          ctx.fillStyle = `rgba(248, 202, 123, ${0.3 + height01 * 0.5})`;
          ctx.fillRect(x + barWidth * (0.24 + column * 0.24), height - buildingHeight + 8 + row * 14, 3, 4);
        }
      }
    }
    // The playing bar marker.
    if (scene.cityLastBar >= 0) {
      ctx.strokeStyle = "rgba(214, 251, 84, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo((visibleBars - 1) * barWidth + barWidth / 2, 0);
      ctx.lineTo((visibleBars - 1) * barWidth + barWidth / 2, height);
      ctx.stroke();
    }
    return;
  }

  if (scene.scene === "halo") {
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.36;
    // The wheel: 12 fifths segments, brightness = live chroma.
    for (let pc = 0; pc < 12; pc += 1) {
      const slot = fifthsSlot(pc);
      const startAngle = (slot / 12) * Math.PI * 2 - Math.PI / 2 - (Math.PI / 12) + 0.02;
      const endAngle = startAngle + Math.PI / 6 - 0.04;
      const energy = scene.haloChroma[pc] ?? 0;
      ctx.strokeStyle = `hsla(${pc * 30}, 75%, 64%, ${0.14 + energy * 0.8})`;
      ctx.lineWidth = 6 + energy * 16;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.stroke();
      ctx.fillStyle = `rgba(127, 135, 150, ${0.45 + energy * 0.5})`;
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(PITCH_CLASS_NAMES[pc], cx + Math.cos((slot / 12) * Math.PI * 2 - Math.PI / 2) * (radius + 22), cy + Math.sin((slot / 12) * Math.PI * 2 - Math.PI / 2) * (radius + 22) + 4);
      ctx.textAlign = "left";
    }
    // The active chord: root + triad spokes.
    const analysed = chordAt(music.chords ?? [], music.positionMs ?? 0);
    const live = bestChord(scene.haloChroma);
    const chord = analysed ?? live;
    if (chord !== null) {
      const slots = [chord.rootIndex, (chord.rootIndex + (chord.quality === "minor" || chord.quality === "minor7" || chord.quality === "diminished" ? 3 : 4)) % 12, (chord.rootIndex + (chord.quality === "diminished" ? 6 : 7)) % 12];
      for (const pc of slots) {
        const angle = (fifthsSlot(pc) / 12) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = "rgba(245, 244, 240, 0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * radius * 0.42, cy + Math.sin(angle) * radius * 0.42);
        ctx.lineTo(cx + Math.cos(angle) * radius * 0.95, cy + Math.sin(angle) * radius * 0.95);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(245, 244, 240, 0.95)";
      ctx.font = "bold 16px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${PITCH_CLASS_NAMES[chord.rootIndex]} ${chord.quality}${analysed !== null ? "" : " ·live"}`, cx, cy + 4);
      ctx.textAlign = "left";
    }
    // The modulation sweep.
    if (scene.haloSweep !== null) {
      const progress = Math.min(1, scene.haloSweep.age / 900);
      const fromAngle = (fifthsSlot(scene.haloSweep.fromRoot) / 12) * Math.PI * 2 - Math.PI / 2;
      const toAngle = chord !== null ? (fifthsSlot(chord.rootIndex) / 12) * Math.PI * 2 - Math.PI / 2 : fromAngle;
      ctx.strokeStyle = `rgba(214, 251, 84, ${0.55 * (1 - progress)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.72, fromAngle, fromAngle + (toAngle - fromAngle) * progress);
      ctx.stroke();
    }
    return;
  }

  if (scene.scene === "circuit") {
    const layout = circuitLayout(inputs.length, music.layerCounts ?? [], width, height);
    const masterColor = "#f5f4f0";
    // Wires: stem → its layers → master, thickness = level.
    layout.layers.forEach((layer) => {
      const stem = inputs[Math.min(layer.stemIndex, inputs.length - 1)];
      const level = stem?.features.rms ?? 0;
      ctx.strokeStyle = `rgba(131, 232, 255, ${0.2 + level * 0.6})`;
      ctx.lineWidth = 1 + level * 5;
      ctx.beginPath();
      ctx.moveTo(layout.stems[layer.stemIndex].x, layout.stems[layer.stemIndex].y);
      ctx.lineTo(layer.x, layer.y);
      ctx.stroke();
      ctx.strokeStyle = `rgba(214, 251, 84, ${0.15 + level * 0.4})`;
      ctx.beginPath();
      ctx.moveTo(layer.x, layer.y);
      ctx.lineTo(layout.master.x, layout.master.y);
      ctx.stroke();
      ctx.fillStyle = "rgba(248, 202, 123, 0.75)";
      ctx.fillRect(layer.x - 3, layer.y - 3, 6, 6);
    });
    layout.stems.forEach((node, index) => {
      const stem = inputs[Math.min(index, inputs.length - 1)];
      const level = stem?.features.rms ?? 0;
      if (layout.layers.length === 0 || !(music.layerCounts ?? [])[index]) {
        // No layers on this stem: wire straight to master.
        ctx.strokeStyle = `rgba(131, 232, 255, ${0.2 + level * 0.6})`;
        ctx.lineWidth = 1 + level * 5;
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(layout.master.x, layout.master.y);
        ctx.stroke();
      }
      // Current dots travel toward the master with the pulse.
      const dots = 3;
      for (let dot = 0; dot < dots; dot += 1) {
        const phase = (scene.circuitPulse * (0.6 + level) + dot / dots) % 1;
        ctx.fillStyle = "rgba(245, 244, 240, 0.85)";
        ctx.beginPath();
        ctx.arc(node.x + (layout.master.x - node.x) * phase, node.y + (layout.master.y - node.y) * phase, 1.6 + level * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = colorFor(stem?.stemType ?? "");
      ctx.beginPath();
      ctx.arc(node.x, node.y, 6 + level * 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(127, 135, 150, 0.9)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(stem?.stemType.split("/")[0] ?? "", node.x, node.y - 14 - level * 10);
      ctx.textAlign = "left";
    });
    const masterR = 8 + master.rms * 22;
    ctx.fillStyle = masterColor;
    ctx.beginPath();
    ctx.arc(layout.master.x, layout.master.y, masterR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a0d14";
    ctx.font = "bold 10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("MASTER", layout.master.x, layout.master.y + 3.5);
    ctx.textAlign = "left";
    return;
  }

  if (scene.scene === "lyrics") {
    const phrases = music.phrases ?? [];
    const durationMs = music.durationMs ?? 0;
    if (phrases.length === 0) {
      ctx.fillStyle = "rgba(127, 135, 150, 0.85)";
      ctx.font = "13px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("no vocal phrases analysed yet — run the vocal analysis on the vocals stem", width / 2, height / 2);
      ctx.textAlign = "left";
      return;
    }
    const color = colorFor("vocals");
    phrases.forEach((phrase, index) => {
      const x = durationMs > 0 ? (phrase.startMs / durationMs) * width : (index / phrases.length) * width;
      const y = h(midiToHeight(phrase.midi ?? 60));
      const glow = scene.phraseGlows[index] ?? 0;
      ctx.globalAlpha = 0.25 + glow * 0.75;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3 + glow * 9, 0, Math.PI * 2);
      ctx.fill();
      if (glow > 0.4) {
        ctx.globalAlpha = glow;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 14 - glow * 10, y);
        ctx.lineTo(x + 14 + glow * 10, y);
        ctx.moveTo(x, y - 14 - glow * 10);
        ctx.lineTo(x, y + 14 + glow * 10);
        ctx.stroke();
        ctx.fillStyle = "rgba(245, 244, 240, 0.85)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(phrase.midi !== null ? PITCH_CLASS_NAMES[((Math.round(phrase.midi) % 12) + 12) % 12] : "—", x + 10, y - 10);
      }
    });
    ctx.globalAlpha = 1;
    // The playhead.
    if ((music.positionMs ?? null) !== null && durationMs > 0) {
      const x = ((music.positionMs ?? 0) / durationMs) * width;
      ctx.strokeStyle = "rgba(245, 244, 240, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    return;
  }

  if (scene.scene === "chopgalaxy") {
    const chops = music.chops ?? [];
    const durationMs = music.durationMs ?? 0;
    if (chops.length === 0) {
      ctx.fillStyle = "rgba(127, 135, 150, 0.85)";
      ctx.font = "13px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("no vocal chops scanned yet — scan chops on a stem first", width / 2, height / 2);
      ctx.textAlign = "left";
      return;
    }
    const stars = chopStarLayout(chops, durationMs);
    const cx = width / 2;
    const cy = height / 2;
    const scale = Math.min(width, height) / 2;
    stars.forEach((star, index) => {
      const glow = scene.chopGlows[index] ?? 0;
      const pc = ((Math.round(chops[index].rootMidi) % 12) + 12) % 12;
      ctx.globalAlpha = 0.25 + glow * 0.75;
      ctx.fillStyle = `hsl(${pc * 30} 80% 66%)`;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(star.angle) * star.radius * scale, cy + Math.sin(star.angle) * star.radius * scale * 0.86, star.size * (1 + glow), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    // The playhead ring.
    if (durationMs > 0 && (music.positionMs ?? null) !== null) {
      const fraction = Math.min(1, (music.positionMs ?? 0) / durationMs);
      ctx.strokeStyle = "rgba(245, 244, 240, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, (0.18 + 0.62 * fraction) * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  if (scene.scene === "waves") {
    const laneCount = Math.max(1, inputs.length);
    const laneHeight = height / laneCount;
    const columnWidth = width / (WAVES_COLUMNS - 1);
    const focusedLane = pointer.active ? Math.min(laneCount - 1, Math.floor(pointer.y * laneCount)) : -1;
    inputs.forEach((input, index) => {
      const columns = scene.waveColumns[Math.min(index, scene.waveColumns.length - 1)] ?? [];
      if (columns.length < 2) return;
      const color = colorFor(input.stemType);
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
    ctx.fillStyle = `rgba(8, 10, 16, ${0.06 + (1 - trails) * 0.3})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    for (const particle of scene.particles) {
      const color = colorFor(inputs[Math.min(particle.stemIndex, inputs.length - 1)]?.stemType ?? "");
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
      const input = inputs[Math.min(index, inputs.length - 1)];
      const color = colorFor(input?.stemType ?? "");
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
    const groupWidth = width / Math.max(1, inputs.length);
    inputs.forEach((input, stemIndex) => {
      const color = colorFor(input.stemType);
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

// ---------------------------------------------------------------- component

type ChopSummary = { startMs: number; durationMs: number; rootMidi: number; confidence: number };

export function VisualizerStudio({
  projectId,
  stems,
  sources,
  transport,
  onControl,
}: {
  projectId: string;
  stems: Stem[];
  sources: Source[];
  transport: Transport;
  onControl: ControlPatch;
}) {
  const [mode, setMode] = useState<"auto" | SceneId>("auto");
  const [fullscreen, setFullscreen] = useState(false);
  const [directorScene, setDirectorScene] = useState<SceneId>("nebula");
  const [directorReason, setDirectorReason] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<VizSettings>(() => loadVizSettings(projectId) ?? DEFAULT_VIZ_SETTINGS);
  const [lassoMode, setLassoMode] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [recording, setRecording] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [midiStatus, setMidiStatus] = useState<"off" | "on" | "unsupported" | "error">("off");
  const [midiLabel, setMidiLabel] = useState<string | null>(null);
  const [reducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>(IDLE_POINTER);
  const lassoPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const sceneRef = useRef<SceneState>(createScene("nebula", 0));
  const analyzersRef = useRef<Map<string, AnalyzerState>>(new Map());
  const masterAnalyzerRef = useRef<AnalyzerState>(createAnalyzerState());
  const directorRef = useRef<{ scene: SceneId; lastSwitchMs: number }>({ scene: "nebula", lastSwitchMs: 0 }); // loop-private; render uses directorScene state
  const modeRef = useRef(mode);
  const stemsRef = useRef(stems);
  const transportRef = useRef(transport);
  const onControlRef = useRef(onControl);
  const settingsRef = useRef(settings);
  const anchorRef = useRef<{ anchorMs: number; bpm: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chopsRef = useRef<ChopSummary[]>([]);
  const layersRef = useRef<string[]>([]);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    stemsRef.current = stems;
    transportRef.current = transport;
    onControlRef.current = onControl;
  }, [stems, transport, onControl]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // The project's analysed music data (phrases, chords, chops, layers).
  const phrases = useMemo(() => {
    const vocals = stems.find((stem) => stem.stemType.split("/")[0] === "vocals" && (stem.vocalPhrases?.length ?? 0) > 0);
    if (vocals === undefined || vocals.vocalPhrases === undefined) return [];
    const frames: readonly VocalPitchFrame[] = vocals.vocalFrames ?? [];
    return vocals.vocalPhrases.map((phrase: VocalPhrase) => ({
      startMs: phrase.startMs,
      endMs: phrase.endMs,
      midi: phraseMeanMidi(frames, phrase.startMs, phrase.endMs),
    }));
  }, [stems]);
  const chords = useMemo(
    () => (sources[0]?.harmonyEvents ?? []).map((event) => ({ startMs: event.startMs, endMs: event.endMs, root: event.root, quality: event.quality })),
    [sources],
  );
  const musicMeta = useMemo(() => {
    const analysis = sources[0]?.analysis ?? null;
    return {
      bpm: analysis?.bpm ?? null,
      musicalKey: analysis?.musicalKey ?? null,
      title: sources[0]?.acquisition?.title ?? sources[0]?.originalFilename ?? null,
      artist: sources[0]?.acquisition?.artist ?? null,
      sections: sources[0]?.sections ?? [],
      durationMs: (sources[0]?.durationSeconds ?? stems[0]?.durationSeconds ?? 0) * 1000,
    };
  }, [sources, stems]);
  const phrasesRef = useRef(phrases);
  const chordsRef = useRef(chords);
  const musicMetaRef = useRef(musicMeta);
  useEffect(() => {
    phrasesRef.current = phrases;
    chordsRef.current = chords;
    musicMetaRef.current = musicMeta;
  }, [phrases, chords, musicMeta]);

  // The palette: studio stem colors, or the custom (cover-extracted) set.
  const colorFor = useMemo(
    () => (settings.palette.mode === "custom" && settings.palette.colors.length > 0 ? paletteColorFor(settings.palette.colors, stemColor) : stemColor),
    [settings.palette],
  );
  const colorForRef = useRef(colorFor);
  useEffect(() => { colorForRef.current = colorFor; }, [colorFor]);

  // Fetch the scanned chops + arrangement layers (the chop galaxy + circuit).
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch(`/api/waveyard/projects/${projectId}/vocal-chops`, { cache: "no-store" });
      if (!active || !response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (active) chopsRef.current = (body.chops ?? []) as ChopSummary[];
    })();
    void (async () => {
      const response = await fetch(`/api/waveyard/projects/${projectId}/arrangement-layers`, { cache: "no-store" });
      if (!active || !response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (active) layersRef.current = ((body.layers ?? []) as Array<{ instrument: string }>).map((layer) => layer.instrument);
    })();
    return () => { active = false; };
  }, [projectId]);

  // Settings profile: the lazy initializer loads it once; save on change.
  useEffect(() => {
    saveVizSettings(projectId, settings);
  }, [projectId, settings]);

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
      const buffer = bufferRef.current ?? (bufferRef.current = document.createElement("canvas"));
      if (buffer.width !== canvas.width || buffer.height !== canvas.height) {
        buffer.width = canvas.width;
        buffer.height = canvas.height;
      }
      const sceneCtx = buffer.getContext("2d");
      if (sceneCtx === null) return;

      const viz = settingsRef.current;
      const dtMs = Math.min(100, now - last) * viz.timeScale;
      last = now;
      const activeStems = stemsRef.current;
      const activeTransport = transportRef.current;

      // The data-driven scenes need the time-domain taps.
      const currentScene = modeRef.current === "auto" ? directorRef.current.scene : modeRef.current;
      const needsWaves = currentScene === "waves";

      // 1. Perceive: real spectrums, per stem + master, scaled by the
      //    reactivity knob (the customization layer's energy multiplier).
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
          features: scaleFeatures(analyzed.features, viz.energy),
          ...(needsWaves ? { waveform: activeTransport.readWaveform(stem.id) ?? undefined } : {}),
        });
      }
      let master = ZERO_FEATURES;
      let chroma: number[] | null = null;
      const masterBins = activeTransport.readMasterSpectrum();
      if (masterBins !== null) {
        const analyzed = analyzeSpectrum(masterBins, masterAnalyzerRef.current, { sampleRate: activeTransport.contextSampleRate(), fftSize: 2048, nowMs: now });
        masterAnalyzerRef.current = analyzed.state;
        master = scaleFeatures(analyzed.features, viz.energy);
        chroma = detectChroma(masterBins, { sampleRate: activeTransport.contextSampleRate(), fftSize: 2048 });
      }

      // 2. The music context: real analyses + the manual beat anchor.
      const meta = musicMetaRef.current;
      const anchor = anchorRef.current;
      const music: MusicContext = {
        positionMs: activeTransport.position * 1000,
        bpm: meta.bpm,
        beatPhaseOverride: anchor !== null ? tappedPhase(now, anchor) : null,
        ...(chroma !== null ? { chroma } : {}),
        chords: chordsRef.current,
        phrases: phrasesRef.current,
        chops: chopsRef.current,
        layerCounts: countLayersByStem(activeStems.map((stem) => stem.stemType), layersRef.current),
        durationMs: meta.durationMs,
      };

      // 3. Direct (Auto): pick content that fits what is playing, under
      //    the user's policy (dwell + scene whitelist).
      if (modeRef.current === "auto" && stemInputs.length > 0) {
        const character = classifyCharacter(stemInputs, master);
        const decision = directScene(directorRef.current.scene, character, directorRef.current.lastSwitchMs, now, {
          extra: extraScenes(chordsRef.current.length > 0, phrasesRef.current.length > 0, chopsRef.current.length > 0),
          whitelist: viz.sceneWhitelist,
          dwellMs: viz.dwellMs,
        });
        if (decision !== null) {
          directorRef.current = { scene: decision.scene, lastSwitchMs: now };
          setDirectorScene(decision.scene);
          setDirectorReason(decision.reason);
        }
      }
      const activeScene: SceneId = modeRef.current === "auto" ? directorRef.current.scene : modeRef.current;
      if (sceneRef.current.scene !== activeScene || sceneRef.current.waveColumns.length !== Math.max(1, stemInputs.length)) {
        sceneRef.current = createScene(activeScene, Math.max(1, stemInputs.length));
      }

      // 4. Evolve + draw (into the offscreen scene buffer).
      sceneRef.current = stepScene(sceneRef.current, stemInputs, master, dtMs, pointerRef.current, music, {
        particles: viz.particleCap,
      });
      const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssWidth = canvas.width / dpr;
      const cssHeight = canvas.height / dpr;
      drawScene(sceneCtx, cssWidth, cssHeight, sceneRef.current, stemInputs, master, pointerRef.current, music, colorForRef.current, viz.trails);

      // 5. Composite + post FX + overlays onto the recorded canvas.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.drawImage(buffer, 0, 0, cssWidth, cssHeight);
      if (viz.postFx.aberration > 0 && typeof ctx.filter === "string") {
        drawAberration(ctx, buffer, cssWidth, cssHeight, viz.postFx.aberration);
      }
      drawGrain(ctx, cssWidth, cssHeight, viz.postFx.grain, sceneRef.current.tick);
      drawScanlines(ctx, cssWidth, cssHeight, viz.postFx.scanlines);
      drawVignette(ctx, cssWidth, cssHeight, viz.postFx.vignette);
      drawOverlays(ctx, cssWidth, cssHeight, viz, meta, activeTransport.position, music.positionMs ?? 0);

      // The lasso stroke, live.
      if (lassoPointsRef.current.length > 1) {
        ctx.strokeStyle = "rgba(214, 251, 84, 0.85)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        lassoPointsRef.current.forEach((point, index) => {
          const x = point.x * cssWidth;
          const y = point.y * cssHeight;
          if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      drawLetterbox(ctx, cssWidth, cssHeight, viz.postFx.letterbox ? LETTERBOX_RATIO : 0);

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

  // ---------------------------------------------------------------- input

  const onPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>, active: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
    pointerRef.current = { ...point, active };
    if (lassoMode) {
      if (active) lassoPointsRef.current = [...lassoPointsRef.current, point].slice(-160);
    }
  }, [lassoMode]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const release = {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
    if (lassoMode) {
      const points = [...lassoPointsRef.current, release];
      lassoPointsRef.current = [];
      const stemsNow = stemsRef.current;
      if (points.length >= 2 && stemsNow.length > 1) {
        const selected = lassoSelection(stemsNow.length, points);
        stemsNow.forEach((stem, index) => onControlRef.current(stem.id, { muted: !selected[index] }));
        const isolated = stemsNow.filter((_, index) => selected[index]).map((stem) => stem.stemType.split("/")[0]);
        setNotice(isolated.length > 0 && isolated.length < stemsNow.length
          ? `Lasso isolated: ${isolated.join(", ")} — ${stemsNow.length - isolated.length} muted`
          : "Lasso covered everything — nothing muted");
      } else {
        // A click in lasso mode unmutes everything.
        stemsNow.forEach((stem) => onControlRef.current(stem.id, { muted: false }));
        setNotice("Lasso click — all stems unmuted");
      }
      setLassoMode(false);
    }
    pointerRef.current = { ...release, active: false };
  }, [lassoMode]);

  const onTapBeat = useCallback(() => {
    const now = performance.now();
    const next = [...taps, now].slice(-8);
    setTaps(next);
    const estimated = estimateBpmFromTaps(next);
    const bpm = estimated ?? musicMetaRef.current.bpm;
    if (bpm === null) {
      setNotice("No tempo to anchor yet — the source needs its analysis, or three+ taps.");
      return;
    }
    anchorRef.current = { anchorMs: now, bpm };
    setNotice(estimated !== null
      ? `Beat re-anchored to your taps (${estimated} BPM) — helix + beat city follow you now`
      : `Beat re-anchored (using the analysed ${Math.round(bpm * 10) / 10} BPM grid)`);
  }, [taps]);

  // ---------------------------------------------------------------- MIDI

  const enableMidi = useCallback(async () => {
    if (typeof navigator.requestMIDIAccess !== "function") {
      setMidiStatus("unsupported");
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      const wire = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            const data = event.data;
            if (data === null || data.length < 2) return;
            const status = data[0] ?? 0;
            const d1 = data[1] ?? 0;
            const d2 = data[2] ?? 0;
            const command = status & 0xf0;
            if (command === 0x90 && d2 > 0) {
              const scene = midiNoteToScene(d1);
              if (scene !== null) setMode(scene === "auto" ? "auto" : scene);
            } else if (command === 0xb0) {
              const stemsNow = stemsRef.current;
              const mapped = midiControlToVolume(d1, d2, stemsNow.length);
              if (mapped !== null && stemsNow[mapped.stemIndex] !== undefined) {
                onControlRef.current(stemsNow[mapped.stemIndex].id, { volume: mapped.volume });
              }
            }
          };
        }
        setMidiLabel([...access.inputs.values()].map((input) => input.name).filter(Boolean).join(", ") || "no inputs");
      };
      wire();
      setMidiStatus("on");
    } catch {
      setMidiStatus("error");
    }
  }, []);

  // ------------------------------------------------------------- recording

  const startRecording = useCallback(async () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
      setNotice("This browser cannot record the canvas — Chrome or the desktop app can.");
      return;
    }
    const audioStream = transportRef.current.masterTapStream();
    if (audioStream === null) {
      setNotice("Press play first — the recorder taps the master bus, which exists once audio flows.");
      return;
    }
    if (videoUrl !== null) { URL.revokeObjectURL(videoUrl); setVideoUrl(null); }
    const stream = canvas.captureStream(30);
    for (const track of audioStream.getAudioTracks()) stream.addTrack(track);
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType !== undefined ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      setVideoUrl(URL.createObjectURL(blob));
      setNotice("Visualizer recorded — the .webm downloads below, audio and all.");
    };
    recorder.start(250);
    recorderRef.current = recorder;
    setRecording(true);
  }, [videoUrl]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current !== null && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // ------------------------------------------------------------- settings UI

  const patchSettings = useCallback((patch: Partial<VizSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const extractCoverPalette = useCallback(async () => {
    const source = sources[0];
    if (source === undefined) {
      setNotice("No source in this project yet — add one to dress the visualizer in its artwork.");
      return;
    }
    try {
      const response = await fetch(`/api/assets/${source.id}`, { headers: { Range: "bytes=0-262143" } });
      if (!response.ok) throw new Error("fetch failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const artwork = parseId3Artwork(bytes.length > 262_144 ? bytes.subarray(0, 262_144) : bytes);
      if (artwork === null) {
        setNotice("No embedded artwork in this file — the studio palette stays.");
        return;
      }
      const blob = new Blob([new Uint8Array(artwork.data)], { type: artwork.mime });
      const url = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("decode failed"));
          element.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        if (ctx === null) return;
        ctx.drawImage(image, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        const palette = extractPalette(pixels);
        if (palette.length === 0) {
          setNotice("This artwork has no vivid colors — the studio palette stays.");
          return;
        }
        patchSettings({ palette: { mode: "custom", colors: palette } });
        setNotice(`Dressed in the album's colors: ${palette.join(" ")}`);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setNotice("Could not read the artwork — the studio palette stays.");
    }
  }, [patchSettings, sources]);

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
          <button className={`deck-chip ${lassoMode ? "on" : ""}`} aria-pressed={lassoMode} onClick={() => { setLassoMode(!lassoMode); lassoPointsRef.current = []; }} title="Draw around the stems you want to keep audible">
            Lasso
          </button>
          <button className="deck-chip" onClick={onTapBeat} title="Re-anchor the beat grid to your taps">Tap beat</button>
          <button className={`deck-chip ${settingsOpen ? "on" : ""}`} aria-pressed={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>⚙ Visuals</button>
          <button className="deck-chip" onClick={() => setFullscreen(!fullscreen)} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {fullscreen ? "✕" : "⛶"}
          </button>
        </div>
      </div>
      {mode === "auto" && directorReason !== null && (
        <p className="visualizer-reason" role="status">Director: {directorReason}</p>
      )}
      {notice !== null && <p className="visualizer-reason" role="status">{notice}</p>}
      {settingsOpen && (
        <div className="viz-settings" aria-label="Visualizer customization">
          <div className="viz-settings-row">
            <label>Reactivity <input aria-label="Reactivity" type="range" min={0.25} max={3} step={0.05} value={settings.energy} onChange={(event) => patchSettings({ energy: Number(event.target.value) })} /></label>
            <label>Trails <input aria-label="Trails" type="range" min={0} max={1} step={0.05} value={settings.trails} onChange={(event) => patchSettings({ trails: Number(event.target.value) })} /></label>
            <label>Particles <input aria-label="Particle cap" type="range" min={60} max={1200} step={20} value={settings.particleCap} onChange={(event) => patchSettings({ particleCap: Number(event.target.value) })} /></label>
            <label>Slow-mo <input aria-label="Time scale" type="range" min={0.25} max={1} step={0.05} value={settings.timeScale} onChange={(event) => patchSettings({ timeScale: Number(event.target.value) })} /></label>
          </div>
          <div className="viz-settings-row">
            <label>Director dwell <input aria-label="Director dwell seconds" type="range" min={2} max={30} step={1} value={settings.dwellMs / 1000} onChange={(event) => patchSettings({ dwellMs: Number(event.target.value) * 1000 })} /></label>
            <div className="viz-whitelist">
              <span>Scenes the director may pick:</span>
              <div>
                {SCENE_IDS.map((scene) => (
                  <button
                    key={scene}
                    className={`deck-chip ${settings.sceneWhitelist.includes(scene) ? "on" : ""}`}
                    aria-pressed={settings.sceneWhitelist.includes(scene)}
                    onClick={() => patchSettings({ sceneWhitelist: settings.sceneWhitelist.includes(scene) ? settings.sceneWhitelist.filter((item) => item !== scene) : [...settings.sceneWhitelist, scene] })}
                  >
                    {SCENE_LABELS[scene]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="viz-settings-row">
            <div className="viz-palette">
              <span>Palette:</span>
              <button className={`deck-chip ${settings.palette.mode === "stems" ? "on" : ""}`} aria-pressed={settings.palette.mode === "stems"} onClick={() => patchSettings({ palette: { mode: "stems", colors: [] } })}>Studio stems</button>
              <button
                className={`deck-chip ${settings.palette.mode === "custom" ? "on" : ""}`}
                aria-pressed={settings.palette.mode === "custom"}
                onClick={() => (settings.palette.colors.length > 0 ? patchSettings({ palette: { ...settings.palette, mode: "custom" } }) : void extractCoverPalette())}
              >
                From album cover
              </button>
              <button className="deck-chip" onClick={() => void extractCoverPalette()}>Extract from artwork</button>
              {settings.palette.mode === "custom" && settings.palette.colors.length > 0 && (
                <span className="viz-swatches" aria-hidden="true">
                  {settings.palette.colors.map((color) => <i key={color} style={{ background: color }} />)}
                </span>
              )}
            </div>
          </div>
          <div className="viz-settings-row">
            <label><input type="checkbox" checked={settings.overlays.title} onChange={(event) => patchSettings({ overlays: { ...settings.overlays, title: event.target.checked } })} /> Title + artist</label>
            <label><input type="checkbox" checked={settings.overlays.timecode} onChange={(event) => patchSettings({ overlays: { ...settings.overlays, timecode: event.target.checked } })} /> Timecode</label>
            <label><input type="checkbox" checked={settings.overlays.badges} onChange={(event) => patchSettings({ overlays: { ...settings.overlays, badges: event.target.checked } })} /> BPM + key badge</label>
            <label><input type="checkbox" checked={settings.overlays.sections} onChange={(event) => patchSettings({ overlays: { ...settings.overlays, sections: event.target.checked } })} /> Section marker</label>
            <label className="viz-caption">Caption <input aria-label="Caption text" type="text" maxLength={120} value={settings.overlays.caption} placeholder="your YouTube caption" onChange={(event) => patchSettings({ overlays: { ...settings.overlays, caption: event.target.value } })} /></label>
          </div>
          <div className="viz-settings-row">
            <label>Grain <input aria-label="Grain" type="range" min={0} max={1} step={0.05} value={settings.postFx.grain} onChange={(event) => patchSettings({ postFx: { ...settings.postFx, grain: Number(event.target.value) } })} /></label>
            <label>Scanlines <input aria-label="Scanlines" type="range" min={0} max={1} step={0.05} value={settings.postFx.scanlines} onChange={(event) => patchSettings({ postFx: { ...settings.postFx, scanlines: Number(event.target.value) } })} /></label>
            <label>Aberration <input aria-label="Chromatic aberration" type="range" min={0} max={1} step={0.05} value={settings.postFx.aberration} onChange={(event) => patchSettings({ postFx: { ...settings.postFx, aberration: Number(event.target.value) } })} /></label>
            <label>Vignette <input aria-label="Vignette" type="range" min={0} max={1} step={0.05} value={settings.postFx.vignette} onChange={(event) => patchSettings({ postFx: { ...settings.postFx, vignette: Number(event.target.value) } })} /></label>
            <label><input type="checkbox" checked={settings.postFx.letterbox} onChange={(event) => patchSettings({ postFx: { ...settings.postFx, letterbox: event.target.checked } })} /> 21:9 letterbox</label>
          </div>
          <div className="viz-settings-row viz-settings-footer">
            <small>Web MIDI: {midiStatus === "off" ? <button className="deck-chip" onClick={() => void enableMidi()}>Connect</button> : midiStatus === "on" ? `connected${midiLabel !== null ? ` (${midiLabel})` : ""} — C3–C4 select scenes, C#4 is Auto, faders 70+ are stem volumes` : midiStatus === "unsupported" ? "not available in this browser" : "connection refused"}</small>
            <small>Profile saved per project.</small>
            <button className="deck-chip" onClick={() => { setSettings(DEFAULT_VIZ_SETTINGS); setNotice("Visuals reset to defaults."); }}>Reset</button>
          </div>
        </div>
      )}
      {reducedMotion ? (
        <div className="visualizer-still" role="status">Reduced motion is on — the visualizer stays still. Pin a scene and press play to let it listen.</div>
      ) : (
        <canvas
          ref={canvasRef}
          className={`visualizer-canvas ${lassoMode ? "lasso" : ""}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            onPointer(event, true);
          }}
          onPointerMove={(event) => onPointer(event, event.buttons !== 0 || event.pointerType === "mouse")}
          onPointerUp={onPointerUp}
          onPointerLeave={(event) => onPointer(event, false)}
        />
      )}
      <div className="viz-record">
        {recording ? (
          <button className="button" onClick={stopRecording}>⏹ Stop recording</button>
        ) : (
          <button className="button secondary" onClick={() => void startRecording()}>⏺ Record visualizer (.webm)</button>
        )}
        <small>records the canvas at 30 fps with the master bus audio — YouTube-ready</small>
        {videoUrl !== null && (
          <span className="chop-render-result">
            <video controls src={videoUrl} />
            <a className="button" href={videoUrl} download="waveyard-visualizer.webm">Download .webm</a>
          </span>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- helpers

/** Beat phase from the manual anchor (taps). */
function tappedPhase(nowMs: number, anchor: { anchorMs: number; bpm: number }): number {
  const interval = 60_000 / anchor.bpm;
  const elapsed = Math.max(0, nowMs - anchor.anchorMs);
  return (elapsed % interval) / interval;
}

/** Scenes the director may pick beyond the classic six (data-gated). */
function extraScenes(hasChords: boolean, hasPhrases: boolean, hasChops: boolean): SceneId[] {
  return [
    "helix",
    "waterfall",
    "beatcity",
    "circuit",
    ...(hasChords ? (["halo"] as SceneId[]) : []),
    ...(hasPhrases ? (["lyrics"] as SceneId[]) : []),
    ...(hasChops ? (["chopgalaxy"] as SceneId[]) : []),
  ];
}

/** Overlay captions — drawn above post FX, below the letterbox. */
function drawOverlays(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  settings: VizSettings,
  meta: { bpm: number | null; musicalKey: string | null; title: string | null; artist: string | null; sections: Array<{ startMs: number; endMs: number; startBar: number; endBar: number }> },
  positionSeconds: number,
  positionMs: number,
): void {
  const positions = overlayPositions(width, height);
  if (settings.overlays.title && meta.title !== null) {
    ctx.fillStyle = "rgba(245, 244, 240, 0.95)";
    ctx.font = "bold 16px ui-monospace, monospace";
    ctx.fillText(meta.title.length > 48 ? `${meta.title.slice(0, 45)}…` : meta.title, positions.title.x, positions.title.y);
    if (meta.artist !== null) {
      ctx.fillStyle = "rgba(127, 135, 150, 0.95)";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText(meta.artist, positions.title.x, positions.title.y + 18);
    }
  }
  if (settings.overlays.timecode) {
    ctx.fillStyle = "rgba(245, 244, 240, 0.9)";
    ctx.font = "13px ui-monospace, monospace";
    ctx.fillText(timecodeLabel(positionSeconds), positions.title.x, height - Math.max(10, height * 0.04));
  }
  if (settings.overlays.badges) {
    const badge = [meta.bpm !== null ? `${Math.round(meta.bpm * 10) / 10} BPM` : null, meta.musicalKey].filter(Boolean).join(" · ");
    if (badge.length > 0) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(245, 244, 240, 0.9)";
      ctx.font = "bold 12px ui-monospace, monospace";
      ctx.fillText(badge, positions.badge.x, positions.badge.y);
      ctx.textAlign = "left";
    }
  }
  if (settings.overlays.sections) {
    const section = meta.sections.find((item) => positionMs >= item.startMs && positionMs < item.endMs);
    if (section !== undefined) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(214, 251, 84, 0.9)";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText(`bars ${section.startBar}–${section.endBar}`, positions.section.x, positions.section.y);
      ctx.textAlign = "left";
    }
  }
  if (settings.overlays.caption.length > 0) {
    ctx.fillStyle = "rgba(245, 244, 240, 0.92)";
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillText(settings.overlays.caption, positions.caption.x, positions.caption.y);
  }
}
