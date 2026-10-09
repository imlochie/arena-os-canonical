/**
 * editorStore — the central, in-memory editing session.
 *
 * Holds the current source image, the edit recipe (non-destructively), the
 * creative canvas, and an undo/redo history. UI screens subscribe to this store;
 * the pure engine modules do the actual math.
 *
 * Live-drag ergonomics: slider drags call `previewAdjustment` (updates present
 * WITHOUT recording history) and `commitEdit` once on release (records a single
 * undo step). This keeps interactions responsive and undo meaningful.
 */

import { create } from 'zustand';

import { cloneAdjustments } from '../engine/adjustments';
import {
  canRedo as histCanRedo,
  canUndo as histCanUndo,
  commit,
  createHistory,
  History,
  redo as histRedo,
  replacePresent,
  resetHistory,
  undo as histUndo,
} from '../engine/history';
import {
  Adjustments,
  Canvas,
  EditRecipe,
  EMPTY_CANVAS,
  EMPTY_RECIPE,
  Layer,
  NEUTRAL_ADJUSTMENTS,
  Preset,
  SourceAsset,
} from '../engine/types';
import * as layerOps from '../engine/layers';
import { getBuiltInPreset } from '../presets/library';

/** A single, serialisable snapshot captured by history. */
export interface EditorSnapshot {
  recipe: EditRecipe;
  canvas: Canvas;
}

interface EditorState {
  source: SourceAsset | null;
  history: History<EditorSnapshot>;
  /** Preset lookup: built-ins + any user presets registered at runtime. */
  presetIndex: Record<string, Preset>;
  /**
   * The snapshot captured at the START of a live drag. Preview updates replace
   * `present` without recording history; commitEdit uses this baseline so a whole
   * drag collapses into exactly ONE undo step whose target is the pre-drag state.
   */
  pendingBaseline: EditorSnapshot | null;

  // Derived helpers (kept as methods for convenience in components).
  present: () => EditorSnapshot;
  activePreset: () => Preset | null;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Session lifecycle.
  beginSession: (source: SourceAsset, initial?: Partial<EditorSnapshot>) => void;
  registerPresets: (presets: Preset[]) => void;

  // Recipe editing.
  previewAdjustment: (key: keyof Adjustments, value: number) => void;
  commitEdit: () => void;
  setAdjustment: (key: keyof Adjustments, value: number) => void;
  applyPreset: (presetId: string | null) => void;
  previewPresetIntensity: (intensity: number) => void;
  setPresetIntensity: (intensity: number) => void;
  resetAdjustments: () => void;
  resetAll: () => void;

  // Canvas / layers.
  addLayer: (layer: Layer) => void;
  updateLayer: (id: string, patch: Partial<Layer>) => void;
  removeLayer: (id: string) => void;
  reorderLayer: (id: string, toIndex: number) => void;

  // History.
  undo: () => void;
  redo: () => void;
}

function emptySnapshot(): EditorSnapshot {
  return {
    recipe: {
      ...EMPTY_RECIPE,
      adjustments: { ...EMPTY_RECIPE.adjustments },
      crop: { ...EMPTY_RECIPE.crop },
    },
    canvas: { ...EMPTY_CANVAS, layers: [] },
  };
}

function cloneSnapshot(s: EditorSnapshot): EditorSnapshot {
  return {
    recipe: {
      ...s.recipe,
      adjustments: cloneAdjustments(s.recipe.adjustments),
      crop: { ...s.recipe.crop },
    },
    canvas: { ...s.canvas, layers: [...s.canvas.layers] },
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  source: null,
  history: createHistory<EditorSnapshot>(emptySnapshot()),
  presetIndex: {},
  pendingBaseline: null,

  present: () => get().history.present,
  activePreset: () => {
    const { history, presetIndex } = get();
    const id = history.present.recipe.presetId;
    if (!id) return null;
    return presetIndex[id] ?? getBuiltInPreset(id) ?? null;
  },
  canUndo: () => histCanUndo(get().history),
  canRedo: () => histCanRedo(get().history),

  beginSession: (source, initial) => {
    const snapshot: EditorSnapshot = {
      ...emptySnapshot(),
      ...initial,
    };
    set({ source, history: resetHistory(snapshot), pendingBaseline: null });
  },

  registerPresets: (presets) => {
    const presetIndex = { ...get().presetIndex };
    for (const p of presets) presetIndex[p.id] = p;
    set({ presetIndex });
  },

  previewAdjustment: (key, value) => {
    const { history, pendingBaseline } = get();
    const present = history.present;
    // Capture the pre-drag baseline on the first preview of an interaction.
    const baseline = pendingBaseline ?? cloneSnapshot(present);
    const recipe: EditRecipe = {
      ...present.recipe,
      adjustments: { ...present.recipe.adjustments, [key]: value },
    };
    set({
      history: replacePresent(history, { ...present, recipe }),
      pendingBaseline: baseline,
    });
  },

  commitEdit: () => {
    const { history, pendingBaseline } = get();
    const finalSnapshot = cloneSnapshot(history.present);
    // Rebuild history so the interaction collapses to a single undo step whose
    // undo target is the pre-drag baseline (if one was captured).
    if (pendingBaseline) {
      const restored = replacePresent(history, pendingBaseline);
      set({ history: commit(restored, finalSnapshot), pendingBaseline: null });
    } else {
      set({ history: commit(history, finalSnapshot) });
    }
  },

  setAdjustment: (key, value) => {
    get().previewAdjustment(key, value);
    get().commitEdit();
  },

  applyPreset: (presetId) => {
    const { history, presetIndex } = get();
    const preset = presetId ? presetIndex[presetId] ?? getBuiltInPreset(presetId) : null;
    const present = history.present;
    const recipe: EditRecipe = {
      ...present.recipe,
      presetId,
      presetIntensity: preset ? preset.defaultIntensity : 1,
    };
    set({ history: commit(history, { ...present, recipe }), pendingBaseline: null });
  },

  previewPresetIntensity: (intensity) => {
    const { history, pendingBaseline } = get();
    const present = history.present;
    const baseline = pendingBaseline ?? cloneSnapshot(present);
    const recipe: EditRecipe = { ...present.recipe, presetIntensity: intensity };
    set({
      history: replacePresent(history, { ...present, recipe }),
      pendingBaseline: baseline,
    });
  },

  setPresetIntensity: (intensity) => {
    get().previewPresetIntensity(intensity);
    get().commitEdit();
  },

  resetAdjustments: () => {
    const { history } = get();
    const present = history.present;
    const recipe: EditRecipe = { ...present.recipe, adjustments: { ...NEUTRAL_ADJUSTMENTS } };
    set({ history: commit(history, { ...present, recipe }), pendingBaseline: null });
  },

  resetAll: () => {
    const { history } = get();
    const present = history.present;
    const recipe: EditRecipe = {
      ...EMPTY_RECIPE,
      adjustments: { ...NEUTRAL_ADJUSTMENTS },
      crop: { ...EMPTY_RECIPE.crop },
    };
    set({ history: commit(history, { ...present, recipe }), pendingBaseline: null });
  },

  addLayer: (layer) => {
    const { history } = get();
    const present = history.present;
    const canvas = layerOps.addLayer(present.canvas, layer);
    set({ history: commit(history, { ...present, canvas }), pendingBaseline: null });
  },

  updateLayer: (id, patch) => {
    const { history } = get();
    const present = history.present;
    const canvas = layerOps.updateLayer(present.canvas, id, patch);
    set({ history: commit(history, { ...present, canvas }), pendingBaseline: null });
  },

  removeLayer: (id) => {
    const { history } = get();
    const present = history.present;
    const canvas = layerOps.removeLayer(present.canvas, id);
    set({ history: commit(history, { ...present, canvas }), pendingBaseline: null });
  },

  reorderLayer: (id, toIndex) => {
    const { history } = get();
    const present = history.present;
    const canvas = layerOps.moveLayer(present.canvas, id, toIndex);
    set({ history: commit(history, { ...present, canvas }), pendingBaseline: null });
  },

  undo: () => set({ history: histUndo(get().history), pendingBaseline: null }),
  redo: () => set({ history: histRedo(get().history), pendingBaseline: null }),
}));
