// Cut Lab — canvas frame renderer.
//
// Draws one timeline frame to a 2D canvas:
//   video clips  → drawImage(<video>) at the right source time
//   image clips  → drawImage(<img>)
//   procedural   → seeded animated gradient/shapes (works with zero assets)
// Everything is letterboxed into the project aspect.

import { CUT_PALETTES, buildTimeline as buildTimelineSafe, mulberry32, type CutClip, type TimelineSegment } from "./types";

export interface MediaPool {
  videos: Map<string, HTMLVideoElement>;
  images: Map<string, HTMLImageElement>;
}

export function createMediaPool(): MediaPool {
  return { videos: new Map(), images: new Map() };
}

export function getVideo(pool: MediaPool, src: string): HTMLVideoElement {
  let el = pool.videos.get(src);
  if (!el) {
    el = document.createElement("video");
    el.src = src;
    el.preload = "auto";
    el.playsInline = true;
    el.crossOrigin = "anonymous"; // same-origin proxy is fine; needed if http URL used
    pool.videos.set(src, el);
  }
  return el;
}

export function getImage(pool: MediaPool, src: string): HTMLImageElement {
  let el = pool.images.get(src);
  if (!el) {
    el = new Image();
    el.crossOrigin = "anonymous";
    el.src = src;
    pool.images.set(src, el);
  }
  return el;
}

// Preload every clip's media (call before playback/export).
export async function preloadPool(pool: MediaPool, clips: CutClip[]): Promise<void> {
  await Promise.all(
    clips.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.kind === "video" && c.src && !c.unlinked) {
            const el = getVideo(pool, c.src);
            if (el.readyState >= 2) return resolve();
            const done = () => resolve();
            el.addEventListener("loadeddata", done, { once: true });
            el.addEventListener("error", done, { once: true });
            // metadata may never load (404 etc.) — don't hang forever
            setTimeout(done, 8000);
          } else if (c.kind === "image" && c.src && !c.unlinked) {
            const el = getImage(pool, c.src);
            if (el.complete) return resolve();
            const done = () => resolve();
            el.addEventListener("load", done, { once: true });
            el.addEventListener("error", done, { once: true });
            setTimeout(done, 8000);
          } else {
            resolve();
          }
        })
    )
  );
}

// Measure a video source's duration (0 if unreadable).
export function probeDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    el.src = src;
    const done = (v: number) => {
      el.removeAttribute("src");
      resolve(v);
    };
    el.addEventListener("loadedmetadata", () => done(Number.isFinite(el.duration) ? el.duration : 0), { once: true });
    el.addEventListener("error", () => done(0), { once: true });
    setTimeout(() => done(0), 8000);
  });
}

function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement,
  w: number,
  h: number
) {
  const mw = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return;
  const scale = Math.min(w / mw, h / mh);
  const dw = mw * scale;
  const dh = mh * scale;
  ctx.drawImage(media, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawProcedural(ctx: CanvasRenderingContext2D, clip: CutClip, localT: number, w: number, h: number) {
  const seed = (clip.seed ?? 1) >>> 0;
  const rnd = mulberry32(seed);
  const pal = CUT_PALETTES[seed % CUT_PALETTES.length];
  const cycle = Math.max(1, clip.duration);

  // sky gradient shifting over the clip's local time
  const shift = (Math.sin(localT * ((0.5 + rnd()) * 1.2)) + 1) / 2;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  const c1 = pal[Math.floor(shift * (pal.length - 1))];
  const c2 = pal[(Math.floor(shift * (pal.length - 1)) + 2) % pal.length];
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // drifting orbs (deterministic from seed + time)
  const n = 8 + (seed % 6);
  for (let i = 0; i < n; i++) {
    const bx = rnd() * w;
    const by = rnd() * h * 0.8;
    const r = (0.04 + rnd() * 0.12) * Math.min(w, h);
    const speed = 0.3 + rnd() * 1.4;
    const phase = rnd() * Math.PI * 2;
    const x = bx + Math.sin(localT * speed + phase) * w * 0.06;
    const y = by + Math.cos(localT * speed * 0.7 + phase) * h * 0.04;
    ctx.globalAlpha = 0.18 + rnd() * 0.3;
    ctx.fillStyle = pal[i % pal.length];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ground bars
  for (let i = 0; i < 3; i++) {
    const y = h * (0.62 + i * 0.12);
    ctx.fillStyle = pal[(i + 2) % pal.length];
    ctx.globalAlpha = 0.35 - i * 0.09;
    ctx.fillRect(0, y, w, h * 0.12);
  }
  ctx.globalAlpha = 1;

  // caption strip
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, h - Math.round(h * 0.08), w, Math.round(h * 0.08));
  ctx.fillStyle = "#a5f3fc";
  ctx.font = `${Math.round(h * 0.03)}px ui-monospace, monospace`;
  ctx.fillText(
    `procedural clip · seed ${seed} · ${(localT % cycle).toFixed(1)}s / ${cycle.toFixed(1)}s`,
    Math.round(w * 0.02),
    h - Math.round(h * 0.025)
  );
}

// Keep the active clip's <video> element synced to timeline time and pause the
// rest. Must be called from event handlers / rAF loops (mutates media elements).
export function driveMediaAt(pool: MediaPool, clips: CutClip[], t: number, wantPlaying: boolean): void {
  const { segments: segs } = buildTimelineSafe(clips);
  const seg = segs.length ? segs.find((s) => t >= s.start && t < s.end) ?? segs[segs.length - 1] : null;
  const activeEl =
    seg && seg.clip.kind === "video" && seg.clip.src && !seg.clip.unlinked ? pool.videos.get(seg.clip.src) : undefined;
  for (const el of pool.videos.values()) {
    if (el === activeEl && seg) {
      const localT = t - seg.start + seg.localStart;
      el.volume = Math.max(0, Math.min(1, seg.clip.volume ?? 1));
      el.muted = el.volume === 0;
      if (Math.abs(el.currentTime - localT) > 0.3) {
        try {
          el.currentTime = localT;
        } catch {
          /* seeking not ready */
        }
      }
      if (wantPlaying && el.paused) void el.play().catch(() => {});
      if (!wantPlaying && !el.paused) el.pause();
    } else if (!el.paused) {
      el.pause();
    }
  }
}

export interface RenderArgs {
  ctx: CanvasRenderingContext2D;
  pool: MediaPool;
  segment: TimelineSegment | null;
  time: number; // timeline time (s)
}

export function renderFrame({ ctx, pool, segment, time }: RenderArgs): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // background
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, w, h);

  if (!segment) {
    ctx.fillStyle = "#334155";
    ctx.font = `${Math.round(h * 0.04)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("add clips to start cutting", w / 2, h / 2);
    ctx.textAlign = "left";
    return;
  }

  const clip = segment.clip;
  const localT = Math.max(0, time - segment.start) + segment.localStart;

  if (clip.kind === "video" && clip.src && !clip.unlinked) {
    const el = getVideo(pool, clip.src);
    if (el.readyState >= 2) drawLetterboxed(ctx, el, w, h);
    else {
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#64748b";
      ctx.font = `${Math.round(h * 0.03)}px system-ui, sans-serif`;
      ctx.fillText(`loading ${clip.name}…`, 16, h / 2);
    }
  } else if (clip.kind === "image" && clip.src && !clip.unlinked) {
    const el = getImage(pool, clip.src);
    if (el.complete && el.naturalWidth) drawLetterboxed(ctx, el, w, h);
    else {
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, w, h);
    }
  } else {
    drawProcedural(ctx, clip, localT, w, h);
  }

  if (clip.unlinked) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fbbf24";
    ctx.font = `${Math.round(h * 0.035)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("clip unlinked — re-import the source file", w / 2, h / 2);
    ctx.textAlign = "left";
  }
}
