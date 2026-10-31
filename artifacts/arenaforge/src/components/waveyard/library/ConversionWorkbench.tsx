"use client";

import { useEffect, useState } from "react";

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

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/library/conversions", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Conversion tools are unavailable.");
        if (!Array.isArray(data.formats)) throw new Error("The local conversion service returned an invalid format list.");
        setFormats(data.formats);
        const preferredFormat =
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

  const selectedFormat = formats.find((item) => item.id === format);
  const eligibleTracks = tracks.filter((track) => track.sourceAssetId);

  const convert = async () => {
    if (!selectedTrackId || !selectedFormat?.available || !rightsReviewed || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/library/conversions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId: selectedTrackId,
          format,
          bitrate,
          rightsReviewed: true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `Conversion failed (${response.status}).`);
      const warnings = Array.isArray(data.verification?.warnings) ? data.verification.warnings : [];
      const warningText = warnings.length ? ` ${warnings.join(" ")}` : "";
      setMessage(`${data.track?.title ?? "Converted audio"} was added to your library as ${String(format).toUpperCase()}.${warningText} Use “Back up local audio” to include it in a ZIP.`);
      onConverted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Local audio conversion failed.");
    } finally {
      setBusy(false);
    }
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
          {busy ? "Converting and verifying…" : "Convert local track"}
        </button>
      </div>
      <small>Only files uploaded from this device can be converted. Apple Music metadata snapshots contain catalog details only; protected subscription audio is not downloaded, decrypted, or converted.</small>
      {eligibleTracks.length === 0 && <small>Add an audio file to your library first.</small>}
      {message && <p className="library-message" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
