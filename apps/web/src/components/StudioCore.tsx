"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WaveformCanvas } from "./WaveformCanvas";
import { ArrangementTimeline } from "./studio/ArrangementTimeline";
import { ClipInspector } from "./studio/ClipInspector";
import { StemMixer } from "./studio/StemMixer";
import { StudioTransport } from "./studio/StudioTransport";
import {
  remixState,
  type Remix,
  type RemixVersionSummary,
  type Source,
  type Stem,
} from "./studio/types";
import { useArrangementHistory } from "./studio/useArrangementHistory";
import { VersionHistory } from "./studio/VersionHistory";
import type { MixerValues } from "@/lib/useStemTransport";
import { useStemTransport } from "@/lib/useStemTransport";

function controlsFor(stems: Stem[]) {
  return Object.fromEntries(
    stems.map((stem) => [
      stem.id,
      { volume: 1, pan: 0, muted: false, solo: false },
    ]),
  ) as Record<string, MixerValues>;
}

export function StudioCore({
  projectId,
  stems,
  sources,
}: {
  projectId: string;
  stems: Stem[];
  sources: Source[];
}) {
  const ids = useMemo(() => stems.map((stem) => stem.id), [stems]);
  const duration = useMemo(
    () => Math.max(0, ...stems.map((stem) => stem.durationSeconds)),
    [stems],
  );
  const [controls, setControls] = useState<Record<string, MixerValues>>(() =>
    controlsFor(stems),
  );
  const [selectedId, setSelectedId] = useState(stems[0]?.id ?? "");
  const [remix, setRemix] = useState<Remix | null>(null);
  const [saveState, setSaveState] = useState<
    "saved" | "saving" | "unsaved" | "failed"
  >("saved");
  const [versions, setVersions] = useState<RemixVersionSummary[]>([]);
  const arrangementHistory = useArrangementHistory();
  const { history, future, reset, record, undo: historyUndo, redo: historyRedo } = arrangementHistory;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transport = useStemTransport(ids, duration);
  const selected = stems.find((stem) => stem.id === selectedId) ?? stems[0];
  const source = sources[0];

  useEffect(() => {
    transport.applyMix(controls);
  }, [controls, transport]);
  useEffect(() => {
    if (remix) transport.setMasterVolume(remix.masterVolume);
  }, [remix, transport]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const persist = useCallback(async (next: Remix) => {
    setSaveState("saving");
    const response = await fetch(`/api/remixes/${next.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(remixState(next)),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState("failed");
      return;
    }
    setRemix({ ...body.remix, tracks: body.tracks });
    setSaveState("saved");
  }, []);

  const loadRemix = useCallback(async (id: string) => {
    const response = await fetch(`/api/remixes/${id}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState("failed");
      return;
    }
    const next: Remix = { ...body.remix, tracks: body.tracks };
    setRemix(next);
    reset();
    setControls(
      Object.fromEntries(
        next.tracks.map((track) => [
          track.stemAssetId,
          {
            volume: track.volume,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
          },
        ]),
      ),
    );
    setSaveState("saved");
    const versionResponse = await fetch(`/api/remixes/${id}/versions`, {
      cache: "no-store",
    });
    const versionBody = await versionResponse.json().catch(() => ({}));
    if (versionResponse.ok) setVersions(versionBody.versions ?? []);
  }, [reset]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/remixes`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (active && response.ok && body.remixes?.[0]?.id)
          await loadRemix(body.remixes[0].id);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [loadRemix, projectId]);

  const changeRemix = (transform: (current: Remix) => Remix) => {
    if (!remix) return;
    const next = transform(remix);
    record(remix);
    setRemix(next);
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(next), 700);
  };

  const updateControl = (id: string, patch: Partial<MixerValues>) => {
    setControls((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
    changeRemix((current) => ({
      ...current,
      tracks: current.tracks.map((track) =>
        track.stemAssetId === id ? { ...track, ...patch } : track,
      ),
    }));
  };

  const createRemix = async () => {
    const response = await fetch(`/api/projects/${projectId}/remixes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First arrangement" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState("failed");
      return;
    }
    await loadRemix(body.remix.id);
  };

  const undo = () => {
    if (!remix) return;
    const prior = historyUndo(remix);
    if (!prior) return;
    setRemix(prior);
    void persist(prior);
  };
  const redo = () => {
    if (!remix) return;
    const next = historyRedo(remix);
    if (!next) return;
    setRemix(next);
    void persist(next);
  };

  const createVersion = async () => {
    if (!remix) return;
    const name = window
      .prompt("Name this remix version", `Version ${versions.length + 1}`)
      ?.trim();
    if (!name) return;
    const response = await fetch(`/api/remixes/${remix.id}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) setVersions((current) => [...current, body.version]);
    else setSaveState("failed");
  };
  const restoreVersion = async (versionId: string) => {
    if (!remix || !window.confirm("Restore this saved remix version?")) return;
    const response = await fetch(
      `/api/remixes/${remix.id}/versions/${versionId}/restore`,
      { method: "POST" },
    );
    if (response.ok) await loadRemix(remix.id);
    else setSaveState("failed");
  };

  return (
    <section className="studio" aria-label="Waveyard Studio">
      <header className="studio-head">
        <div>
          <span className="eyebrow">Studio core</span>
          <h2>Real stems, one transport.</h2>
        </div>
        <div className={`save-state ${saveState}`}>
          {saveState === "saved"
            ? "Saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "unsaved"
                ? "Unsaved changes"
                : "Save failed"}
        </div>
      </header>
      <div className="main-waveform">
        <div className="waveform-label">
          {source ? `Source · ${source.originalFilename}` : "Selected stem"}
        </div>
        <WaveformCanvas
          assetId={source?.id ?? selected.id}
          label="project waveform"
          position={transport.position}
          duration={duration}
          onSeek={transport.seek}
        />
      </div>
      <StudioTransport
        transport={transport}
        onMasterVolume={(volume) => {
          transport.setMasterVolume(volume);
          changeRemix((current) => ({ ...current, masterVolume: volume }));
        }}
      />
      <section className="studio-grid">
        <StemMixer
          stems={stems}
          selectedId={selectedId}
          duration={duration}
          controls={controls}
          transport={transport}
          onSelect={setSelectedId}
          onControl={updateControl}
        />
        {selected && (
          <ClipInspector
            stem={selected}
            source={source}
            duration={duration}
            transport={transport}
          />
        )}
      </section>
      <section className="remix-panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Non-destructive arrangement</span>
            <h3>Remix timeline</h3>
          </div>
          {!remix ? (
            <button className="button" onClick={() => void createRemix()}>
              Create remix session
            </button>
          ) : (
            <div className="remix-actions">
              <button className="button secondary" disabled={!history.length} onClick={undo}>
                Undo
              </button>
              <button className="button secondary" disabled={!future.length} onClick={redo}>
                Redo
              </button>
              <button className="button secondary" onClick={() => void createVersion()}>
                Save version
              </button>
              <button className="button" onClick={() => void persist(remix)}>
                Save now
              </button>
            </div>
          )}
        </div>
        {remix ? (
          <>
            <ArrangementTimeline remix={remix} duration={duration} onChange={changeRemix} />
            <VersionHistory versions={versions} onRestore={(id) => void restoreVersion(id)} />
          </>
        ) : (
          <p className="notice">
            Create a remix only after genuine separated stems exist. Waveyard
            will create tracks and clips that point to those existing assets.
          </p>
        )}
      </section>
    </section>
  );
}
