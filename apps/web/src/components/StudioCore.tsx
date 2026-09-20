"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WaveformCanvas } from "./WaveformCanvas";
import {
  effectiveMuted,
  type RemixStateInput,
  type RemixTrackInput,
} from "@/lib/remix";
import { useStemTransport, type MixerValues } from "@/lib/useStemTransport";

type Stem = {
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
type Source = {
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
type PersistedTrack = RemixTrackInput & {
  clips: Array<RemixTrackInput["clips"][number] & { id?: string }>;
};
type Remix = {
  id: string;
  name: string;
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tracks: PersistedTrack[];
};

function clock(seconds: number) {
  const min = Math.floor(Math.max(0, seconds) / 60);
  const sec = Math.floor(Math.max(0, seconds) % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}
function bytes(size: number) {
  return size > 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1_000))} KB`;
}
function controlsFor(stems: Stem[]) {
  return Object.fromEntries(
    stems.map((stem) => [
      stem.id,
      { volume: 1, pan: 0, muted: false, solo: false },
    ]),
  ) as Record<string, MixerValues>;
}
function remixState(remix: Remix): RemixStateInput {
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tracks: remix.tracks,
  };
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
  const [versions, setVersions] = useState<
    Array<{ id: string; name: string; createdAt: string }>
  >([]);
  const [history, setHistory] = useState<Remix[]>([]);
  const [future, setFuture] = useState<Remix[]>([]);
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

  const updateControl = (id: string, patch: Partial<MixerValues>) => {
    setControls((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
    if (remix)
      changeRemix((current) => ({
        ...current,
        tracks: current.tracks.map((track) =>
          track.stemAssetId === id ? { ...track, ...patch } : track,
        ),
      }));
  };

  const loadRemix = useCallback(async (id: string) => {
    const response = await fetch(`/api/remixes/${id}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState("failed");
      return;
    }
    const next: Remix = { ...body.remix, tracks: body.tracks };
    setRemix(next);
    setHistory([]);
    setFuture([]);
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
  }, []);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/remixes`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (active && response.ok && body.remixes?.[0]?.id) {
          await loadRemix(body.remixes[0].id);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [loadRemix, projectId]);

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

  const changeRemix = (transform: (current: Remix) => Remix) => {
    if (!remix) return;
    const next = transform(remix);
    setHistory((entries) => [...entries, remix].slice(-80));
    setFuture([]);
    setRemix(next);
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist(next);
    }, 700);
  };
  const undo = () => {
    if (!remix || !history.length) return;
    const prior = history.at(-1)!;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [remix, ...entries].slice(0, 80));
    setRemix(prior);
    void persist(prior);
  };
  const redo = () => {
    if (!remix || !future.length) return;
    const next = future[0];
    setFuture((entries) => entries.slice(1));
    setHistory((entries) => [...entries, remix].slice(-80));
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

  const anySolo = Object.values(controls).some((track) => track.solo);
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
      <section className="transport-panel" aria-label="Transport controls">
        <div className="transport-actions">
          <button
            className="button"
            data-testid="play-all"
            aria-label={transport.playing ? "Pause" : "Play"}
            onClick={() => {
              if (transport.playing) transport.pause();
              else {
                transport.applyMix(controls);
                void transport.play();
              }
            }}
          >
            {transport.playing ? "Pause" : "Play"}
          </button>
          <button
            className="button secondary"
            aria-label="Stop"
            onClick={transport.stop}
          >
            Stop
          </button>
          <button
            className={`button secondary ${transport.loop.enabled ? "active" : ""}`}
            aria-label="Toggle loop"
            onClick={() =>
              transport.setLoop((current) => ({
                ...current,
                enabled: !current.enabled,
                end: current.end || duration,
              }))
            }
          >
            Loop
          </button>
          <button
            className="button secondary"
            onClick={() =>
              transport.setLoop((current) => ({
                ...current,
                start: transport.position,
                end: current.end || duration,
              }))
            }
          >
            Set loop in
          </button>
          <button
            className="button secondary"
            onClick={() =>
              transport.setLoop((current) => ({
                ...current,
                end: Math.max(current.start + 0.05, transport.position),
              }))
            }
          >
            Set loop out
          </button>
        </div>
        <input
          aria-label="Seek project"
          type="range"
          min="0"
          max={duration || 1}
          value={transport.position}
          step="0.01"
          onChange={(event) => transport.seek(Number(event.target.value))}
        />
        <output>
          {clock(transport.position)} / {clock(duration)}
        </output>
        <label>
          Master{" "}
          <input
            aria-label="Master volume"
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={transport.masterVolume}
            onChange={(event) => {
              const volume = Number(event.target.value);
              transport.setMasterVolume(volume);
              if (remix)
                changeRemix((current) => ({
                  ...current,
                  masterVolume: volume,
                }));
            }}
          />
        </label>
        {transport.error && <p className="error">{transport.error}</p>}
      </section>
      <section className="studio-grid">
        <div className="mixer-panel">
          <div className="panel-title">
            <h3>Stem mixer</h3>
            <span>{anySolo ? "Solo active" : "All unmuted stems audible"}</span>
          </div>
          {stems.map((stem) => {
            const control = controls[stem.id] ?? {
              volume: 1,
              pan: 0,
              muted: false,
              solo: false,
            };
            return (
              <article
                key={stem.id}
                data-testid={`stem-${stem.stemType}`}
                className={`studio-stem ${selected?.id === stem.id ? "selected" : ""}`}
              >
                <button
                  className="stem-select"
                  onClick={() => setSelectedId(stem.id)}
                >
                  <b>{stem.stemType}</b>
                  <small>
                    {clock(stem.durationSeconds)} · {stem.sampleRate} Hz
                  </small>
                </button>
                <WaveformCanvas
                  assetId={stem.id}
                  label={`${stem.stemType} waveform`}
                  compact
                  position={transport.position}
                  duration={duration}
                  onSeek={transport.seek}
                />
                <label>
                  Vol{" "}
                  <input
                    aria-label={`${stem.stemType} volume`}
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={control.volume}
                    onChange={(event) =>
                      updateControl(stem.id, {
                        volume: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Pan{" "}
                  <input
                    aria-label={`${stem.stemType} pan`}
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    value={control.pan}
                    onChange={(event) =>
                      updateControl(stem.id, {
                        pan: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <button
                  className={`toggle ${control.muted ? "on" : ""}`}
                  aria-pressed={control.muted}
                  onClick={() =>
                    updateControl(stem.id, { muted: !control.muted })
                  }
                >
                  M
                </button>
                <button
                  className={`toggle ${control.solo ? "on" : ""}`}
                  aria-pressed={control.solo}
                  onClick={() =>
                    updateControl(stem.id, { solo: !control.solo })
                  }
                >
                  S
                </button>
                <audio
                  ref={(element) => transport.register(stem.id, element)}
                  src={`/api/assets/${stem.id}`}
                  preload="auto"
                />
              </article>
            );
          })}
        </div>
        {selected && (
          <aside className="inspector">
            <span className="eyebrow">Selected stem</span>
            <h3>{selected.stemType}</h3>
            <WaveformCanvas
              assetId={selected.id}
              label={`${selected.stemType} inspector waveform`}
              compact
              position={transport.position}
              duration={duration}
              onSeek={transport.seek}
            />
            <dl>
              <dt>Duration</dt>
              <dd>{clock(selected.durationSeconds)}</dd>
              <dt>Format</dt>
              <dd>
                {selected.format.toUpperCase()} · {selected.codec}
              </dd>
              <dt>Audio</dt>
              <dd>
                {selected.sampleRate} Hz · {selected.channels} ch
              </dd>
              <dt>Size</dt>
              <dd>{bytes(selected.fileSizeBytes)}</dd>
              <dt>Checksum</dt>
              <dd className="checksum">{selected.checksumSha256}</dd>
              <dt>Model</dt>
              <dd>
                {selected.model} · {selected.modelVersion}
              </dd>
            </dl>
            <a
              className="button secondary"
              href={`/api/assets/${selected.id}?download=1`}
            >
              Download stem
            </a>
            {source && (
              <a
                className="download-source"
                href={`/api/assets/${source.id}?download=1`}
              >
                Download original source
              </a>
            )}
          </aside>
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
              <button
                className="button secondary"
                disabled={!history.length}
                onClick={undo}
              >
                Undo
              </button>
              <button
                className="button secondary"
                disabled={!future.length}
                onClick={redo}
              >
                Redo
              </button>
              <button
                className="button secondary"
                onClick={() => void createVersion()}
              >
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
            <p className="notice">
              Clips reference existing private stems. Moving, trimming,
              duplicating, and deleting clips changes arrangement metadata only;
              no audio file is copied. The transport above is a real stem
              inspection/audition path, not a rendered timeline mix.
            </p>
            <div className="timeline-axis">
              0s <span>{clock(duration)}</span>
              <em>seconds grid — BPM has not been detected</em>
            </div>
            <div className="timeline">
              {remix.tracks.map((track) => (
                <div className="timeline-track" key={track.id}>
                  <header>
                    <b>{track.name}</b>
                    <small>
                      {effectiveMuted(
                        { muted: track.muted, solo: track.solo },
                        remix.tracks.some((candidate) => candidate.solo),
                      )
                        ? "Muted by mixer state"
                        : "Audible"}
                    </small>
                  </header>
                  <div className="clip-lane">
                    {track.clips.map((clip, index) => (
                      <article
                        className="clip"
                        key={`${clip.id ?? "new"}-${index}`}
                        style={{
                          left: `${Math.min(92, (clip.timelineStartMs / Math.max(1, duration * 1000)) * 100)}%`,
                          width: `${Math.max(3, Math.min(100, (clip.durationMs / Math.max(1, duration * 1000)) * 100))}%`,
                        }}
                      >
                        <b>{index + 1}</b>
                        <label>
                          Start
                          <input
                            aria-label={`${track.name} clip ${index + 1} start`}
                            type="number"
                            min="0"
                            value={Math.round(clip.timelineStartMs / 1000)}
                            onChange={(event) =>
                              changeRemix((current) => ({
                                ...current,
                                tracks: current.tracks.map((candidate) =>
                                  candidate.id === track.id
                                    ? {
                                        ...candidate,
                                        clips: candidate.clips.map(
                                          (item, itemIndex) =>
                                            itemIndex === index
                                              ? {
                                                  ...item,
                                                  timelineStartMs: Math.max(
                                                    0,
                                                    Number(event.target.value) *
                                                      1000,
                                                  ),
                                                }
                                              : item,
                                        ),
                                      }
                                    : candidate,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label>
                          Length
                          <input
                            aria-label={`${track.name} clip ${index + 1} length`}
                            type="number"
                            min="1"
                            value={Math.round(clip.durationMs / 1000)}
                            onChange={(event) =>
                              changeRemix((current) => ({
                                ...current,
                                tracks: current.tracks.map((candidate) =>
                                  candidate.id === track.id
                                    ? {
                                        ...candidate,
                                        clips: candidate.clips.map(
                                          (item, itemIndex) =>
                                            itemIndex === index
                                              ? {
                                                  ...item,
                                                  durationMs: Math.max(
                                                    1,
                                                    Number(event.target.value) *
                                                      1000,
                                                  ),
                                                }
                                              : item,
                                        ),
                                      }
                                    : candidate,
                                ),
                              }))
                            }
                          />
                        </label>
                        <button
                          onClick={() =>
                            changeRemix((current) => ({
                              ...current,
                              tracks: current.tracks.map((candidate) =>
                                candidate.id === track.id
                                  ? {
                                      ...candidate,
                                      clips: candidate.clips.flatMap(
                                        (item, itemIndex) =>
                                          itemIndex === index
                                            ? [
                                                item,
                                                {
                                                  ...item,
                                                  id: undefined,
                                                  timelineStartMs:
                                                    item.timelineStartMs +
                                                    item.durationMs,
                                                },
                                              ]
                                            : [item],
                                      ),
                                    }
                                  : candidate,
                              ),
                            }))
                          }
                        >
                          Duplicate
                        </button>
                        <button
                          onClick={() =>
                            changeRemix((current) => ({
                              ...current,
                              tracks: current.tracks.map((candidate) =>
                                candidate.id === track.id
                                  ? {
                                      ...candidate,
                                      clips: candidate.clips.filter(
                                        (_, itemIndex) => itemIndex !== index,
                                      ),
                                    }
                                  : candidate,
                              ),
                            }))
                          }
                        >
                          Delete
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {versions.length ? (
              <div className="versions">
                <b>Versions</b>
                {versions.map((version) => (
                  <button
                    key={version.id}
                    className="button secondary"
                    onClick={() => void restoreVersion(version.id)}
                  >
                    {version.name}
                  </button>
                ))}
              </div>
            ) : null}
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
