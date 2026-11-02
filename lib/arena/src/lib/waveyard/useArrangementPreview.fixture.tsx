import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import { useArrangementPreview } from "./useArrangementPreview";

const previewState = {
  masterVolume: 1,
  loopStartMs: 0,
  loopEndMs: null,
  tracks: [{
    id: "fixture-track",
    stemAssetId: "fixture-stem",
    name: "Fixture",
    sortOrder: 0,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    clips: [{
      id: "fixture-clip",
      stemAssetId: "fixture-stem",
      timelineStartMs: 0,
      durationMs: 8_000,
      sourceOffsetMs: 0,
      gain: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      tempoSyncEnabled: false,
      keySyncEnabled: false,
      beatSnapEnabled: false,
    }],
  }],
};

declare global {
  interface Window {
    preview: ReturnType<typeof useArrangementPreview>;
    previewPosition: number;
    playPreview: () => void;
  }
}

function Fixture() {
  const [position, setPosition] = useState(0);
  const preview = useArrangementPreview(setPosition);
  Object.assign(window, {
    preview,
    previewPosition: position,
    playPreview: () => void preview.play(previewState, position),
  });

  return (
    <main>
      <button onClick={() => void preview.play(previewState, position)}>Play preview</button>
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
