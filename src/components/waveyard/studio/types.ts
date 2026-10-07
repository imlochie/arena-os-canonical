import type { RemixStateInput, RemixTrackInput } from "@/lib/waveyard/remix";
import type { RemixAutomationLane } from "@/lib/waveyard/types";
import type { GridDivision } from "@/lib/waveyard/timing";

export type DrumAnalysis = {
  id: string;
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type DrumEvent = {
  id: string;
  timestampMs: number;
  strength: number;
  confidence: number;
  rhythmicClass: "kick" | "snare" | "hat" | "other" | null;
  nearestBeatIndex: number | null;
  beatOffsetMs: number | null;
};

export type VocalAnalysis = {
  id: string;
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type VocalPitchFrame = {
  id: string;
  timestampMs: number;
  frequencyHz: number | null;
  midiFloat: number | null;
  nearestMidiNote: number | null;
  confidence: number;
  voiced: boolean;
};

export type VocalPhrase = { id: string; startMs: number; endMs: number; confidence: number };

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
  drumAnalysis?: DrumAnalysis | null;
  drumEvents?: DrumEvent[];
  vocalAnalysis?: VocalAnalysis | null;
  vocalFrames?: VocalPitchFrame[];
  vocalPhrases?: VocalPhrase[];
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

export type SourceSectionAnalysis = {
  id: string;
  status: "queued" | "preparing" | "processing" | "complete" | "failed" | "unavailable";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type SourceAlignmentInfo = {
  sourceAssetId: string;
  sourceName: string;
  analysisStatus: string;
  bpm: number | null;
  musicalKey: string | null;
  beatGrid: number[] | null;
  beatConfidence: number | null;
  sectionAnalysisStatus: string | null;
};

export type HarmonyAnalysis = {
  id: string;
  status: "queued" | "processing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type HarmonyEvent = {
  id: string;
  startMs: number;
  endMs: number;
  root: string | null;
  quality: "major" | "minor" | "dominant7" | "minor7" | "major7" | "diminished" | "augmented" | "unknown";
  confidence: number;
};

export type SourceEventAnalysis = {
  id: string;
  status: "queued" | "preparing" | "processing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type SourceEvent = { id: string; timestampMs: number; strength: number };

export type SourceSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  startBeatIndex: number;
  endBeatIndex: number;
  startBar: number;
  endBar: number;
  label: "section";
  labelConfidence: number;
  structuralConfidence: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  sourceChecksumSha256: string;
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
  acquisition?: { method: string; sourceUrl: string | null; title: string | null; artist: string | null; resolver: string | null; metadata: string; createdAt: string } | null;
  sectionAnalysis?: SourceSectionAnalysis | null;
  sections?: SourceSection[];
  eventAnalysis?: SourceEventAnalysis | null;
  events?: SourceEvent[];
  harmonyAnalysis?: HarmonyAnalysis | null;
  harmonyEvents?: HarmonyEvent[];
};

export type PersistedTrack = RemixTrackInput & {
  clips: Array<RemixTrackInput["clips"][number] & { id?: string }>;
};

export type Remix = {
  id: string;
  name: string;
  masterVolume: number;
  /** Master insert chain (waveyard-inserts-v1); absent on historical sessions. */
  masterInserts?: import("@/lib/waveyard/mixer/inserts").InsertChain;
  loopStartMs: number;
  loopEndMs: number | null;
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: GridDivision;
  snapEnabled: boolean;
  targetKey: string | null;
  tracks: PersistedTrack[];
  automation: RemixAutomationLane[];
};

export type RemixVersionSummary = { id: string; name: string; createdAt: string };
export type AutomaticRemixGenerationSummary = { engine: string; engineVersion: string; variant: "original" | "hybrid"; createdAt: string };

export function sourceStemLabel(source: Source | undefined, stemType: string) {
  const name = source?.originalFilename ?? "Unknown source";
  return `${name} — ${stemType[0]?.toUpperCase() ?? ""}${stemType.slice(1)}`;
}

export function remixState(remix: Remix): RemixStateInput {
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    ...(remix.masterInserts !== undefined ? { masterInserts: remix.masterInserts } : {}),
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
    targetKey: remix.targetKey,
    tracks: remix.tracks,
    automation: remix.automation,
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
