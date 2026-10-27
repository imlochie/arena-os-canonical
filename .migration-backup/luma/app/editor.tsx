/**
 * EDITOR — the full-screen editing surface (pushed modally over the tabs).
 *
 * This is the core of the vertical slice: preset selection, intensity, manual
 * adjustments, before/after comparison, undo/redo/reset, and save/export.
 * Everything is non-destructive: the UI only mutates the recipe in the editor
 * store; pixels are (re)derived by the renderer.
 *
 * The bottom toolbar switches between three tool "trays":
 *   Looks  — preset carousel + intensity
 *   Adjust — the manual adjustment sliders
 *   (Compare is a press-and-hold on the canvas, not a tray.)
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoRenderer } from '../src/ui/components/PhotoRenderer';
import { PresetCarousel } from '../src/ui/components/PresetCarousel';
import { Slider } from '../src/ui/components/Slider';
import { IconButton } from '../src/ui/components/IconButton';
import { usePresets } from '../src/ui/usePresets';
import { useExport } from '../src/ui/useExport';
import { useEditorStore } from '../src/state/editorStore';
import {
  ADJUSTMENT_SPECS,
  Adjustments,
  ADJUSTMENT_KEYS,
} from '../src/engine/types';
import { haptic } from '../src/ui/haptics';
import { palette, radius, spacing, typography } from '../src/theme/tokens';

type Tray = 'looks' | 'adjust';

export default function EditorScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const { presets } = usePresets();
  const { busy, saveToLibrary, share } = useExport();

  const source = useEditorStore((s) => s.source);
  const history = useEditorStore((s) => s.history);
  const activePreset = useEditorStore((s) => s.activePreset)();
  const canUndo = useEditorStore((s) => s.canUndo)();
  const canRedo = useEditorStore((s) => s.canRedo)();

  const applyPreset = useEditorStore((s) => s.applyPreset);
  const previewPresetIntensity = useEditorStore((s) => s.previewPresetIntensity);
  const setPresetIntensity = useEditorStore((s) => s.setPresetIntensity);
  const previewAdjustment = useEditorStore((s) => s.previewAdjustment);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const resetAll = useEditorStore((s) => s.resetAll);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const [tray, setTray] = useState<Tray>('looks');
  const [showOriginal, setShowOriginal] = useState(false);

  const recipe = history.present.recipe;

  // Reserve space: top bar + canvas + tool tray + bottom toolbar.
  const canvasHeight = useMemo(() => {
    return Math.max(220, Math.round(width * 1.1));
  }, [width]);

  const onSave = useCallback(async () => {
    if (!source) return;
    const ok = await saveToLibrary({ source, recipe, preset: activePreset });
    if (ok) {
      // Stay in editor so the user can keep tweaking or share; a small confirm
      // could be added. Non-destructive: original untouched.
    }
  }, [source, recipe, activePreset, saveToLibrary]);

  const onShare = useCallback(async () => {
    if (!source) return;
    await share({ source, recipe, preset: activePreset });
  }, [source, recipe, activePreset, share]);

  if (!source) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.emptyText}>No photo selected.</Text>
        <Pressable style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>Back to camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="close" onPress={() => router.back()} label="Close" />
        <View style={styles.historyGroup}>
          <IconButton icon="undo" onPress={undo} disabled={!canUndo} />
          <IconButton icon="redo" onPress={redo} disabled={!canRedo} />
          <IconButton icon="reset" onPress={resetAll} />
        </View>
        <IconButton icon="download" onPress={onSave} label="Save" />
      </View>

      {/* Canvas */}
      <View style={[styles.canvas, { height: canvasHeight }]}>
        <PhotoRenderer
          uri={source.uri}
          recipe={recipe}
          preset={activePreset}
          width={width}
          height={canvasHeight}
          showOriginal={showOriginal}
          fit="contain"
        />
        {/* Press-and-hold anywhere to compare with the original */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPressIn={() => {
            setShowOriginal(true);
            haptic('light');
          }}
          onPressOut={() => setShowOriginal(false)}
          accessibilityLabel="Hold to compare with original"
        />
        {showOriginal ? (
          <View style={styles.compareBadge} pointerEvents="none">
            <Text style={styles.compareBadgeText}>ORIGINAL</Text>
          </View>
        ) : (
          <View style={styles.compareHint} pointerEvents="none">
            <Text style={styles.compareHintText}>Hold to compare</Text>
          </View>
        )}
        {busy ? (
          <View style={styles.busyOverlay} pointerEvents="none">
            <ActivityIndicator color={palette.text} />
            <Text style={styles.busyText}>Rendering…</Text>
          </View>
        ) : null}
      </View>

      {/* Tool tray */}
      <View style={styles.tray}>
        {tray === 'looks' ? (
          <LooksTray
            presets={presets}
            selectedId={recipe.presetId}
            onSelect={applyPreset}
            thumbnailUri={source.uri}
            intensity={recipe.presetIntensity}
            intensityEnabled={!!activePreset}
            onIntensityChange={previewPresetIntensity}
            onIntensitySettle={setPresetIntensity}
          />
        ) : (
          <AdjustTray
            adjustments={recipe.adjustments}
            onChange={previewAdjustment}
            onSettle={() => commitEdit()}
          />
        )}
      </View>

      {/* Bottom toolbar: tray switch + share */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.sm }]}>
        <TraySwitch tray={tray} onChange={setTray} />
        <IconButton icon="share" onPress={onShare} label="Share" />
      </View>
    </View>
  );
}

function LooksTray(props: {
  presets: ReturnType<typeof usePresets>['presets'];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  thumbnailUri: string;
  intensity: number;
  intensityEnabled: boolean;
  onIntensityChange: (v: number) => void;
  onIntensitySettle: (v: number) => void;
}) {
  return (
    <View style={styles.looksTray}>
      <PresetCarousel
        presets={props.presets}
        selectedId={props.selectedId}
        onSelect={props.onSelect}
        thumbnailUri={props.thumbnailUri}
        variant="thumbs"
      />
      <View style={styles.intensityRow}>
        <Slider
          label="Intensity"
          value={props.intensity}
          min={0}
          max={1}
          step={0.01}
          onChange={props.onIntensityChange}
          onSettle={props.onIntensitySettle}
          formatValue={(v) => `${Math.round(v * 100)}%`}
        />
      </View>
    </View>
  );
}

function AdjustTray(props: {
  adjustments: Adjustments;
  onChange: (key: keyof Adjustments, value: number) => void;
  onSettle: () => void;
}) {
  return (
    <ScrollView
      style={styles.adjustTray}
      contentContainerStyle={styles.adjustContent}
      showsVerticalScrollIndicator={false}
    >
      {ADJUSTMENT_KEYS.map((key) => {
        const spec = ADJUSTMENT_SPECS[key];
        return (
          <View key={key} style={styles.adjustItem}>
            <Slider
              label={spec.label}
              value={props.adjustments[key]}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              bipolar={spec.bipolar}
              onChange={(v) => props.onChange(key, v)}
              onSettle={() => props.onSettle()}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}

function TraySwitch({ tray, onChange }: { tray: Tray; onChange: (t: Tray) => void }) {
  const items: { id: Tray; label: string }[] = [
    { id: 'looks', label: 'Looks' },
    { id: 'adjust', label: 'Adjust' },
  ];
  return (
    <View style={styles.switch}>
      {items.map((it) => {
        const active = tray === it.id;
        return (
          <Pressable
            key={it.id}
            onPress={() => {
              haptic('selection');
              onChange(it.id);
            }}
            style={[styles.switchItem, active && styles.switchItemActive]}
          >
            <Text style={[styles.switchText, active && styles.switchTextActive]}>
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0 },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  emptyText: { ...typography.body, color: palette.textDim },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  historyGroup: { flexDirection: 'row', gap: spacing.xs },

  canvas: {
    width: '100%',
    backgroundColor: palette.bg0,
    justifyContent: 'center',
  },
  compareBadge: {
    position: 'absolute',
    top: spacing.md,
    alignSelf: 'center',
    backgroundColor: palette.overlay,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  compareBadgeText: { ...typography.caption, color: palette.text },
  compareHint: {
    position: 'absolute',
    bottom: spacing.md,
    alignSelf: 'center',
    backgroundColor: palette.scrim,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  compareHintText: { ...typography.caption, color: palette.textDim },
  busyOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.overlay,
    gap: spacing.sm,
  },
  busyText: { ...typography.label, color: palette.text },

  tray: {
    flex: 1,
    backgroundColor: palette.bg1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.lg,
  },
  looksTray: { gap: spacing.lg },
  intensityRow: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  adjustTray: { flex: 1 },
  adjustContent: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: spacing.md },
  adjustItem: {},

  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: palette.bg1,
  },
  switch: {
    flexDirection: 'row',
    backgroundColor: palette.bg2,
    borderRadius: radius.pill,
    padding: 4,
  },
  switchItem: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  switchItemActive: { backgroundColor: palette.bg4 },
  switchText: { ...typography.label, color: palette.textDim },
  switchTextActive: { color: palette.text },

  primaryBtn: {
    backgroundColor: palette.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  primaryBtnText: { ...typography.heading, color: palette.bg0 },
});
