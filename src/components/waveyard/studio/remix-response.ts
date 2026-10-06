import type { Remix } from "./types";

/**
 * The persisted remix endpoint always returns all three pieces of editable
 * arrangement state. Keep this conversion at the client boundary so every
 * hydration path preserves empty automation lanes as an empty array rather
 * than dropping the field altogether.
 */
export type PersistedRemixResponse = {
  remix: Omit<Remix, "tracks" | "automation">;
  tracks: Remix["tracks"];
  automation: Remix["automation"];
};

export function remixFromResponse(response: PersistedRemixResponse): Remix {
  return {
    ...response.remix,
    tracks: response.tracks,
    automation: response.automation,
  };
}
