/**
 * settingsStore — reactive access to persisted settings + the camera's selected
 * preset. Loads from disk on first use and writes through on every change.
 */

import { create } from 'zustand';

import {
  DEFAULT_SETTINGS,
  Settings,
  SettingsRepository,
} from '../storage/settings';

const repo = new SettingsRepository();

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** The preset id currently selected in the Camera. Persisted separately. */
  cameraPresetId: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  setCameraPreset: (id: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  cameraPresetId: 'clean',

  load: async () => {
    const settings = await repo.load();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const next = await repo.update(patch);
    set({ settings: next });
  },

  setCameraPreset: (id) => set({ cameraPresetId: id }),
}));

export { repo as settingsRepository };
