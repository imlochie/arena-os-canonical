import type { RemixStateInput, RemixTrackInput } from "@/lib/remix";
import type { GridDivision } from "@/lib/timing";

export type Stem = {
  id: string;
  sourceAssetId: string;
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

export type SourceAnalysis = {
  id: string;
  status: "queued" | "preparing" | "processing" | "finalizing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGrid: number[] | null;
  beatConfidence: number | null;
  analysisError: string | null;
  analyzedAt: string | null;
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
  analysis?: SourceAnalysis | null;
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
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: GridDivision;
  snapEnabled: boolean;
  tracks: PersistedTrack[];
};

export type RemixVersionSummary = { id: string; name: string; createdAt: string };

export function sourceStemLabel(source: Source | undefined, stemType: string) {
  const name = source?.originalFilename ?? "Unknown source";
  return `${name} — ${stemType[0]?.toUpperCase() ?? ""}${stemType.slice(1)}`;
}

export function remixState(remix: Remix): RemixStateInput {
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
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
