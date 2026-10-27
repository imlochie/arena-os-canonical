/**
 * CREATE — a lightweight creative layer surface.
 *
 * Composites text / shapes / stickers on top of the current edit. Layers are
 * draggable and support scale/rotation via pinch. This is intentionally a small
 * compositor in V1 (not a professional one): it demonstrates the layer model and
 * is architected (see engine/layers + engine/types) to grow.
 *
 * If there is no active editing session yet, it invites the user to start one
 * from Camera or Edit, keeping the camera one tap away.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PhotoRenderer } from '../../src/ui/components/PhotoRenderer';
import { LayerView } from '../../src/ui/components/LayerView';
import { IconButton } from '../../src/ui/components/IconButton';
import { usePresets } from '../../src/ui/usePresets';
import { useEditorStore } from '../../src/state/editorStore';
import {
  createShapeLayer,
  createStickerLayer,
  createTextLayer,
} from '../../src/engine/layers';
import { Layer } from '../../src/engine/types';
import { palette, radius, spacing, typography } from '../../src/theme/tokens';

const STICKERS = ['✨', '❤️', '🔥', '🌙', '⭐️', '☀️', '📷', '🎞️'];

export default function CreateTab() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();

  // Ensure the preset library is registered so activePreset resolves here too.
  usePresets();
  const source = useEditorStore((s) => s.source);
  const history = useEditorStore((s) => s.history);
  const activePreset = useEditorStore((s) => s.activePreset)();
  const addLayer = useEditorStore((s) => s.addLayer);
  const updateLayer = useEditorStore((s) => s.updateLayer);
  const removeLayer = useEditorStore((s) => s.removeLayer);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showStickers, setShowStickers] = useState(false);

  const canvasSize = useMemo(() => {
    const w = width - spacing.lg * 2;
    return { w, h: w };
  }, [width]);

  const recipe = history.present.recipe;
  const layers = history.present.canvas.layers;

  const onAdd = useCallback(
    (layer: Layer) => {
      addLayer(layer);
      setSelectedId(layer.id);
    },
    [addLayer],
  );

  if (!source) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.title}>Create</Text>
        <Text style={styles.emptyBody}>
          Take or import a photo first, then add text, shapes, and stickers.
        </Text>
        <View style={styles.emptyActions}>
          <Pressable style={styles.primaryBtn} onPress={() => router.push('/(tabs)')}>
            <Text style={styles.primaryBtnText}>Open camera</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={() => router.push('/(tabs)/edit')}>
            <Text style={styles.secondaryBtnText}>Import a photo</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Create</Text>
        <IconButton icon="download" label="Editor" onPress={() => router.push('/editor')} />
      </View>

      {/* Composited canvas */}
      <View style={[styles.canvasWrap, { width: canvasSize.w, height: canvasSize.h }]}>
        <PhotoRenderer
          uri={source.uri}
          recipe={recipe}
          preset={activePreset}
          width={canvasSize.w}
          height={canvasSize.h}
          fit="cover"
        />
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectedId(null)} />
        {layers.map((layer) => (
          <LayerView
            key={layer.id}
            layer={layer}
            canvasWidth={canvasSize.w}
            canvasHeight={canvasSize.h}
            selected={selectedId === layer.id}
            onSelect={() => setSelectedId(layer.id)}
            onChange={(patch) => updateLayer(layer.id, patch)}
          />
        ))}
      </View>

      {/* Sticker picker */}
      {showStickers ? (
        <View style={styles.stickerBar}>
          {STICKERS.map((g) => (
            <Pressable
              key={g}
              style={styles.stickerBtn}
              onPress={() => {
                onAdd(createStickerLayer(g));
                setShowStickers(false);
              }}
            >
              <Text style={styles.stickerGlyph}>{g}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Toolbar */}
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + spacing.sm }]}>
        <IconButton icon="text" label="Text" onPress={() => onAdd(createTextLayer())} variant="filled" />
        <IconButton icon="shape" label="Shape" onPress={() => onAdd(createShapeLayer())} variant="filled" />
        <IconButton
          icon="sticker"
          label="Sticker"
          onPress={() => setShowStickers((s) => !s)}
          variant="filled"
          active={showStickers}
        />
        <IconButton
          icon="trash"
          label="Delete"
          disabled={!selectedId}
          onPress={() => {
            if (selectedId) {
              removeLayer(selectedId);
              setSelectedId(null);
            }
          }}
          variant="filled"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0, paddingHorizontal: spacing.lg },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  title: { ...typography.display, color: palette.text },
  emptyBody: { ...typography.body, color: palette.textDim, textAlign: 'center' },
  emptyActions: { gap: spacing.md, alignItems: 'center' },

  canvasWrap: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: palette.bg2,
  },
  stickerBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  stickerBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: palette.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickerGlyph: { fontSize: 28 },

  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    marginTop: 'auto',
    paddingTop: spacing.lg,
  },

  primaryBtn: {
    backgroundColor: palette.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  primaryBtnText: { ...typography.heading, color: palette.bg0 },
  secondaryBtn: { paddingVertical: spacing.sm },
  secondaryBtnText: { ...typography.body, color: palette.textDim },
});
