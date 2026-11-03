import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR,
  ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
} from "./arrangement-preview-memory";
import { useArrangementPreview } from "./useArrangementPreview";

function asset(id: string, durationSeconds: number, fileSizeBytes = 1_000_000) {
  return { id, durationSeconds, sampleRate: 44_100, channels: 2, fileSizeBytes };
}

function stateFor(
  assetIds: string[],
  previewAssets: ReturnType<typeof asset>[],
  mutedAssetIds: string[] = [],
  clipDurationMs = 8_000,
) {
  return {
    masterVolume: 1,
    loopStartMs: 0,
    loopEndMs: null,
    tracks: assetIds.map((assetId, index) => ({
      id: `fixture-track-${assetId}`,
      stemAssetId: assetId,
      name: assetId,
      sortOrder: index,
      volume: 1,
      pan: 0,
      muted: mutedAssetIds.includes(assetId),
      solo: false,
      clips: [{
        id: `fixture-clip-${assetId}`,
        stemAssetId: assetId,
        timelineStartMs: 0,
        // Web Audio decodes the full source even when the clip uses only part.
        durationMs: clipDurationMs,
        sourceOffsetMs: 0,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      }],
    })),
    previewAssets,
  };
}

type PreviewScenarioName = "normal" | "long" | "longEncoded" | "many" | "muted" | "switchA" | "switchB";
type PreviewInput = Parameters<ReturnType<typeof useArrangementPreview>["play"]>[0];

declare global {
  interface Window {
    __previewFixtureConfig?: {
      longAudioSeconds: number;
      longAudioFileSizeBytes: number;
    };
    __previewMemoryBudget?: {
      limitBytes: number;
      decodeHeadroomFactor: number;
    };
  }
}

const longAudioConfig = window.__previewFixtureConfig ?? {
  longAudioSeconds: 240,
  longAudioFileSizeBytes: 4_000_000,
};

const previewScenarios: Record<PreviewScenarioName, PreviewInput> = {
  normal: stateFor(["fixture-stem"], [asset("fixture-stem", 8, 705_644)]),
  long: stateFor(["preview-long"], [asset("preview-long", 300, 5_000_000)]),
  longEncoded: stateFor(
    ["preview-long-encoded"],
    [asset("preview-long-encoded", longAudioConfig.longAudioSeconds, longAudioConfig.longAudioFileSizeBytes)],
    [],
    longAudioConfig.longAudioSeconds * 1_000,
  ),
  many: stateFor(
    ["preview-many-vocals", "preview-many-bass", "preview-many-drums", "preview-many-melody"],
    ["vocals", "bass", "drums", "melody"].map((stem) => asset(`preview-many-${stem}`, 80)),
  ),
  muted: stateFor(
    ["preview-muted-vocals", "preview-muted-bass", "preview-muted-drums", "preview-muted-melody"],
    ["vocals", "bass", "drums", "melody"].map((stem) => asset(`preview-muted-${stem}`, 80)),
    ["preview-muted-bass", "preview-muted-drums", "preview-muted-melody"],
  ),
  switchA: stateFor(["preview-switch-a"], [asset("preview-switch-a", 8, 705_644)]),
  switchB: stateFor(["preview-switch-b"], [asset("preview-switch-b", 8, 705_644)]),
};

declare global {
  interface Window {
    preview: ReturnType<typeof useArrangementPreview>;
    previewPosition: number;
    playPreview: () => void;
    playPreviewScenario: (scenario: PreviewScenarioName) => Promise<void>;
  }
}

function Fixture() {
  const [position, setPosition] = useState(0);
  const preview = useArrangementPreview(setPosition);
  Object.assign(window, {
    preview,
    previewPosition: position,
    __previewMemoryBudget: {
      limitBytes: ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
      decodeHeadroomFactor: ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR,
    },
    playPreview: () => void preview.play(previewScenarios.normal, position),
    playPreviewScenario: (scenario: keyof typeof previewScenarios) =>
      preview.play(previewScenarios[scenario], 0),
  });

  return (
    <main>
      <button onClick={() => void preview.play(previewScenarios.normal, position)}>Play preview</button>
      <button onClick={() => void preview.play(previewScenarios.long, 0)}>Play long preview</button>
      <button onClick={() => void preview.play(previewScenarios.longEncoded, 0)}>Play realistic long encoded preview</button>
      <button onClick={() => void preview.play(previewScenarios.many, 0)}>Play many-stem preview</button>
      <button onClick={() => void preview.play(previewScenarios.muted, 0)}>Play muted arrangement</button>
      <button onClick={() => void preview.play(previewScenarios.switchA, 0)}>Play switch arrangement A</button>
      <button onClick={() => void preview.play(previewScenarios.switchB, 0)}>Play switch arrangement B</button>
      <button onClick={preview.pause}>Pause preview</button>
      <button onClick={preview.stop}>Stop preview</button>
      <output data-testid="playing">{String(preview.playing)}</output>
      <output data-testid="pending">{String(preview.pending)}</output>
      <output data-testid="position">{position}</output>
      <output data-testid="error">{preview.error}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
