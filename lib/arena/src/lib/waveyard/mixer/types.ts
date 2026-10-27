/**
 * Waveyard mixer channel model — SOURCE / STEM / BUS / MASTER.
 *
 * The four kinds are deliberately distinct: sources group their stems,
 * stems are the audio-bearing channels, buses sum stem/source channels,
 * and there is exactly one master. Legacy remix-track values
 * (volume 0..2, pan −1..1, muted, solo) map through explicit adapters in
 * state.ts so the existing persisted schema keeps working.
 */

export const MIXER_STATE_FORMAT = "waveyard-mixer-v1" as const;

export const CHANNEL_KINDS = ["source", "stem", "bus", "master"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type ChannelIdentity = {
  /** Stem asset id (stem channels only). */
  stemAssetId?: string;
  /** Source asset id (source and stem channels). */
  sourceAssetId?: string;
  /** Stem type label for stems ("vocals" | "drums" | …). */
  stemType?: string;
};

/**
 * Structural insert shape (no import cycle with inserts.ts). The full
 * Insert type in inserts.ts is assignable to this.
 */
export type MinimalInsert = {
  id: string;
  processor: string;
  enabled: boolean;
  wet: number;
  params: Record<string, number>;
};

export type ChannelStrip = {
  id: string;
  kind: ChannelKind;
  name: string;
  /** Input trim in dB (−24..+24) — applied before the fader. */
  trimDb: number;
  /** Fader in dB (−60..+6). −Infinity is represented as mutedInfinity. */
  faderDb: number;
  /** Fully-closed fader, distinct from a finite value. */
  mutedInfinity: boolean;
  /** Stereo pan −1..1 (constant-power law). */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Polarity inversion for the whole channel. */
  phaseInvert: boolean;
  /** Mono monitoring (sum L+R, scaled) — monitoring only, never baked. */
  monoMonitor: boolean;
  /** Bus routing: undefined routes directly to master. */
  busId?: string;
  inserts: MinimalInsert[];
} & ChannelIdentity;

export type MixerState = {
  format: typeof MIXER_STATE_FORMAT;
  channels: ChannelStrip[];
};

export const TRIM_DB_RANGE = { min: -24, max: 24 } as const;
export const FADER_DB_RANGE = { min: -60, max: 6 } as const;
export const PAN_RANGE = { min: -1, max: 1 } as const;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function isValidChannelStripShape(strip: unknown): strip is ChannelStrip {
  if (strip === null || typeof strip !== "object") return false;
  const s = strip as Partial<ChannelStrip>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    CHANNEL_KINDS.includes(s.kind as ChannelKind) &&
    typeof s.trimDb === "number" &&
    typeof s.faderDb === "number" &&
    typeof s.mutedInfinity === "boolean" &&
    typeof s.pan === "number" &&
    typeof s.muted === "boolean" &&
    typeof s.solo === "boolean" &&
    typeof s.phaseInvert === "boolean" &&
    typeof s.monoMonitor === "boolean" &&
    Array.isArray(s.inserts)
  );
}
