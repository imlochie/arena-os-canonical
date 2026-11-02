import type { Remix } from "./types";
import type { ArrangementPreviewAssetMetadata } from "@workspace/arena/lib/waveyard/arrangement-preview-memory";

/**
 * The persisted remix endpoint always returns all three pieces of editable
 * arrangement state. Keep this conversion at the client boundary so every
 * hydration path preserves empty automation lanes as an empty array rather
 * than dropping the field altogether.
 */
export type PersistedRemixResponse = {
  remix: Omit<Remix, "tracks" | "automation" | "previewAssets">;
  tracks: Remix["tracks"];
  automation: Remix["automation"];
  stems?: ArrangementPreviewAssetMetadata[];
};

export function remixFromResponse(response: PersistedRemixResponse): Remix {
  const raw = response.remix as { masterInserts?: unknown };
  let masterInserts: Remix["masterInserts"];
  if (typeof raw.masterInserts === "string") {
    try {
      const parsed = JSON.parse(raw.masterInserts);
      if (Array.isArray(parsed)) masterInserts = parsed as Remix["masterInserts"];
    } catch {
      /* corrupt stored chain degrades to absent — the UI treats it as empty */
    }
  } else if (Array.isArray(raw.masterInserts)) {
    masterInserts = raw.masterInserts as Remix["masterInserts"];
  }
  return {
    ...response.remix,
    ...(masterInserts !== undefined ? { masterInserts } : {}),
    tracks: response.tracks,
    automation: response.automation,
    previewAssets: Array.isArray(response.stems) ? response.stems : [],
  };
}
