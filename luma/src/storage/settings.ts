/**
 * App settings persistence.
 *
 * V1 settings are intentionally small and fully local — no accounts, no cloud,
 * no analytics. Stored as one JSON document in the KV store.
 */

import { getKVStore, KVStore } from './kvStore';

export type ExportQuality = 'standard' | 'high' | 'max';
export type SaveBehavior = 'saveCopy' | 'saveAndShare';
export type Appearance = 'dark'; // V1 is dark-first only; typed for future growth.

export interface Settings {
  exportQuality: ExportQuality;
  saveBehavior: SaveBehavior;
  haptics: boolean;
  appearance: Appearance;
}

export const DEFAULT_SETTINGS: Settings = {
  exportQuality: 'high',
  saveBehavior: 'saveCopy',
  haptics: true,
  appearance: 'dark',
};

/** Map a quality setting to concrete export parameters. */
export function exportParamsFor(quality: ExportQuality): {
  maxDimension?: number;
  jpegQuality: number;
} {
  switch (quality) {
    case 'standard':
      return { maxDimension: 2048, jpegQuality: 0.9 };
    case 'high':
      return { maxDimension: 4096, jpegQuality: 0.95 };
    case 'max':
      return { maxDimension: undefined, jpegQuality: 1 };
  }
}

const SETTINGS_KEY = 'luma.settings.v1';

export class SettingsRepository {
  constructor(private store: KVStore = getKVStore()) {}

  async load(): Promise<Settings> {
    const raw = await this.store.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(settings: Settings): Promise<void> {
    await this.store.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.load();
    const next = { ...current, ...patch };
    await this.save(next);
    return next;
  }
}
