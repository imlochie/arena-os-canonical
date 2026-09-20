import { useEditorStore } from '../editorStore';
import { BUILT_IN_PRESETS, getBuiltInPreset } from '../../presets/library';
import { SourceAsset } from '../../engine/types';

const source: SourceAsset = { uri: 'file:///a.jpg', width: 100, height: 100 };

function fresh() {
  const s = useEditorStore.getState();
  s.registerPresets(BUILT_IN_PRESETS);
  s.beginSession(source);
}

describe('editorStore', () => {
  beforeEach(fresh);

  it('begins a session with a neutral recipe', () => {
    const s = useEditorStore.getState();
    expect(s.source?.uri).toBe(source.uri);
    expect(s.present().recipe.presetId).toBeNull();
    expect(s.canUndo()).toBe(false);
  });

  it('setAdjustment records a single undo step', () => {
    let s = useEditorStore.getState();
    s.setAdjustment('exposure', 0.5);
    s = useEditorStore.getState();
    expect(s.present().recipe.adjustments.exposure).toBe(0.5);
    expect(s.canUndo()).toBe(true);
    s.undo();
    s = useEditorStore.getState();
    expect(s.present().recipe.adjustments.exposure).toBe(0);
  });

  it('previewAdjustment does NOT record history; commit does', () => {
    let s = useEditorStore.getState();
    s.previewAdjustment('contrast', 0.3);
    s = useEditorStore.getState();
    expect(s.present().recipe.adjustments.contrast).toBe(0.3);
    expect(s.canUndo()).toBe(false);
    s.commitEdit();
    s = useEditorStore.getState();
    expect(s.canUndo()).toBe(true);
  });

  it('applyPreset sets id and default intensity, resolves activePreset', () => {
    let s = useEditorStore.getState();
    s.applyPreset('digi');
    s = useEditorStore.getState();
    expect(s.present().recipe.presetId).toBe('digi');
    expect(s.present().recipe.presetIntensity).toBe(getBuiltInPreset('digi')!.defaultIntensity);
    expect(s.activePreset()?.id).toBe('digi');
  });

  it('intensity preview then settle records once', () => {
    let s = useEditorStore.getState();
    s.applyPreset('clean');
    s.previewPresetIntensity(0.4);
    s.previewPresetIntensity(0.6);
    s = useEditorStore.getState();
    expect(s.present().recipe.presetIntensity).toBe(0.6);
    const undosBefore = s.history.past.length;
    s.setPresetIntensity(0.7);
    s = useEditorStore.getState();
    expect(s.history.past.length).toBe(undosBefore + 1);
  });

  it('resetAll clears preset and adjustments', () => {
    let s = useEditorStore.getState();
    s.applyPreset('digi');
    s.setAdjustment('grain', 0.5);
    s.resetAll();
    s = useEditorStore.getState();
    const r = s.present().recipe;
    expect(r.presetId).toBeNull();
    expect(r.adjustments.grain).toBe(0);
  });

  it('layer add/update/remove flow through history', () => {
    let s = useEditorStore.getState();
    const layer = {
      id: 'L1',
      type: 'text' as const,
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      visible: true,
      blendMode: 'normal' as const,
      text: 'hi',
      color: '#fff',
      fontSize: 20,
      fontWeight: 'bold' as const,
      align: 'center' as const,
    };
    s.addLayer(layer);
    s = useEditorStore.getState();
    expect(s.present().canvas.layers).toHaveLength(1);
    s.updateLayer('L1', { opacity: 0.5 });
    s = useEditorStore.getState();
    expect(s.present().canvas.layers[0]!.opacity).toBe(0.5);
    s.removeLayer('L1');
    s = useEditorStore.getState();
    expect(s.present().canvas.layers).toHaveLength(0);
    // three ops => three undo steps
    s.undo();
    s = useEditorStore.getState();
    expect(s.present().canvas.layers).toHaveLength(1);
  });

  it('original source uri is never mutated by editing', () => {
    let s = useEditorStore.getState();
    s.applyPreset('faded-film');
    s.setAdjustment('exposure', -1);
    s = useEditorStore.getState();
    expect(s.source?.uri).toBe(source.uri);
  });
});
