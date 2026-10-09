/**
 * Pure permission-flow helpers, decoupled from the native modules so they can be
 * unit-tested deterministically. The hooks (usePhotoImport, useExport) call these
 * with the results of the native permission APIs.
 *
 * Principle: permissions are only ever requested at the point of use, and denial
 * is handled gracefully (no crashes, a clear "open Settings" path when the user
 * has permanently denied).
 */

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

export type PermissionOutcome =
  | 'granted'
  | 'denied-can-retry'
  | 'denied-open-settings';

/** Decide what to do given the OS permission response. */
export function resolvePermission(state: PermissionState): PermissionOutcome {
  if (state.granted) return 'granted';
  if (state.canAskAgain) return 'denied-can-retry';
  return 'denied-open-settings';
}

export interface RawPickedAsset {
  uri: string;
  width?: number | null;
  height?: number | null;
  assetId?: string | null;
}

export interface PickerResultLike {
  canceled: boolean;
  assets?: RawPickedAsset[] | null;
}

/** Normalise a picker result into a SourceAsset (or null if none/cancelled). */
export function normalizePickerResult(result: PickerResultLike) {
  if (result.canceled) return null;
  const a = result.assets?.[0];
  if (!a) return null;
  return {
    uri: a.uri,
    width: a.width ?? 0,
    height: a.height ?? 0,
    assetId: a.assetId ?? undefined,
  };
}
