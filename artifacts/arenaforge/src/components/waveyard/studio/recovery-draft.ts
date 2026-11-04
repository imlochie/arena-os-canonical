import { remixState, type Remix } from "./types";

type DraftPayload = {
  version: 1;
  projectId: string;
  remixId: string;
  baseVersion: number;
  savedAt: string;
  state: ReturnType<typeof remixState>;
};

function storageKey(projectId: string, remixId: string) {
  return `waveyard-studio-recovery-v1:${encodeURIComponent(projectId)}:${encodeURIComponent(remixId)}`;
}

export function writeStudioRecoveryDraft(projectId: string, remix: Remix, baseVersion = remix.version): boolean {
  try {
    const draft: DraftPayload = {
      version: 1,
      projectId,
      remixId: remix.id,
      baseVersion,
      savedAt: new Date().toISOString(),
      state: remixState(remix),
    };
    window.localStorage.setItem(storageKey(projectId, remix.id), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function studioRecoveryDraftIsStale(projectId: string, canonical: Remix): boolean {
  try {
    const saved = window.localStorage.getItem(storageKey(projectId, canonical.id));
    if (!saved) return false;
    const draft = JSON.parse(saved) as Partial<DraftPayload>;
    return draft.version === 1
      && draft.projectId === projectId
      && draft.remixId === canonical.id
      && draft.baseVersion !== canonical.version;
  } catch {
    return false;
  }
}

export function readStudioRecoveryDraft(projectId: string, canonical: Remix): Remix | null {
  try {
    const saved = window.localStorage.getItem(storageKey(projectId, canonical.id));
    if (!saved) return null;
    const draft = JSON.parse(saved) as Partial<DraftPayload>;
    const state = draft.state;
    if (
      draft.version !== 1
      || draft.projectId !== projectId
      || draft.remixId !== canonical.id
      || typeof draft.savedAt !== "string"
      || !Number.isFinite(Date.parse(draft.savedAt))
      || !state
      || typeof state.name !== "string"
      || typeof state.masterVolume !== "number"
      || !Array.isArray(state.tracks)
      || !Array.isArray(state.automation)
    ) return null;

    const canonicalTracks = new Map(canonical.tracks.map((track) => [track.id, track]));
    const validStemIds = new Set([
      ...canonical.tracks.map((track) => track.stemAssetId),
      ...(canonical.previewAssets ?? []).map((asset) => asset.id),
    ]);
    if (state.tracks.length !== canonical.tracks.length) return null;
    for (const track of state.tracks) {
      const original = canonicalTracks.get(track.id);
      if (!original || original.stemAssetId !== track.stemAssetId || !Array.isArray(track.clips)) return null;
      for (const clip of track.clips) {
        if (
          ("remixTrackId" in clip && clip.remixTrackId !== track.id)
          || !validStemIds.has(clip.stemAssetId)
          || !Number.isFinite(clip.timelineStartMs)
          || !Number.isFinite(clip.sourceOffsetMs)
          || !Number.isFinite(clip.durationMs)
        ) return null;
      }
    }

    const recovered = {
      ...canonical,
      ...state,
      id: canonical.id,
      tracks: state.tracks,
      automation: state.automation,
      previewAssets: canonical.previewAssets,
    } as Remix;
    return JSON.stringify(remixState(recovered)) === JSON.stringify(remixState(canonical))
      ? null
      : recovered;
  } catch {
    return null;
  }
}

export function clearStudioRecoveryDraft(projectId: string, remix: Remix) {
  try {
    const key = storageKey(projectId, remix.id);
    const saved = window.localStorage.getItem(key);
    if (!saved) return;
    const draft = JSON.parse(saved) as Partial<DraftPayload>;
    // Another open Studio tab may already have written a newer edit. A
    // completed save only clears the exact snapshot it confirmed.
    if (JSON.stringify(draft.state) === JSON.stringify(remixState(remix))) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Keep storage failures from interrupting the server save path.
  }
}

export function discardStudioRecoveryDraft(projectId: string, remixId: string) {
  try {
    window.localStorage.removeItem(storageKey(projectId, remixId));
  } catch {
    // The current arrangement remains safe even if local cleanup is blocked.
  }
}
