/**
 * usePhotoImport — permission-aware photo import from the Photos library.
 *
 * Permissions are requested lazily, only when the user actually taps import
 * (per the product principle). Returns a `pick()` that resolves to a SourceAsset
 * or null (cancelled/denied). The decision + normalisation logic lives in the
 * pure `permissions` module so it is unit-tested independently of the native SDK.
 */

import { useCallback } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { SourceAsset } from '../engine/types';
import { normalizePickerResult, resolvePermission } from './permissions';

export function usePhotoImport() {
  const pick = useCallback(async (): Promise<SourceAsset | null> => {
    // Request permission on demand.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    const outcome = resolvePermission({
      granted: perm.granted,
      canAskAgain: perm.canAskAgain ?? true,
    });
    if (outcome !== 'granted') {
      if (outcome === 'denied-open-settings') {
        Alert.alert(
          'Photos access needed',
          'Enable Photos access for LUMA in Settings to import photos.',
        );
      }
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
      exif: false,
    });

    return normalizePickerResult(result);
  }, []);

  return { pick };
}
