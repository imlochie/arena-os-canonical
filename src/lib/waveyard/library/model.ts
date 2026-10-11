/**
 * Waveyard listening-layer domain model (docs/waveyard-evolution-plan.md).
 *
 * Pure logic for the TRACK / PLAYER / SESSION layers: the canonical stem
 * channel view (four-stem simple, N-stem capable), honest stem availability
 * (reusing the engine's provenance vocabulary — engine "passthrough-
 * unseparated" means full-source-only), per-track stem mixes (persisted as
 * JSON text in wy_listen_session_tracks / wy_playback_state), and filename →
 * track-metadata derivation for library intake.
 *
 * Everything here is storage-agnostic and side-effect free so the player,
 * session, and API layers share ONE definition of these rules.
 */

/** The canonical default stem channels, in player order. `other` is the
 * standard fourth separation stem (melody/instrumental) — displayed as
 * MELODY, but the identity used across the engine is `other`. */
export const DEFAULT_STEM_CHANNEL_TYPES = ["vocals", "drums", "bass", "other"] as const;

export type DefaultStemChannelType = (typeof DEFAULT_STEM_CHANNEL_TYPES)[number];

/** Player-facing display names. `other` is MELODY / instrumental. */
export const STEM_CHANNEL_LABELS: Record<string, string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  other: "Melody",
};

/** A stem channel as the player renders it: the four defaults always shown
 * in a stable order (missing ones honestly disabled), plus any additional
 * stem types the separation engine actually produced. */
export interface StemChannel {
  stemType: string;
  label: string;
  /** True when a real stem asset of this type exists for the track. */
  available: boolean;
}

/** Build the channel view for a track from its actual stem types. The
 * architecture never hard-codes four: extra types (future separation
 * models) render as additional channels after the defaults. */
export function buildStemChannels(stemTypes: readonly string[]): StemChannel[] {
  const present = new Set(stemTypes);
  const channels: StemChannel[] = DEFAULT_STEM_CHANNEL_TYPES.map((stemType) => ({
    stemType,
    label: STEM_CHANNEL_LABELS[stemType] ?? stemType,
    available: present.has(stemType),
  }));
  for (const stemType of stemTypes) {
    if ((DEFAULT_STEM_CHANNEL_TYPES as readonly string[]).includes(stemType)) continue;
    channels.push({ stemType, label: STEM_CHANNEL_LABELS[stemType] ?? stemType[0]?.toUpperCase() + stemType.slice(1), available: true });
  }
  return channels;
}

/** Honest stem availability for a track, derived from REAL stem rows. */
export type StemAvailability =
  | { status: "separated"; stemCount: number }
  | { status: "source-only"; reason: string }
  | { status: "processing"; reason: string }
  | { status: "unavailable"; reason: string };

export interface StemAvailabilityInput {
  /** Real stem_assets rows for the track's source (any engine). */
  stems: Array<{ stemType: string; engine: string }>;
  /** A separation job for the source exists and has not finished/failed. */
  separationPending?: boolean;
}

/** The passthrough bridge (POST /api/stems/passthrough) creates one
 * "source"-typed stem with this engine when separation cannot run. */
export const PASSTHROUGH_ENGINE = "passthrough-unseparated";

export function resolveStemAvailability(input: StemAvailabilityInput): StemAvailability {
  const real = input.stems.filter((stem) => stem.engine !== PASSTHROUGH_ENGINE);
  if (real.length > 0) return { status: "separated", stemCount: real.length };
  if (input.stems.some((stem) => stem.engine === PASSTHROUGH_ENGINE)) {
    return {
      status: "source-only",
      reason: "Stem separation is unavailable for this track — playback uses the full, unseparated source.",
    };
  }
  if (input.separationPending === true) {
    return { status: "processing", reason: "Stem separation is still running — playback uses the full source until it completes." };
  }
  return {
    status: "unavailable",
    reason: "No stems exist for this track yet (separation has not run or its job failed).",
  };
}

/** A per-track stem mix: linear gain multipliers per stem type (1 = unity). */
export type StemMix = Record<string, number>;

export const STEM_MIX_UNITY = 1;
const STEM_MIX_MIN = 0;
const STEM_MIX_MAX = 2;

/** Validate + clamp a stem mix from untrusted input (API body, persisted
 * JSON). Unknown keys and non-finite values are dropped; missing entries
 * are NOT invented here (callers merge with unity via withUnityDefaults). */
export function normalizeStemMix(raw: unknown): StemMix {
  const mix: StemMix = {};
  if (typeof raw !== "object" || raw === null) return mix;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 64) continue;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) continue;
    mix[key] = Math.min(STEM_MIX_MAX, Math.max(STEM_MIX_MIN, numeric));
  }
  return mix;
}

/** Merge a (partial) mix with unity defaults for every channel, so consumers
 * always see a complete mix without inventing gains. */
export function withUnityDefaults(mix: StemMix, stemTypes: readonly string[]): StemMix {
  const merged: StemMix = {};
  for (const stemType of stemTypes) merged[stemType] = mix[stemType] ?? STEM_MIX_UNITY;
  return merged;
}

/** Serialize/parse persisted stem-mix JSON (text columns). Corrupt stored
 * JSON degrades to an empty mix — playback continues at unity, never crashes. */
export function serializeStemMix(mix: StemMix): string {
  return JSON.stringify(normalizeStemMix(mix));
}

export function parseStemMix(text: string | null | undefined): StemMix {
  if (typeof text !== "string" || text.length === 0) return {};
  try {
    return normalizeStemMix(JSON.parse(text));
  } catch {
    return {};
  }
}

export interface TrackMetadata {
  title: string;
  artist: string;
}

/**
 * Derive listening metadata from the original filename at intake, BEFORE
 * the user edits anything: "01 - Artist - Title.mp3" → artist "Artist",
 * title "Title". Conservative by design — only splits on the FIRST
 * " - " separator, only strips a leading track number, and falls back to
 * the bare filename (minus extension) when nothing parses. Never throws.
 */
export function deriveTrackMetadata(originalFilename: string): TrackMetadata {
  const base = originalFilename.replace(/\.[a-z0-9]{1,6}$/i, "").trim();
  if (base.length === 0) return { title: originalFilename, artist: "" };
  const withoutNumber = base.replace(/^\d{1,3}\s*[.\-_]\s+/, "");
  const split = withoutNumber.split(/\s+-\s+/);
  if (split.length >= 2 && split[0].length > 0 && split[1].length > 0) {
    return { artist: split[0].trim(), title: split.slice(1).join(" - ").trim() };
  }
  return { title: withoutNumber, artist: "" };
}

/** Container project naming for library intake (wy_projects.kind='library'). */
export function libraryContainerProjectName(trackTitle: string): string {
  return `Library · ${trackTitle}`;
}

/**
 * A play counts after this much LISTENING (or half the track, whichever comes
 * first) — not on every play-button click. Pure so the client threshold and
 * any future server check share one definition.
 */
export const PLAY_COUNT_THRESHOLD_SECONDS = 30;

export function playCountThreshold(durationSeconds: number | null | undefined): number {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return PLAY_COUNT_THRESHOLD_SECONDS;
  }
  return Math.min(PLAY_COUNT_THRESHOLD_SECONDS, Math.max(1, durationSeconds / 2));
}

export function shouldCountPlay(positionSeconds: number, durationSeconds: number | null | undefined): boolean {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return false;
  return positionSeconds >= playCountThreshold(durationSeconds);
}

/** Player-facing clock: 83.4s → "1:23". Deterministic, no Date/locale use. */
export function formatPlayClock(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

