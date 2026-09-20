/**
 * CAMERA — the default landing screen.
 *
 * Camera-first: rear/front switch, flash control, focus/exposure tap, a tactile
 * preset carousel, a large shutter, and recent-photo access. Live full-feed
 * color grading is a documented future step (needs frame processing); V1 shows
 * the selected preset clearly and applies it the instant a photo is captured,
 * handing straight off to the editor. The controls stay minimal so the
 * viewfinder is the star.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { IconButton } from '../../src/ui/components/IconButton';
import { PresetCarousel } from '../../src/ui/components/PresetCarousel';
import { usePresets } from '../../src/ui/usePresets';
import { usePhotoImport } from '../../src/ui/usePhotoImport';
import { useEditorStore } from '../../src/state/editorStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { haptic } from '../../src/ui/haptics';
import { EMPTY_RECIPE } from '../../src/engine/types';
import { palette, layout, radius, spacing, typography } from '../../src/theme/tokens';

type CycleFlash = 'off' | 'auto' | 'on';
const FLASH_ORDER: CycleFlash[] = ['off', 'auto', 'on'];
const FLASH_ICON = { off: 'flash-off', auto: 'flash-auto', on: 'flash-on' } as const;

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cameraRef = useRef<CameraView>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<CycleFlash>('off');
  const [capturing, setCapturing] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);

  const { presets } = usePresets();
  const { pick } = usePhotoImport();
  const cameraPresetId = useSettingsStore((s) => s.cameraPresetId);
  const setCameraPreset = useSettingsStore((s) => s.setCameraPreset);
  const beginSession = useEditorStore((s) => s.beginSession);

  const selectedPreset = presets.find((p) => p.id === cameraPresetId) ?? null;

  useEffect(() => {
    // Do NOT auto-request on mount; ask when the user is clearly here to shoot.
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const openEditorWith = useCallback(
    (uri: string, width: number, height: number, assetId?: string) => {
      beginSession(
        { uri, width, height, assetId },
        {
          recipe: {
            ...EMPTY_RECIPE,
            adjustments: { ...EMPTY_RECIPE.adjustments },
            crop: { ...EMPTY_RECIPE.crop },
            presetId: cameraPresetId,
            presetIntensity: selectedPreset?.defaultIntensity ?? 1,
          },
        },
      );
      router.push('/editor');
    },
    [beginSession, cameraPresetId, selectedPreset, router],
  );

  const onCapture = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    haptic('medium');
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 1,
        skipProcessing: false,
      });
      if (photo?.uri) {
        setLastPhoto(photo.uri);
        openEditorWith(photo.uri, photo.width ?? 0, photo.height ?? 0);
      }
    } catch {
      // Silently ignore; a toast could be added later.
    } finally {
      setCapturing(false);
    }
  }, [capturing, openEditorWith]);

  const onImport = useCallback(async () => {
    const asset = await pick();
    if (asset) {
      setLastPhoto(asset.uri);
      openEditorWith(asset.uri, asset.width, asset.height, asset.assetId);
    }
  }, [pick, openEditorWith]);

  const cycleFlash = () => {
    const i = FLASH_ORDER.indexOf(flash);
    const next = FLASH_ORDER[(i + 1) % FLASH_ORDER.length] ?? 'off';
    setFlash(next);
  };

  // Permission gate.
  if (!permission) {
    return <View style={styles.container} />;
  }
  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.permTitle}>Camera access</Text>
        <Text style={styles.permBody}>
          LUMA needs the camera to take photos with your selected look.
        </Text>
        <Pressable style={styles.permButton} onPress={requestPermission}>
          <Text style={styles.permButtonText}>Enable camera</Text>
        </Pressable>
        <Pressable style={styles.permSecondary} onPress={onImport}>
          <Text style={styles.permSecondaryText}>Import a photo instead</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        responsiveOrientationWhenOrientationLocked
      />

      {/* Top controls */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton
          icon={FLASH_ICON[flash]}
          label={flash.toUpperCase()}
          onPress={cycleFlash}
          active={flash !== 'off'}
        />
        <View style={styles.presetBadge}>
          <Text style={styles.presetBadgeLabel}>LOOK</Text>
          <Text style={styles.presetBadgeName}>{selectedPreset?.name ?? 'Original'}</Text>
        </View>
        <IconButton icon="flip" label="FLIP" onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} />
      </View>

      {/* Bottom cluster: preset carousel + shutter row */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.carousel}>
          <PresetCarousel
            presets={presets}
            selectedId={cameraPresetId}
            onSelect={setCameraPreset}
            variant="chips"
          />
        </View>

        <View style={styles.shutterRow}>
          {/* Recent photo */}
          <Pressable style={styles.recent} onPress={onImport} accessibilityLabel="Import photo">
            {lastPhoto ? (
              <ExpoImage source={{ uri: lastPhoto }} style={styles.recentImg} contentFit="cover" />
            ) : (
              <View style={styles.recentEmpty}>
                <IconButton icon="image" size={30} onPress={onImport} />
              </View>
            )}
          </Pressable>

          {/* Shutter */}
          <Pressable
            onPress={onCapture}
            disabled={capturing}
            accessibilityLabel="Take photo"
            style={styles.shutterHit}
          >
            <View style={styles.shutterOuter}>
              {capturing ? (
                <ActivityIndicator color={palette.bg0} />
              ) : (
                <View style={styles.shutterInner} />
              )}
            </View>
          </Pressable>

          {/* Spacer to balance layout */}
          <View style={styles.recent} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0 },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },

  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
  },
  presetBadge: {
    alignItems: 'center',
    backgroundColor: palette.scrim,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  presetBadgeLabel: { ...typography.caption, color: palette.textDim },
  presetBadgeName: { ...typography.heading, color: palette.text },

  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.lg,
  },
  carousel: { height: 44, justifyContent: 'center' },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
  },
  recent: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  recentImg: { width: '100%', height: '100%' },
  recentEmpty: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterHit: { padding: 6 },
  shutterOuter: {
    width: layout.shutterSize,
    height: layout.shutterSize,
    borderRadius: layout.shutterSize / 2,
    backgroundColor: palette.text,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  shutterInner: {
    width: layout.shutterSize - 20,
    height: layout.shutterSize - 20,
    borderRadius: (layout.shutterSize - 20) / 2,
    backgroundColor: palette.text,
  },

  permTitle: { ...typography.title, color: palette.text },
  permBody: { ...typography.body, color: palette.textDim, textAlign: 'center' },
  permButton: {
    marginTop: spacing.md,
    backgroundColor: palette.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  permButtonText: { ...typography.heading, color: palette.bg0 },
  permSecondary: { padding: spacing.md },
  permSecondaryText: { ...typography.body, color: palette.textDim },
});
