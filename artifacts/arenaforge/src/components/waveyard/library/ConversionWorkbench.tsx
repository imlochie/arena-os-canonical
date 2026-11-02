"use client";

import { useEffect, useRef, useState } from "react";

type TrackOption = {
  id: string;
  title: string;
  artist: string;
  sourceAssetId?: string | null;
};

type FormatOption = {
  id: string;
  extension: string;
  lossy: boolean;
  available: boolean;
};

type ConversionJob = {
  id: string;
  originalTrackId: string;
  format: string;
  bitrate: number;
  status: "queued" | "running" | "complete" | "failed";
  stage: string;
  progress: number;
  attempts: number;
  convertedTrackId: string | null;
  verification: { warnings?: string[] } | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export function ConversionWorkbench({
  tracks,
  onConverted,
}: {
  tracks: TrackOption[];
  onConverted: () => void;
}) {
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState("");
  const [format, setFormat] = useState("flac");
  const [bitrate, setBitrate] = useState(192);
  const [rightsReviewed, setRightsReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ConversionJob[]>([]);
  const knownJobStatuses = useRef(new Map<string, ConversionJob["status"]>());
  const onConvertedRef = useRef(onConverted);
  const refreshJobsRef = useRef<() => void>(() => {});
  onConvertedRef.current = onConverted;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/library/conversions", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Conversion tools are unavailable.");
        if (!Array.isArray(data.formats)) throw new Error("The local conversion service returned an invalid format list.");
        setFormats(data.formats);
        const preferredFormat =
          ["flac", "alac", "wav"]
            .map((id) => data.formats.find((item: FormatOption) => item.id === id && item.available))
            .find(Boolean) ??
          data.formats.find((item: FormatOption) => item.available && !item.lossy) ??
          data.formats.find((item: FormatOption) => item.available);
        if (preferredFormat) setFormat(preferredFormat.id);
        if (typeof data.error === "string") setMessage(data.error);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Local conversion tools could not be checked.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refreshJobs = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch("/api/library/conversions/jobs", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Saved conversions could not be loaded.");
        if (!Array.isArray(data.jobs)) throw new Error("The conversion service returned an invalid job list.");
        const nextJobs = data.jobs as ConversionJob[];
        let completedNewJob = false;
        for (const job of nextJobs) {
          if (job.status === "complete" && knownJobStatuses.current.get(job.id) !== "complete") {
            completedNewJob = true;
          }
          knownJobStatuses.current.set(job.id, job.status);
        }
        setJobs((previous) => {
          const fetchedIds = new Set(nextJobs.map((job) => job.id));
          const recentActive = previous.filter((job) =>
            (job.status === "queued" || job.status === "running") && !fetchedIds.has(job.id),
          );
          return [...recentActive, ...nextJobs];
        });
        if (completedNewJob) onConvertedRef.current();
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Saved conversions could not be loaded.");
        }
      } finally {
        loading = false;
      }
    };
    refreshJobsRef.current = () => void refreshJobs();
    void refreshJobs();
    return () => {
      controller.abort();
      refreshJobsRef.current = () => {};
    };
  }, []);

  const hasActiveJobs = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => refreshJobsRef.current(), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs]);

  const selectedFormat = formats.find((item) => item.id === format);
  const eligibleTracks = tracks.filter((track) => track.sourceAssetId);

  const startConversion = async (trackId: string, selectedFormatId: string, selectedBitrate: number) => {
    if (busy || !rightsReviewed) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/library/conversions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId,
          format: selectedFormatId,
          bitrate: selectedBitrate,
          rightsReviewed: true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `Conversion could not be queued (${response.status}).`);
      const job = data as ConversionJob;
      knownJobStatuses.current.set(job.id, job.status);
      setJobs((previous) => [job, ...previous.filter((item) => item.id !== job.id)]);
      setMessage(job.status === "complete"
        ? "This conversion is already complete and its track is in your library."
        : job.status === "failed"
          ? job.errorMessage ?? "This conversion failed. You can retry it below."
          : "Conversion saved. You can leave this page and return while it runs.");
      if (job.status === "complete") onConvertedRef.current();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Local audio conversion could not be queued.");
    } finally {
      setBusy(false);
    }
  };

  const convert = async () => {
    if (!selectedTrackId || !selectedFormat?.available || !rightsReviewed || busy) return;
    await startConversion(selectedTrackId, format, bitrate);
  };

  return (
    <section className="library-audio-backup" aria-label="Convert local audio">
      <div>
        <strong>Convert a local audio file</strong>
        <p>Creates a separate, verified library copy. The original stays unchanged; use the ZIP backup below to download both.</p>
      </div>
      <div className="library-audio-backup-actions">
        <label>
          Local library track
          <select
            aria-label="Audio file to convert"
            value={selectedTrackId}
            onChange={(event) => setSelectedTrackId(event.target.value)}
            disabled={busy || eligibleTracks.length === 0}
          >
            <option value="">Choose a track</option>
            {eligibleTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.title}{track.artist ? ` — ${track.artist}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Output format
          <select
            aria-label="Converted audio format"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            disabled={busy || formats.length === 0}
          >
            {formats.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.id.toUpperCase()} (.{item.extension}){item.available ? "" : " — unavailable"}
              </option>
            ))}
          </select>
        </label>
        {selectedFormat?.lossy && (
          <label>
            Bitrate
            <select
              aria-label="Conversion bitrate"
              value={bitrate}
              onChange={(event) => setBitrate(Number(event.target.value))}
              disabled={busy}
            >
              {[128, 192, 256, 320].map((value) => <option key={value} value={value}>{value} kb/s</option>)}
            </select>
          </label>
        )}
        <label className="track-backup-choice">
          <input
            type="checkbox"
            checked={rightsReviewed}
            onChange={(event) => setRightsReviewed(event.target.checked)}
            disabled={busy}
          />
          I own or am authorized to copy this audio
        </label>
        <button
          type="button"
          className="button"
          onClick={() => void convert()}
          disabled={busy || !selectedTrackId || !selectedFormat?.available || !rightsReviewed}
        >
          {busy ? "Saving conversion…" : "Convert local track"}
        </button>
      </div>
      <small>Only files uploaded from this device can be converted. Apple Music metadata snapshots contain catalog details only; protected subscription audio is not downloaded, decrypted, or converted.</small>
      {eligibleTracks.length === 0 && <small>Add an audio file to your library first.</small>}
      {jobs.length > 0 && (
        <div className="library-conversion-jobs" aria-label="Saved audio conversions">
          <strong>Saved conversions</strong>
          {jobs.map((job) => (
            <article className="library-conversion-job" key={job.id}>
              <div>
                <strong>{tracks.find((track) => track.id === job.originalTrackId)?.title ?? "Local track"} → {job.format.toUpperCase()}</strong>
                <span>{job.status === "running" ? `In progress · ${job.progress}% · ${job.stage}` : job.status === "queued" ? "Waiting to start" : job.status === "complete" ? "Complete · added to your library" : "Failed"}</span>
              </div>
              {(job.status === "queued" || job.status === "running") && (
                <progress aria-label={`${job.format.toUpperCase()} conversion progress`} max={100} value={job.progress} />
              )}
              {job.status === "failed" && (
                <>
                  <small role="alert">{job.errorMessage ?? "Conversion failed."}</small>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !rightsReviewed}
                    onClick={() => {
                      setSelectedTrackId(job.originalTrackId);
                      setFormat(job.format);
                      setBitrate(job.bitrate);
                      void startConversion(job.originalTrackId, job.format, job.bitrate);
                    }}
                  >
                    Retry conversion
                  </button>
                  {!rightsReviewed && <small>Confirm the authorization checkbox above before retrying.</small>}
                </>
              )}
              {job.status === "complete" && job.verification?.warnings?.map((warning) => (
                <small key={warning}>{warning}</small>
              ))}
            </article>
          ))}
        </div>
      )}
      {message && <p className="library-message" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
