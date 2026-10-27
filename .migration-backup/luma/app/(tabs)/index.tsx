/**
 * CAMERA (V2) — the default landing screen, reframed around "cameras, not filters".
 *
 * The user swipes a strip of five cameras (DigiCam · Clean · FilmBox · Mono ·
 * Nox). The chosen camera gives the viewfinder an identity (a cheap tint/vignette
 * HINT — not real grading; true live processing needs a native frame processor,
 * the top roadmap item). Within a camera you can pick one of its looks. The
 * shutter captures and hands straight off to the non-destructive editor with the
 * selected look preselected.
 *
 * Internally nothing about the engine changed: a "look" is a Preset recipe id and
 * capture seeds an EditRecipe. The camera layer is pure product framing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { CameraType, CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';

import { IconButton } from '../../src/ui/components/IconButton';
import { CameraSelector } from '../../src/ui/components/CameraSelector';
import { usePresets } from '../../src/ui/usePresets';
import { usePhotoImport } from '../../src/ui/usePhotoImport';
import { useEditorStore } from '../../src/state/editorStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { haptic } from '../../src/ui/haptics';
import { EMPTY_RECIPE } from '../../src/engine/types';
import { CAMERAS, DEFAULT_CAMERA_ID, getCamera } from '../../src/cameras/catalog';
import { getBuiltInPreset } from '../../src/presets/library';
import { analyzeSourceImage } from '../../src/engine/adaptiveNative';
import { palette, layout, radius, spacing, typography } from '../../src/theme/tokens';

type CycleFlash = 'off' | 'auto' | 'on';
const FLASH_ORDER: CycleFlash[] = ['off', 'auto', 'on'];
const FLASH_ICON = { off: 'flash-off', auto: 'flash-auto', on: 'flash-on' } as const;

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cameraRef = useRef<CameraView>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<CycleFlash>('off');
  const [capturing, setCapturing] = useState(false);
  const [lastPhoto, setLastPhoto] = useState<string | null>(null);

  // Ensure the preset library is registered so the editor can resolve looks.
  usePresets();
  const { pick } = usePhotoImport();
  const cameraId = useSettingsStore((s) => s.cameraId);
  const cameraLookId = useSettingsStore((s) => s.cameraLookId);
  const setCamera = useSettingsStore((s) => s.setCamera);
  const setCameraLook = useSettingsStore((s) => s.setCameraLook);
  const beginSession = useEditorStore((s) => s.beginSession);

  const activeCamera = getCamera(cameraId) ?? getCamera(DEFAULT_CAMERA_ID)!;
  const lookPreset = cameraLookId ? getBuiltInPreset(cameraLookId) ?? null : null;

  // The looks available inside the active camera, resolved to presets.
  const cameraLooks = useMemo(
    () =>
      activeCamera.lookIds
        .map((id) => getBuiltInPreset(id))
        .filter((p): p is NonNullable<typeof p> => !!p),
    [activeCamera],
  );

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const openEditorWith = useCallback(
    async (uri: string, w: number, h: number, assetId?: string) => {
      let analysis;
      try {
        analysis = await analyzeSourceImage(uri);
      } catch {
        // Analysis is an optimization; editing still works if a decoder fails.
        analysis = undefined;
      }
      beginSession(
        { uri, width: w, height: h, assetId },
        {
          recipe: {
            ...EMPTY_RECIPE,
            adjustments: { ...EMPTY_RECIPE.adjustments },
            crop: { ...EMPTY_RECIPE.crop },
            presetId: cameraLookId,
            presetIntensity: lookPreset?.defaultIntensity ?? 1,
            analysis,
          },
        },
      );
      router.push('/editor');
    },
    [beginSession, cameraLookId, lookPreset, router],
  );

  const onCapture = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    haptic('medium');
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (photo?.uri) {
        setLastPhoto(photo.uri);
        openEditorWith(photo.uri, photo.width ?? 0, photo.height ?? 0);
      }
    } catch {
      // ignore; a toast could be added later
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
    setFlash(FLASH_ORDER[(i + 1) % FLASH_ORDER.length] ?? 'off');
  };

  const onSelectCamera = useCallback(
    (cam: (typeof CAMERAS)[number]) => {
      setCamera(cam.id, cam.defaultLookId);
    },
    [setCamera],
  );

  if (!permission) {
    return <View style={styles.container} />;
  }
  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.permTitle}>Camera access</Text>
        <Text style={styles.permBody}>
          LUMA needs the camera to shoot with your chosen look.
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

      {/* Viewfinder identity hint (cheap tint + vignette; not real grading) */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: activeCamera.hint.tint }]} />
        {activeCamera.hint.vignette > 0 ? (
          <View
            style={[
              styles.vignette,
              { opacity: activeCamera.hint.vignette },
            ]}
          />
        ) : null}
      </View>

      {/* Top controls */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton
          icon={FLASH_ICON[flash]}
          label={flash.toUpperCase()}
          onPress={cycleFlash}
          active={flash !== 'off'}
        />
        <View style={styles.brandWrap}>
          <Text style={styles.brand}>LUMA</Text>
          {activeCamera.hint.mono ? (
            <Text style={styles.monoNote}>MONO · applied on capture</Text>
          ) : null}
        </View>
        <IconButton
          icon="flip"
          label="FLIP"
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
        />
      </View>

      {/* Bottom cluster */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.md }]}>
        {/* Look sub-selector (the current camera's looks) */}
        <View style={styles.lookRow}>
          {cameraLooks.map((look) => {
            const active = look.id === cameraLookId;
            return (
              <Pressable
                key={look.id}
                onPress={() => {
                  haptic('selection');
                  setCameraLook(look.id);
                }}
                style={[styles.lookChip, active && styles.lookChipActive]}
              >
                <Text style={[styles.lookText, active && styles.lookTextActive]}>
                  {look.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Camera selector */}
        <CameraSelector
          cameras={CAMERAS}
          selectedId={cameraId}
          onSelect={onSelectCamera}
          screenWidth={width}
          previewUri={lastPhoto}
        />

        {/* Shutter row */}
        <View style={styles.shutterRow}>
          <Pressable style={styles.recent} onPress={onImport} accessibilityLabel="Import photo">
            {lastPhoto ? (
              <ExpoImage source={{ uri: lastPhoto }} style={styles.recentImg} contentFit="cover" />
            ) : (
              <View style={styles.recentEmpty}>
                <IconButton icon="image" size={30} onPress={onImport} />
              </View>
            )}
          </Pressable>

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

          <View style={styles.recent} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg0 },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },

  vignette: {
    ...StyleSheet.absoluteFill,
    borderRadius: 1,
    borderWidth: 90,
    borderColor: 'rgba(0,0,0,0.55)',
  },

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
  brandWrap: { alignItems: 'center', paddingTop: spacing.sm },
  brand: { ...typography.title, color: palette.text, letterSpacing: 3 },
  monoNote: { ...typography.caption, color: palette.textDim, marginTop: 2 },

  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.md,
  },
  lookRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  lookChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: palette.scrim,
  },
  lookChipActive: { backgroundColor: palette.accent },
  lookText: { ...typography.caption, color: palette.text },
  lookTextActive: { color: palette.bg0 },

  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
  },
  recent: { width: 52, height: 52, borderRadius: radius.md, overflow: 'hidden' },
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
