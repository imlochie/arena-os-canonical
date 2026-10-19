"use client";
import { useRef, useState } from "react";
type Model = {
  id: string;
  label: string;
  file: string;
  sourceUrl: string;
  sha256: string;
  license: string;
  ready: boolean;
};
export function ModelAssetImport() {
  const controller = useRef<AbortController | null>(null);
  const [models, setModels] = useState<Model[]>([]),
    [status, setStatus] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const response = await fetch("/api/waveyard/separation/models", {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setModels(body.models);
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function install(model: Model, file: File) {
    controller.current = new AbortController();
    setBusy(true);
    setStatus("Verifying owner-supplied bytes against the pinned checksum…");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("rightsReviewed", String(reviewed));
      const response = await fetch(
        `/api/waveyard/separation/models/${encodeURIComponent(model.id)}/import`,
        { method: "POST", body: form, signal: controller.current.signal },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setStatus(
        body.notice +
          " Use Prepare engine / Retry for the selected separation target after all prerequisites are installed.",
      );
      await load();
    } catch (error) {
      setStatus(String(error));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Model sources, licences and exact-file import</summary>
      <p>
        No alternate mirrors or unverified files are accepted. Import a file you
        already obtained legitimately when the registry host is unavailable.
        Native ONNX binding, file readiness and learned inference are different
        checks. The listed community-model licensing status may still require
        permission verification.
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        Inspect this machine’s model manifests
      </button>
      <label>
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I reviewed the source/licensing conditions and am authorised to obtain
        and use the supplied model file.
      </label>
      {busy && (
        <button type="button" onClick={() => controller.current?.abort()}>
          Cancel model file import
        </button>
      )}
      {models.map((model) => (
        <div key={model.id}>
          <b>
            {model.label} ·{" "}
            {model.ready
              ? "installed and checksum-verified"
              : "not installed/verified"}
          </b>
          <p>
            {model.file} · {model.license}
          </p>
          <a href={model.sourceUrl} rel="noreferrer" target="_blank">
            Pinned upstream source
          </a>
          <p>
            Required SHA-256: <code>{model.sha256}</code>
          </p>
          <input
            aria-label={`Import exact ${model.label} model`}
            type="file"
            accept=".onnx"
            disabled={busy || !reviewed}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void install(model, file);
              event.target.value = "";
            }}
          />
        </div>
      ))}
      <p role="status">{status}</p>
    </details>
  );
}
