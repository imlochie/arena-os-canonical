// Browser-only test fixture: real React hook, HTML media, Web Audio nodes and
// analyser readings. The deterministic tone files are not separated audio.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useStemTransport } from "../../src/lib/waveyard/useStemTransport";

declare global {
  interface Window {
    transport: ReturnType<typeof useStemTransport>;
    refreshAssets: () => void;
    replaceAssets: () => void;
    removeElement: () => void;
    remountElements: () => void;
  }
}

function Fixture() {
  const [ids, setIds] = useState(["vocals", "drums"]);
  const [mix, setMix] = useState({
    vocals: { volume: 1, pan: 0, muted: false, solo: false },
    drums: { volume: 1, pan: 0, muted: false, solo: false },
  });
  const [missing, setMissing] = useState(false);
  const [revision, setRevision] = useState(0);
  const transport = useStemTransport(ids, 2);
  // Exposed only by this bundled acceptance fixture, never in the product.
  Object.assign(window, {
    transport,
    refreshAssets: () => setIds((current) => [...current]),
    replaceAssets: () => setIds(["bass", "melody"]),
    removeElement: () => setMissing(true),
    remountElements: () => setRevision((value) => value + 1),
  });
  function change(channel: "vocals" | "drums", patch: Partial<typeof mix.vocals>) {
    const next = { ...mix, [channel]: { ...mix[channel], ...patch } };
    setMix(next);
    transport.applyMix(next);
  }
  return <main>
    <button onClick={() => { transport.applyMix(mix); void transport.play(); }}>Play</button>
    <button onClick={() => transport.applyMix({ vocals: { volume: 1, pan: 0, muted: false, solo: true } })}>Sparse vocals solo</button>
    <button onClick={() => transport.applyMix({ obsolete: { volume: 1, pan: 0, muted: false, solo: true } })}>Removed bank solo</button>
    <button onClick={transport.pause}>Pause</button>
    <button onClick={transport.stop}>Stop</button>
    <button onClick={() => change("vocals", { muted: !mix.vocals.muted })}>Mute vocals</button>
    <button onClick={() => change("vocals", { solo: !mix.vocals.solo })}>Solo vocals</button>
    <button onClick={() => change("vocals", { volume: 0.25 })}>Lower vocals</button>
    <button onClick={() => transport.seek(0.7)}>Seek</button>
    <button onClick={() => transport.setLoop({ enabled: true, start: 0.2, end: 0.8 })}>Loop</button>
    <button onClick={() => transport.setLoop({ enabled: false, start: 0, end: 0 })}>No loop</button>
    <button onClick={() => transport.applyInserts({}, [{
      id: "master-gain", processor: "gain", enabled: true, wet: 1, params: { gainDb: -18 },
    }])}>Master insert</button>
    <output data-testid="playing">{String(transport.playing)}</output>
    <output data-testid="error">{transport.error}</output>
    {ids.map((id) => missing && id === "drums" ? null : <audio key={`${id}-${revision}`} data-id={id}
      ref={(element) => transport.register(id, element)} src={`/tones/${id}.wav`} preload="auto" />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
