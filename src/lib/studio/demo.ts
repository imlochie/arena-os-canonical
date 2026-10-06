// Demo engine — fully local, deterministic procedural previews.
//
// When no generation backend is reachable (no GPU, offline, first run), the
// Studio still works end-to-end: jobs run through a simulated pipeline
// (load → encode → denoise → decode → save) and produce procedural media:
//   video → animated SVG scene (plays in any browser)
//   image → static SVG artwork
//   audio → synthesized WAV (chords + melody from the prompt seed)
//
// Everything is derived deterministically from the job's seed + prompt, so
// media can be regenerated on demand without caching. This mirrors the app's
// Local Mode philosophy: the app never hard-fails, and nothing leaves the
// machine. Demo output is clearly labelled — it is NOT model generation.

import type { BackendJobSnapshot } from "./types";

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoSeed(prompt: string, seed: number | null | undefined): number {
  return typeof seed === "number" && Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 2147483647 : hashString(prompt) % 2147483647;
}

interface DemoJobShape {
  prompt: string;
  modelType: string;
  modelName: string;
  modality: "video" | "image" | "audio";
  settings: Record<string, unknown>;
  seed: number | null;
}

// Simulated wall-clock duration — short enough to demo, long enough to feel real.
export function demoEstimateMs(job: DemoJobShape): number {
  const steps = Number(job.settings.num_inference_steps ?? job.settings.steps ?? 20) || 20;
  const base = job.modality === "video" ? 14000 : job.modality === "image" ? 8000 : 10000;
  return Math.min(40000, base + steps * 320);
}

const PHASES: { until: number; phase: (frac: number, job: DemoJobShape) => string }[] = [
  { until: 0.08, phase: () => "loading model" },
  { until: 0.18, phase: () => "encoding prompt" },
  {
    until: 0.85,
    phase: (frac, job) => {
      const steps = Number(job.settings.num_inference_steps ?? job.settings.steps ?? 20) || 20;
      const step = Math.max(1, Math.min(steps, Math.ceil(((frac - 0.18) / 0.67) * steps)));
      return `denoising · step ${step}/${steps}`;
    },
  },
  { until: 0.95, phase: () => "decoding frames" },
  { until: 1.0, phase: () => "saving output" },
];

// Pure function of (now - createdAt) — no timers needed.
export function demoSnapshot(job: DemoJobShape, createdAtMs: number): BackendJobSnapshot {
  const total = demoEstimateMs(job);
  const elapsed = Date.now() - createdAtMs;
  if (elapsed < 0) return { status: "queued", phase: "queued", progress: 0, files: [] };
  const frac = Math.min(1, elapsed / total);
  if (frac >= 1) {
    const ext = job.modality === "video" ? "preview.svg" : job.modality === "image" ? "artwork.svg" : "preview.wav";
    const mediaType =
      job.modality === "audio" ? "audio/wav" : job.modality === "image" ? "image/svg+xml" : "image/svg+xml";
    return {
      status: "completed",
      phase: "done",
      progress: 1,
      files: [{ name: ext, mediaType, kind: job.modality }],
    };
  }
  for (const p of PHASES) {
    if (frac < p.until) {
      return { status: frac < 0.08 ? "queued" : "running", phase: p.phase(frac, job), progress: frac, files: [] };
    }
  }
  return { status: "running", phase: "finishing", progress: frac, files: [] };
}

// ---- procedural media ----

const PALETTES = [
  ["#0ea5e9", "#6366f1", "#a855f7", "#22d3ee"],
  ["#f97316", "#ef4444", "#f59e0b", "#fb7185"],
  ["#10b981", "#14b8a6", "#22c55e", "#84cc16"],
  ["#8b5cf6", "#d946ef", "#6366f1", "#f472b6"],
  ["#0f172a", "#334155", "#64748b", "#38bdf8"],
];

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

function captionFor(prompt: string): string {
  return prompt.split(/\s+/).slice(0, 8).join(" ").slice(0, 60) || "procedural preview";
}

export function demoAnimatedSvg(job: DemoJobShape): string {
  const seed = demoSeed(job.prompt, job.seed);
  const rnd = mulberry32(seed);
  const pal = PALETTES[seed % PALETTES.length];
  const duration = Math.max(2, Math.min(12, Number(job.settings.duration_seconds ?? job.settings.duration ?? 4) || 4));
  const w = 960;
  const h = 540;
  const dur = `${duration}s`;

  let orbs = "";
  const n = 10 + (seed % 8);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(rnd() * w);
    const cy = Math.floor(rnd() * h);
    const r = Math.floor(18 + rnd() * 90);
    const c = pal[Math.floor(rnd() * pal.length)];
    const o = (0.18 + rnd() * 0.42).toFixed(2);
    const dx = Math.floor(rnd() * 240 - 120);
    const dy = Math.floor(rnd() * 160 - 80);
    const begin = `-${(rnd() * duration).toFixed(2)}s`;
    orbs +=
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" opacity="${o}">` +
      `<animateTransform attributeName="transform" type="translate" values="0 0; ${dx} ${dy}; 0 0" dur="${dur}" begin="${begin}" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="${o};${(Number(o) * 0.4).toFixed(2)};${o}" dur="${dur}" begin="${begin}" repeatCount="indefinite"/>` +
      `</circle>`;
  }

  let stars = "";
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(rnd() * w);
    const y = Math.floor(rnd() * h * 0.7);
    const s = (0.6 + rnd() * 1.8).toFixed(1);
    stars += `<circle cx="${x}" cy="${y}" r="${s}" fill="#fff" opacity="${(0.2 + rnd() * 0.6).toFixed(2)}"/>`;
  }

  let hills = "";
  for (let i = 0; i < 3; i++) {
    const y = h * (0.55 + i * 0.14);
    const amp = 40 + rnd() * 60;
    const c = pal[(i + 2) % pal.length];
    hills +=
      `<path d="M0 ${y} Q ${w * 0.25} ${y - amp} ${w * 0.5} ${y} T ${w} ${y} L ${w} ${h} L 0 ${h} Z" fill="${c}" opacity="${(0.35 - i * 0.08).toFixed(2)}">` +
      `<animateTransform attributeName="transform" type="translate" values="0 0; ${Math.floor(8 + i * 10)} 0; 0 0" dur="${(duration * 3).toFixed(0)}s" repeatCount="indefinite"/>` +
      `</path>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>` +
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${pal[0]}"><animate attributeName="stop-color" values="${pal[0]};${pal[2]};${pal[0]}" dur="${dur}" repeatCount="indefinite"/></stop>` +
    `<stop offset="1" stop-color="${pal[1]}"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="100%" height="100%" fill="url(#sky)"/>` +
    stars +
    orbs +
    hills +
    `<rect x="0" y="${h - 58}" width="${w}" height="58" fill="#000" opacity="0.5"/>` +
    `<text x="20" y="${h - 32}" font-family="ui-monospace,monospace" font-size="17" fill="#fff" opacity="0.95">${esc(captionFor(job.prompt))}</text>` +
    `<text x="20" y="${h - 14}" font-family="ui-monospace,monospace" font-size="12" fill="#a5f3fc" opacity="0.9">demo mode · procedural preview (${duration}s) · seed ${seed}</text>` +
    `</svg>`
  );
}

export function demoStaticSvg(job: DemoJobShape): string {
  const seed = demoSeed(job.prompt, job.seed);
  const rnd = mulberry32(seed);
  const pal = PALETTES[seed % PALETTES.length];
  const w = 832;
  const h = 832;
  let shapes = "";
  for (let i = 0; i < 26; i++) {
    const cx = Math.floor(rnd() * w);
    const cy = Math.floor(rnd() * h);
    const c = pal[Math.floor(rnd() * pal.length)];
    const o = (0.15 + rnd() * 0.5).toFixed(2);
    if (rnd() > 0.5) {
      const rw = Math.floor(40 + rnd() * w * 0.3);
      const rh = Math.floor(30 + rnd() * h * 0.25);
      const rot = Math.floor(rnd() * 60 - 30);
      shapes += `<rect x="${cx}" y="${cy}" width="${rw}" height="${rh}" rx="20" fill="${c}" opacity="${o}" transform="rotate(${rot} ${cx} ${cy})"/>`;
    } else {
      const r = Math.floor(16 + rnd() * Math.min(w, h) * 0.2);
      shapes += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" opacity="${o}"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>${shapes}` +
    `<rect x="0" y="${h - 64}" width="${w}" height="64" fill="#000" opacity="0.45"/>` +
    `<text x="20" y="${h - 24}" font-family="system-ui,sans-serif" font-size="22" fill="#fff" opacity="0.92">${esc(captionFor(job.prompt))}</text>` +
    `</svg>`
  );
}

// ---- WAV synthesis ----

export function demoWav(job: DemoJobShape): Buffer {
  const seed = demoSeed(job.prompt, job.seed);
  const rnd = mulberry32(seed);
  const sampleRate = 22050;
  const duration = Math.max(2, Math.min(20, Number(job.settings.duration_seconds ?? job.settings.duration ?? 6) || 6));
  const total = Math.floor(sampleRate * duration);

  // pick a key + progression from the seed
  const roots = [220, 233.08, 246.94, 261.63, 277.18, 293.66];
  const root = roots[seed % roots.length];
  const progressions = [
    [1, 5 / 4, 3 / 2],
    [1, 6 / 5, 3 / 2],
    [1, 4 / 3, 3 / 2],
    [1, 5 / 4, 4 / 3],
  ];
  const chord = progressions[seed % progressions.length];
  const bars = Math.max(1, Math.round(duration / 2));
  const melodyScale = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];

  const samples = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const barF = Math.min(bars - 1, Math.floor((t / duration) * bars));
    const baseFreq = root * Math.pow(2, (barF % 3) / 12);
    let v = 0;
    // chord pad (soft sine mix)
    for (let c = 0; c < chord.length; c++) {
      const f = baseFreq * chord[c];
      v += 0.16 * Math.sin(2 * Math.PI * f * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.15 * t + c));
    }
    // melody: seeded note per half-bar
    const halfIdx = Math.floor((t / duration) * bars * 2);
    const mRnd = mulberry32(seed + halfIdx * 7919);
    if (mRnd() > 0.25) {
      const note = melodyScale[Math.floor(mRnd() * melodyScale.length)];
      const f = baseFreq * 2 * note;
      const halfLen = duration / (bars * 2);
      const localT = t % halfLen;
      const env = Math.exp(-3.5 * (localT / halfLen));
      v += 0.22 * env * Math.sin(2 * Math.PI * f * t);
    }
    // simple kick every half bar
    const halfT = t % (duration / (bars * 2));
    if (halfT < 0.09) {
      v += 0.35 * Math.exp(-halfT * 40) * Math.sin(2 * Math.PI * 52 * halfT);
    }
    // master envelope (fade in/out)
    const fade = Math.min(1, t / 0.4) * Math.min(1, (duration - t) / 0.6);
    const clamped = Math.max(-1, Math.min(1, v * fade * 0.85));
    samples[i] = Math.round(clamped * 32767);
  }

  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function demoMedia(job: DemoJobShape, fileName: string): { body: string | Buffer; mediaType: string } {
  if (job.modality === "audio" || fileName.endsWith(".wav")) {
    return { body: demoWav(job), mediaType: "audio/wav" };
  }
  if (job.modality === "image") {
    return { body: demoStaticSvg(job), mediaType: "image/svg+xml" };
  }
  return { body: demoAnimatedSvg(job), mediaType: "image/svg+xml" };
}
