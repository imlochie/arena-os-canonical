/**
 * Preset serialization + lifecycle helpers.
 *
 * Presets are stored independently from projects (per the data model) and must
 * survive round-trips through JSON persistence. These helpers are pure and
 * unit-tested for serialize/deserialize fidelity, duplication, and reset.
 */

import { ADJUSTMENT_KEYS, Preset, PRESET_FAMILIES, PresetFamily } from '../engine/types';

const CURRENT_SCHEMA_VERSION = 1;

export interface SerializedPresetFile {
  schemaVersion: number;
  presets: Preset[];
}

/** A minimal shape validator so corrupt/foreign data can't crash the app. */
export function isValidPreset(value: unknown): value is Preset {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  if (typeof p.name !== 'string') return false;
  if (typeof p.family !== 'string') return false;
  if (!PRESET_FAMILIES.includes(p.family as PresetFamily)) return false;
  if (typeof p.defaultIntensity !== 'number') return false;
  if (typeof p.builtIn !== 'boolean') return false;
  if (!p.adjustments || typeof p.adjustments !== 'object') return false;
  // Every provided adjustment must be a finite number.
  const adj = p.adjustments as Record<string, unknown>;
  for (const key of Object.keys(adj)) {
    if (!(ADJUSTMENT_KEYS as string[]).includes(key)) continue; // ignore unknown/future keys
    if (typeof adj[key] !== 'number' || !Number.isFinite(adj[key] as number)) {
      return false;
    }
  }
  return true;
}

/** Serialize a preset to a stable JSON string. */
export function serializePreset(preset: Preset): string {
  return JSON.stringify(preset);
}

/** Parse a single preset from JSON, throwing on invalid data. */
export function deserializePreset(json: string): Preset {
  const parsed = JSON.parse(json);
  if (!isValidPreset(parsed)) {
    throw new Error('LUMA: invalid preset data.');
  }
  return parsed;
}

/** Serialize the user's preset collection to a versioned file payload. */
export function serializePresetFile(presets: Preset[]): string {
  const payload: SerializedPresetFile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    presets,
  };
  return JSON.stringify(payload);
}

/**
 * Parse a preset file payload, tolerating unknown future fields and dropping any
 * invalid entries rather than failing the whole load.
 */
export function deserializePresetFile(json: string): Preset[] {
  const parsed = JSON.parse(json) as Partial<SerializedPresetFile>;
  if (!parsed || !Array.isArray(parsed.presets)) return [];
  return parsed.presets.filter(isValidPreset);
}

/** A short, collision-resistant id for user-created/duplicated presets. */
export function makePresetId(): string {
  return `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Duplicate a preset into an editable user copy.
 * The copy is `builtIn: false` (so it can be renamed/deleted) and gets a fresh
 * id and timestamps.
 */
export function duplicatePreset(preset: Preset, nameSuffix = ' Copy'): Preset {
  const now = Date.now();
  return {
    ...preset,
    id: makePresetId(),
    name: `${preset.name}${nameSuffix}`,
    builtIn: false,
    adjustments: { ...preset.adjustments },
    advanced: preset.advanced ? { ...preset.advanced } : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Reset a user preset's editable parameters back to a source preset's recipe
 * (e.g. "reset to the built-in it was copied from"). Identity fields are kept.
 */
export function resetPresetTo(target: Preset, source: Preset): Preset {
  return {
    ...target,
    adjustments: { ...source.adjustments },
    advanced: source.advanced ? { ...source.advanced } : undefined,
    defaultIntensity: source.defaultIntensity,
    updatedAt: Date.now(),
  };
}
