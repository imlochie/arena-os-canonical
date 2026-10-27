/**
 * usePresets — loads the full preset library (built-ins + user presets) and
 * registers it with the editor store so applyPreset() can resolve ids.
 */

import { useEffect, useState } from 'react';

import { Preset } from '../engine/types';
import { BUILT_IN_PRESETS } from '../presets/library';
import { PresetRepository } from '../storage/presetRepository';
import { useEditorStore } from '../state/editorStore';

const repo = new PresetRepository();

export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>(BUILT_IN_PRESETS);
  const registerPresets = useEditorStore((s) => s.registerPresets);

  useEffect(() => {
    let alive = true;
    registerPresets(BUILT_IN_PRESETS);
    repo
      .listAll()
      .then((all) => {
        if (!alive) return;
        setPresets(all);
        registerPresets(all);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [registerPresets]);

  return { presets };
}

export { repo as presetRepository };
