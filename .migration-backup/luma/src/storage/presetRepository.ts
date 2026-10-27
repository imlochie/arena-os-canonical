/**
 * User preset persistence.
 *
 * Built-in presets live in code (presets/library.ts). USER presets (duplicates
 * and future user-created recipes) are persisted here, independently of
 * projects. The combined library the UI sees is built-ins + user presets.
 */

import { Preset } from '../engine/types';
import { BUILT_IN_PRESETS } from '../presets/library';
import {
  deserializePresetFile,
  isValidPreset,
  serializePresetFile,
} from '../presets/serialization';
import { getKVStore, KVStore } from './kvStore';

const USER_PRESETS_KEY = 'luma.userPresets.v1';

export class PresetRepository {
  constructor(private store: KVStore = getKVStore()) {}

  async listUser(): Promise<Preset[]> {
    const raw = await this.store.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    try {
      return deserializePresetFile(raw);
    } catch {
      return [];
    }
  }

  /** Built-ins followed by user presets — the full library for the UI. */
  async listAll(): Promise<Preset[]> {
    const user = await this.listUser();
    return [...BUILT_IN_PRESETS, ...user];
  }

  async saveUser(preset: Preset): Promise<void> {
    if (!isValidPreset(preset)) throw new Error('LUMA: refusing to save invalid preset.');
    const user = await this.listUser();
    const i = user.findIndex((p) => p.id === preset.id);
    if (i >= 0) user[i] = preset;
    else user.push(preset);
    await this.store.setItem(USER_PRESETS_KEY, serializePresetFile(user));
  }

  async removeUser(id: string): Promise<void> {
    const user = await this.listUser();
    const filtered = user.filter((p) => p.id !== id);
    await this.store.setItem(USER_PRESETS_KEY, serializePresetFile(filtered));
  }

  /** Reset presets: delete all user presets, leaving only the built-ins. */
  async resetToBuiltIns(): Promise<void> {
    await this.store.removeItem(USER_PRESETS_KEY);
  }
}
