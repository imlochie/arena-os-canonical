import type { RemixStateInput, RemixTrackInput } from "@/lib/remix";

export type Stem = {
  id: string;
  stemType: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  format: string;
  fileSizeBytes: number;
  checksumSha256: string;
  model: string;
  modelVersion: string;
};

export type Source = {
  id: string;
  originalFilename: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
};

export type PersistedTrack = RemixTrackInput & {
  clips: Array<RemixTrackInput["clips"][number] & { id?: string }>;
};

export type Remix = {
  id: string;
  name: string;
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: PersistedTrack[];
};

export type RemixVersionSummary = { id: string; name: string; createdAt: string };

export function remixState(remix: Remix): RemixStateInput {
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tracks: remix.tracks,
  };
}

export function clock(seconds: number) {
  const min = Math.floor(Math.max(0, seconds) / 60);
  const sec = Math.floor(Math.max(0, seconds) % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function bytes(size: number) {
  return size > 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1_000))} KB`;
}
