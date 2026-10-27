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
import { DEFAULT_CAMERA_ID, getCamera } from '../cameras/catalog';

const repo = new SettingsRepository();

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /**
   * The camera currently chosen in the viewfinder, and the look (preset id)
   * selected within it. The engine still speaks in preset ids; "camera" is the
   * product framing layered on top (see src/cameras/catalog.ts).
   */
  cameraId: string;
  cameraLookId: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  setCamera: (cameraId: string, lookId: string | null) => void;
  setCameraLook: (lookId: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  cameraId: DEFAULT_CAMERA_ID,
  cameraLookId: getCamera(DEFAULT_CAMERA_ID)?.defaultLookId ?? null,

  load: async () => {
    const settings = await repo.load();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const next = await repo.update(patch);
    set({ settings: next });
  },

  setCamera: (cameraId, lookId) => set({ cameraId, cameraLookId: lookId }),
  setCameraLook: (lookId) => set({ cameraLookId: lookId }),
}));

export { repo as settingsRepository };
