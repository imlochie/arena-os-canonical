"use client";

import { useCallback, useEffect, useState } from "react";

type Model = { id: string; label: string; ready: boolean; sizeBytes: number };
const REQUIRED = ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"];

/** Make the prerequisite for actual four-stem playback visible at intake. */
export default function StemEngineSetup() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/waveyard/separation/models", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.models)) throw new Error(body.error ?? "Could not check the stem engine.");
    const required = REQUIRED.map((id) => body.models.find((model: Model) => model.id === id));
    if (required.some((model) => !model)) throw new Error("The four-stem model registry is incomplete.");
    setModels(required);
    setError("");
    return required as Model[];
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not check the stem engine."));
  }, [refresh]);

  async function prepare() {
    if (preparing) return;
    setPreparing(true);
    setError("");
    try {
      const current = await refresh();
      const missing = current.filter((model) => !model.ready);
      for (let index = 0; index < missing.length; index++) {
        const model = missing[index];
        setProgress(`Preparing stem engine ${index + 1}/${missing.length}…`);
        const response = await fetch(`/api/waveyard/separation/models/${model.id}/seed`, { method: "POST" });
        const body = await response.json();
        if (!response.ok || !body.model?.ready) throw new Error(body.error ?? `${model.label} could not be prepared.`);
        await refresh();
      }
      setProgress("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The stem engine could not be prepared.");
    } finally {
      setPreparing(false);
    }
  }

  const ready = models?.every((model) => model.ready) ?? false;
  const downloadMb = Math.round((models?.filter((model) => !model.ready).reduce((bytes, model) => bytes + model.sizeBytes, 0) ?? 0) / 1_000_000);

  return (
    <div className="library-message" style={{ padding: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <span role="status" data-testid="stem-engine-status">
          {preparing ? progress || "Checking stem models…" : ready ? "Four stem model files present · vocals / drums / bass / other" : models ? `Prepare stems once (${downloadMb} MB) to enable separation.` : "Checking stem models…"}
        </span>
        {!ready && (
          <button type="button" disabled={preparing} onClick={() => { if (models) void prepare(); else void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not check the stem engine.")); }} className="btn-arena rounded-lg px-3 py-2 text-xs font-bold text-white">
            {preparing ? "Preparing…" : models ? "Prepare stems" : "Check stem engine"}
          </button>
        )}
      </div>
      {error && <p role="alert" style={{ color: "#fca5a5", marginTop: 8 }}>{error}</p>}
    </div>
  );
}
