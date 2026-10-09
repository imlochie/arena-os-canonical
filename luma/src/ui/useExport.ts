/**
 * useExport — high-quality render + save/share of the current edit.
 *
 * Uses the ProcessingEngine's export renderer (never the on-screen preview) so
 * exports are full quality. Saving to the library requests permission lazily and
 * writes a NEW asset — the original is never modified (non-destructive contract).
 */

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { getEngine } from '../engine';
import { EditRecipe, Preset, SourceAsset } from '../engine/types';
import { exportParamsFor } from '../storage/settings';
import { useSettingsStore } from '../state/settingsStore';
import { haptic } from './haptics';

interface ExportArgs {
  source: SourceAsset;
  recipe: EditRecipe;
  preset: Preset | null;
}

export function useExport() {
  const [busy, setBusy] = useState(false);
  const settings = useSettingsStore((s) => s.settings);

  const renderToFile = useCallback(
    async ({ source, recipe, preset }: ExportArgs): Promise<string | null> => {
      const engine = getEngine();
      if (!engine.exportImage) {
        Alert.alert('Export unavailable', 'The image engine cannot export in this build.');
        return null;
      }
      const params = exportParamsFor(settings.exportQuality);
      const result = await engine.exportImage(source, recipe, preset, {
        maxDimension: params.maxDimension,
        quality: params.jpegQuality,
        format: 'jpeg',
      });
      return result.uri;
    },
    [settings.exportQuality],
  );

  const saveToLibrary = useCallback(
    async (args: ExportArgs): Promise<boolean> => {
      setBusy(true);
      try {
        const uri = await renderToFile(args);
        if (!uri) return false;

        const MediaLibrary = require('expo-media-library');
        const perm = await MediaLibrary.requestPermissionsAsync(true);
        if (!perm.granted) {
          Alert.alert(
            'Photos access needed',
            'Enable Photos access for LUMA in Settings to save your edit.',
          );
          return false;
        }
        await MediaLibrary.saveToLibraryAsync(uri);
        haptic('success');
        return true;
      } catch (e) {
        Alert.alert('Export failed', e instanceof Error ? e.message : 'Unknown error.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [renderToFile],
  );

  const share = useCallback(
    async (args: ExportArgs): Promise<boolean> => {
      setBusy(true);
      try {
        const uri = await renderToFile(args);
        if (!uri) return false;
        const Sharing = require('expo-sharing');
        if (!(await Sharing.isAvailableAsync())) {
          Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
          return false;
        }
        await Sharing.shareAsync(uri, { mimeType: 'image/jpeg' });
        return true;
      } catch (e) {
        Alert.alert('Share failed', e instanceof Error ? e.message : 'Unknown error.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [renderToFile],
  );

  return { busy, saveToLibrary, share, renderToFile };
}
