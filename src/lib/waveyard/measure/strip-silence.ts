/**
 * Strip silence — detect audible segments and remove the gaps between them
 * (the Pro Tools "Strip Silence" edit, as implemented by SoundCraft's
 * offline processing, Copyright (c) 2026 ArtCraft Team and SoundCraft
 * contributors, dual-licensed MIT OR Apache-2.0,
 * https://github.com/storytold/soundcraft; clean-room TypeScript port).
 *
 * Detection is frame-peak based: a frame is audible when its peak reaches
 * the threshold. Short gaps below `minGapMs` are bridged (kept), short
 * blips below `minSegmentMs` are dropped, and every kept segment is padded
 * by `padMs` on both sides so transients keep their attack.
 */

import { dspGainToDb } from "../mixer/dsp";
import type { StereoBuffer } from "../mixer/dsp";

export type StripSilenceOptions = {
  /** Frame peak threshold in dBFS (frames at/above it are audible). */
  thresholdDb: number; // −90..0
  /** Analysis frame length in ms. */
  frameMs: number; // 1..200
  /** Segments shorter than this are dropped. */
  minSegmentMs: number; // 0..5000
  /** Gaps shorter than this are bridged instead of stripped. */
  minGapMs: number; // 0..5000
  /** Padding added around each kept segment. */
  padMs: number; // 0..500
};

export const DEFAULT_STRIP_SILENCE: StripSilenceOptions = {
  thresholdDb: -50,
  frameMs: 20,
  minSegmentMs: 250,
  minGapMs: 250,
  padMs: 20,
};

export type AudibleSegment = {
  startMs: number;
  endMs: number;
  startFrame: number;
  endFrame: number; // exclusive
};

export type StripSilencePlan = {
  segments: AudibleSegment[];
  totalFrames: number;
  keptFrames: number;
  keptMs: number;
  removedMs: number;
};

export function detectAudibleSegments(
  buffer: StereoBuffer,
  sampleRate: number,
  options: Partial<StripSilenceOptions> = {},
): StripSilencePlan {
  const opts = { ...DEFAULT_STRIP_SILENCE, ...options };
  const frames = buffer.length / 2;
  const frameSize = Math.max(1, Math.round((opts.frameMs / 1000) * sampleRate));
  const minSegFrames = Math.max(0, Math.round((opts.minSegmentMs / 1000) * sampleRate));
  const minGapFrames = Math.max(0, Math.round((opts.minGapMs / 1000) * sampleRate));
  const padFrames = Math.max(0, Math.round((opts.padMs / 1000) * sampleRate));

  // Raw audible runs from per-frame peaks, in sample-frame boundaries.
  const analysisFrames = Math.ceil(frames / frameSize);
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let f = 0; f < analysisFrames; f += 1) {
    let peak = 0;
    const end = Math.min((f + 1) * frameSize, frames);
    for (let i = f * frameSize; i < end; i += 1) {
      const l = Math.abs(buffer[i * 2]);
      const r = Math.abs(buffer[i * 2 + 1]);
      if (l > peak) peak = l;
      if (r > peak) peak = r;
    }
    const audible = dspGainToDb(peak) >= opts.thresholdDb;
    if (audible && runStart < 0) runStart = f * frameSize;
    if ((!audible || f === analysisFrames - 1) && runStart >= 0) {
      const runEnd = audible ? end : f * frameSize;
      runs.push([runStart, runEnd]);
      runStart = -1;
    }
  }

  // Bridge short gaps, then drop short segments.
  const bridged: Array<[number, number]> = [];
  for (const run of runs) {
    const prev = bridged[bridged.length - 1];
    if (prev !== undefined && run[0] - prev[1] < minGapFrames) {
      prev[1] = run[1];
    } else {
      bridged.push([run[0], run[1]]);
    }
  }
  const kept = bridged.filter(([start, end]) => end - start >= minSegFrames);

  // Pad each segment, clamped to the buffer and to its neighbours.
  const segments: AudibleSegment[] = [];
  for (let s = 0; s < kept.length; s += 1) {
    const [rawStart, rawEnd] = kept[s];
    const prev = kept[s - 1];
    const next = kept[s + 1];
    const maxStart = prev === undefined ? 0 : prev[1];
    const minEnd = next === undefined ? frames : next[0];
    const start = Math.max(maxStart, rawStart - padFrames);
    const end = Math.min(minEnd, rawEnd + padFrames);
    if (end <= start) continue;
    segments.push({
      startFrame: start,
      endFrame: end,
      startMs: (start / sampleRate) * 1000,
      endMs: (end / sampleRate) * 1000,
    });
  }

  const keptFrames = segments.reduce((sum, seg) => sum + (seg.endFrame - seg.startFrame), 0);
  return {
    segments,
    totalFrames: frames,
    keptFrames,
    keptMs: (keptFrames / sampleRate) * 1000,
    removedMs: ((frames - keptFrames) / sampleRate) * 1000,
  };
}

/**
 * Rebuild the buffer with only the planned segments, in order. Returns a
 * new buffer; the input is untouched.
 */
export function stripSilence(
  buffer: StereoBuffer,
  sampleRate: number,
  options: Partial<StripSilenceOptions> = {},
): StereoBuffer {
  const plan = detectAudibleSegments(buffer, sampleRate, options);
  const out = new Float32Array(plan.keptFrames * 2);
  let cursor = 0;
  for (const seg of plan.segments) {
    const length = (seg.endFrame - seg.startFrame) * 2;
    out.set(buffer.subarray(seg.startFrame * 2, seg.endFrame * 2), cursor);
    cursor += length;
  }
  return out;
}
