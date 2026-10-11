/**
 * VizSettings — the customization layer for the sound visualizer
 * (vision §V4: "customisation layers"). Everything the user can tune lives
 * in one plain object: reactivity, trails, particles, time scale, the
 * director's policy, the palette, post FX, and overlay captions.
 *
 * Pure and total: `parseVizSettings` accepts ANY unknown value (localStorage
 * is hostile input) and returns a fully-clamped settings object or null —
 * unknown fields are stripped, every number is clamped to its honest range.
 * The object is persisted per project (localStorage) and threaded into the
 * engine + the draw layer.
 */

import type { SceneId } from "./visualizer";

export type VizPostFx = {
  /** Film grain strength 0–1. */
  grain: number;
  /** Scanline strength 0–1. */
  scanlines: number;
  /** Chromatic aberration strength 0–1. */
  aberration: number;
  /** Vignette strength 0–1. */
  vignette: number;
  /** 21:9 letterbox (YouTube-native framing). */
  letterbox: boolean;
};

export type VizOverlays = {
  /** Title + artist caption. */
  title: boolean;
  /** Running timecode. */
  timecode: boolean;
  /** BPM + key badge. */
  badges: boolean;
  /** Current section marker. */
  sections: boolean;
  /** Free-text caption (empty string = off). */
  caption: string;
};

export type VizSettings = {
  /** Reactivity multiplier 0.25–3 (scales feature-derived motion). */
  energy: number;
  /** Trail persistence 0–1 (0 = hard clear, 1 = long smear). */
  trails: number;
  /** Particle cap 60–1200. */
  particleCap: number;
  /** Time scale 0.25–1 (slow motion). */
  timeScale: number;
  /** Director dwell 2000–30000 ms. */
  dwellMs: number;
  /** Scene whitelist (empty = every scene allowed). */
  sceneWhitelist: SceneId[];
  /** Palette: the studio stem colors, or a custom set (e.g. from a cover). */
  palette: { mode: "stems" | "custom"; colors: string[] };
  postFx: VizPostFx;
  overlays: VizOverlays;
};

export const DEFAULT_VIZ_SETTINGS: VizSettings = {
  energy: 1,
  trails: 0.5,
  particleCap: 600,
  timeScale: 1,
  dwellMs: 12_000,
  sceneWhitelist: [],
  palette: { mode: "stems", colors: [] },
  postFx: { grain: 0, scanlines: 0, aberration: 0, vignette: 0, letterbox: false },
  overlays: { title: false, timecode: false, badges: false, sections: false, caption: "" },
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && HEX_COLOR.test(item)).slice(0, max);
}

/** localStorage key for a project's visualizer profile. */
export function vizSettingsKey(projectId: string): string {
  return `waveyard:viz:${projectId}`;
}

/**
 * Parse + validate ANY value into settings (or null when it isn't an
 * object at all). Unknown fields are stripped; every knob is clamped.
 */
export function parseVizSettings(raw: unknown): VizSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const postFxRaw = typeof input.postFx === "object" && input.postFx !== null && !Array.isArray(input.postFx) ? input.postFx as Record<string, unknown> : {};
  const overlaysRaw = typeof input.overlays === "object" && input.overlays !== null && !Array.isArray(input.overlays) ? input.overlays as Record<string, unknown> : {};
  const paletteRaw = typeof input.palette === "object" && input.palette !== null && !Array.isArray(input.palette) ? input.palette as Record<string, unknown> : {};

  const whitelistSource = Array.isArray(input.sceneWhitelist) ? input.sceneWhitelist : [];
  const whitelist = whitelistSource.filter((item): item is string => typeof item === "string") as SceneId[];

  const captionRaw = overlaysRaw.caption;
  const caption = typeof captionRaw === "string" ? captionRaw.slice(0, 120) : "";

  return {
    energy: clampNumber(input.energy, 0.25, 3, DEFAULT_VIZ_SETTINGS.energy),
    trails: clampNumber(input.trails, 0, 1, DEFAULT_VIZ_SETTINGS.trails),
    particleCap: Math.round(clampNumber(input.particleCap, 60, 1200, DEFAULT_VIZ_SETTINGS.particleCap)),
    timeScale: clampNumber(input.timeScale, 0.25, 1, DEFAULT_VIZ_SETTINGS.timeScale),
    dwellMs: Math.round(clampNumber(input.dwellMs, 2000, 30_000, DEFAULT_VIZ_SETTINGS.dwellMs)),
    sceneWhitelist: whitelist,
    palette: {
      mode: paletteRaw.mode === "custom" ? "custom" : "stems",
      colors: parseStringArray(paletteRaw.colors, 8),
    },
    postFx: {
      grain: clampNumber(postFxRaw.grain, 0, 1, 0),
      scanlines: clampNumber(postFxRaw.scanlines, 0, 1, 0),
      aberration: clampNumber(postFxRaw.aberration, 0, 1, 0),
      vignette: clampNumber(postFxRaw.vignette, 0, 1, 0),
      letterbox: postFxRaw.letterbox === true,
    },
    overlays: {
      title: overlaysRaw.title === true,
      timecode: overlaysRaw.timecode === true,
      badges: overlaysRaw.badges === true,
      sections: overlaysRaw.sections === true,
      caption,
    },
  };
}

/** Load a project's persisted profile (null when absent or corrupt). */
export function loadVizSettings(projectId: string): VizSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(vizSettingsKey(projectId));
    if (raw === null) return null;
    return parseVizSettings(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Persist a project's profile. Settings are trusted (already clamped). */
export function saveVizSettings(projectId: string, settings: VizSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(vizSettingsKey(projectId), JSON.stringify(settings));
  } catch {
    // Storage full or blocked — the profile just doesn't persist.
  }
}
