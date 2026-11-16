"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { findRepeatedLyricPhrases } from "@workspace/arena/lib/waveyard/transcription/lyric-recurrence";
import { buildSrt, buildVtt } from "@workspace/arena/lib/creative/captions";
import type { Source, SourceSection, Stem } from "./types";

const LOCAL_MODEL = "whisper-tiny_timestamped" as const;
const ENGINE_VERSION = "browser-whisper@2.0.0";
const MODEL_BYTES_ESTIMATE = 44_000_000;
const CACHE_VERSION = 1;

type LocalTranscriptSegment = {
  start: number;
  end: number;
  text: string;
  words?: Array<{ text: string; start: number; end: number }>;
};

type LocalTranscriptCache = {
  version: typeof CACHE_VERSION;
  model: typeof LOCAL_MODEL;
  engineVersion: typeof ENGINE_VERSION;
  sourceChecksumSha256: string;
  stemChecksumSha256: string;
  savedAt: string;
  segments: LocalTranscriptSegment[];
};

function cacheKey(source: Source, stem: Stem) {
  return `waveyard:local-vocal-transcript:v1:${ENGINE_VERSION}:${source.checksumSha256}:${stem.checksumSha256}`;
}

function timeLabel(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60_000);
  const wholeSeconds = Math.floor(ms / 1000) % 60;
  const centiseconds = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function safeCachedTranscript(raw: string | null, source: Source, stem: Stem): LocalTranscriptSegment[] {
  if (!raw) return [];
  try {
    const cache = JSON.parse(raw) as Partial<LocalTranscriptCache>;
    if (cache.version !== CACHE_VERSION
      || cache.model !== LOCAL_MODEL
      || cache.engineVersion !== ENGINE_VERSION
      || cache.sourceChecksumSha256 !== source.checksumSha256
      || cache.stemChecksumSha256 !== stem.checksumSha256
      || !Array.isArray(cache.segments)) return [];
    return cache.segments.flatMap((segment) => {
      if (!segment
        || !Number.isFinite(segment.start)
        || !Number.isFinite(segment.end)
        || segment.start < 0
        || segment.end <= segment.start
        || typeof segment.text !== "string"
        || !segment.text.trim()) return [];
      const words = Array.isArray(segment.words)
        ? segment.words.filter((word) => word
          && Number.isFinite(word.start)
          && Number.isFinite(word.end)
          && word.start >= 0
          && word.end > word.start
          && typeof word.text === "string"
          && word.text.trim())
        : undefined;
      return [{ ...segment, words }];
    });
  } catch {
    return [];
  }
}

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function LocalVocalTranscript({
  source,
  stem,
  sections,
}: {
  source: Source;
  stem: Stem | null;
  sections: SourceSection[];
}) {
  const [transcript, setTranscript] = useState<LocalTranscriptSegment[]>([]);
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [clearingModel, setClearingModel] = useState(false);
  const [webGpuAvailable, setWebGpuAvailable] = useState<boolean | null>(null);
  const streamRef = useRef<{ cancel: () => void } | null>(null);
  const engineRef = useRef<{ dispose: () => void } | null>(null);
  const runIdRef = useRef(0);
  const storageKey = useMemo(() => stem ? cacheKey(source, stem) : null, [
    source.checksumSha256,
    stem?.checksumSha256,
  ]);

  useEffect(() => {
    runIdRef.current += 1;
    streamRef.current?.cancel();
    streamRef.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    setRunning(false);
    setError(null);
    setProgress(null);
    try {
      setTranscript(stem && storageKey
        ? safeCachedTranscript(window.localStorage.getItem(storageKey), source, stem)
        : []);
    } catch {
      setTranscript([]);
    }
  }, [source.checksumSha256, stem?.checksumSha256, storageKey]);

  useEffect(() => () => {
    runIdRef.current += 1;
    streamRef.current?.cancel();
    engineRef.current?.dispose();
  }, []);

  useEffect(() => {
    let current = true;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown | null> } }).gpu;
    if (!gpu) {
      setWebGpuAvailable(false);
      return () => { current = false; };
    }
    void gpu.requestAdapter().then((adapter) => {
      if (current) setWebGpuAvailable(Boolean(adapter));
    }).catch(() => {
      if (current) setWebGpuAvailable(false);
    });
    return () => { current = false; };
  }, []);

  const repeatedPhrases = useMemo(() => findRepeatedLyricPhrases(transcript), [transcript]);
  const transcribe = async () => {
    if (!stem || running) return;
    const runId = ++runIdRef.current;
    setRunning(true);
    setError(null);
    setProgress({ stage: "Loading the local model", fraction: 0 });
    streamRef.current = null;
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(stem.id)}`);
      if (!response.ok) throw new Error(`Could not load the current vocal stem (HTTP ${response.status}).`);
      if (response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("The asset route returned a sign-in or error page instead of the vocal stem.");
      }
      const audio = await response.blob();
      if (!audio.size) throw new Error("The vocal stem is empty.");
      const file = new File([audio], `vocals-${source.checksumSha256.slice(0, 12)}.wav`, {
        type: stem.format.toLowerCase().includes("wav") ? "audio/wav" : "application/octet-stream",
      });
      const { BrowserWhisper } = await import("browser-whisper");
      const engine = new BrowserWhisper({
        model: LOCAL_MODEL,
        quantization: "q8",
      });
      if (runId !== runIdRef.current) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      const stream = engine.transcribe(file, {
        onProgress: (event) => {
          if (runId === runIdRef.current) setProgress({ stage: event.stage, fraction: event.progress });
        },
      });
      streamRef.current = stream;
      const segments = await stream.collect();
      if (runId !== runIdRef.current) return;
      engine.dispose();
      engineRef.current = null;
      streamRef.current = null;
      const validSegments = segments.filter((segment) =>
        Number.isFinite(segment.start) && Number.isFinite(segment.end)
        && segment.start >= 0 && segment.end > segment.start
        && segment.text.trim(),
      );
      if (!validSegments.length) throw new Error("The local model returned no timestamped words. Check whether the vocal stem contains audible lyrics.");
      const cache: LocalTranscriptCache = {
        version: CACHE_VERSION,
        model: LOCAL_MODEL,
        engineVersion: ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
        stemChecksumSha256: stem.checksumSha256,
        savedAt: new Date().toISOString(),
        segments: validSegments,
      };
      try {
        window.localStorage.setItem(cacheKey(source, stem), JSON.stringify(cache));
      } catch {
        // A completed transcript remains usable in memory even when browser
        // storage is full or unavailable. Never upload it as a fallback.
      }
      setTranscript(validSegments);
      setProgress({ stage: "Done", fraction: 1 });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (runId !== runIdRef.current) return;
      setError(message.includes("cross-origin isolated")
        ? "This browser blocks the local model’s threaded runtime. Try the desktop app or a browser with local WebGPU support."
        : `Local transcription failed: ${message}`);
      setProgress(null);
    } finally {
      if (runId === runIdRef.current) {
        streamRef.current = null;
        engineRef.current?.dispose();
        engineRef.current = null;
        setRunning(false);
      }
    }
  };

  const cancel = () => {
    runIdRef.current += 1;
    streamRef.current?.cancel();
    streamRef.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    setRunning(false);
    setProgress(null);
  };

  const clearTranscript = () => {
    let message: string | null = null;
    try {
      if (storageKey) window.localStorage.removeItem(storageKey);
    } catch {
      message = "Transcript cleared for this page, but browser storage prevented deleting its saved copy.";
    }
    setTranscript([]);
    setError(message);
  };

  const clearModel = async () => {
    setClearingModel(true);
    setError(null);
    try {
      const { BrowserWhisper } = await import("browser-whisper");
      await BrowserWhisper.deleteModel(LOCAL_MODEL);
      setError("The cached local speech model was removed. Your transcript was kept.");
    } catch (caught) {
      setError(`Could not clear the local model cache: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setClearingModel(false);
    }
  };

  const sectionLabelAt = (seconds: number) => {
    const section = sections.find((candidate) => {
      const timeMs = seconds * 1000;
      return candidate.startMs <= timeMs && timeMs < candidate.endMs;
    });
    return section ? `section ${section.sectionIndex + 1}` : "between detected sections";
  };

  return <section className="local-vocal-transcript" aria-label="Local vocal transcript" data-testid={`local-vocal-transcript-${source.id}`}>
    <div className="local-vocal-transcript-heading">
      <div><span className="eyebrow">On-device evidence</span><h4>Timestamped vocal transcript</h4></div>
      <span>{transcript.length ? `${transcript.length} cues` : "local model"}</span>
    </div>
    <p>Runs on this device against the separated vocal stem. First use downloads about {Math.round(MODEL_BYTES_ESTIMATE / 1_000_000)} MB of Q8 model files from Hugging Face; the audio is not sent to an external speech service. The draft and timestamps stay in this browser. Singing can be misheard, so check lyrics before relying on them.</p>
    {!stem ? <p className="notice">Separate the vocals first; transcription never falls back to the full mix.</p> : <>
      <div className="local-vocal-transcript-actions">
        {!running
          ? <button type="button" className="button" data-testid="button-transcribe-vocals-locally" disabled={webGpuAvailable !== true} onClick={() => void transcribe()}>{transcript.length ? "Transcribe again" : "Transcribe locally"}</button>
          : <button type="button" className="button secondary" data-testid="button-cancel-local-transcription" onClick={cancel}>Cancel</button>}
        {transcript.length > 0 && <>
          <button type="button" className="button secondary" data-testid="button-download-vocal-transcript-srt" onClick={() => downloadText("waveyard-vocals.srt", buildSrt(transcript), "application/x-subrip;charset=utf-8")}>Download SRT</button>
          <button type="button" className="button secondary" data-testid="button-download-vocal-transcript-vtt" onClick={() => downloadText("waveyard-vocals.vtt", buildVtt(transcript), "text/vtt;charset=utf-8")}>Download VTT</button>
          <button type="button" className="button secondary" data-testid="button-clear-local-vocal-transcript" onClick={clearTranscript}>Clear transcript</button>
        </>}
        <button type="button" className="button subtle" data-testid="button-remove-local-speech-model" disabled={clearingModel || running} onClick={() => void clearModel()}>{clearingModel ? "Clearing…" : "Remove speech model"}</button>
      </div>
      {webGpuAvailable === false && <p className="notice" role="status" data-testid="status-local-asr-acceleration">This device does not expose WebGPU here. We tested the CPU fallback: even a 20-second vocal excerpt did not finish in three minutes, so full-song transcription is blocked rather than leaving the page stuck. Use a WebGPU-enabled local browser/device; this check has not started a transcription.</p>}
      {webGpuAvailable === null && <p className="local-vocal-transcript-progress" role="status">Checking local acceleration…</p>}
      {progress && <p className="local-vocal-transcript-progress" role="status" data-testid="status-local-transcription-progress">{progress.stage} · {Math.round(progress.fraction * 100)}%</p>}
      {error && <p className="notice" role="status" data-testid="status-local-transcription-message">{error}</p>}
      {repeatedPhrases.length > 0 && <div className="local-lyric-recurrence" aria-label="Repeated lyric evidence">
        <strong>Repeated lyric evidence</strong>
        <p>These lines recur in the draft. They are unreviewed hook candidates, shown against the current section map; they do not assign or change section labels.</p>
        <ol data-testid="list-repeated-lyric-evidence">{repeatedPhrases.map((phrase, index) => <li key={`${phrase.text}:${phrase.occurrences[0]?.start}`} data-testid={`item-repeated-lyric-${index}`}>
          <b>“{phrase.text}”</b>
          <span>{phrase.occurrences.map((occurrence) => `${timeLabel(occurrence.start)} (${sectionLabelAt(occurrence.start)})`).join(" · ")}</span>
          {phrase.timingResolution === "segment" && <small>Coarse phrase timing from transcript segments</small>}
        </li>)}</ol>
      </div>}
      {transcript.length > 0 && <details className="local-transcript-cues">
        <summary data-testid="toggle-review-local-transcript">Review all {transcript.length} timestamped cues</summary>
        <ol>{transcript.map((segment, index) => <li key={`${segment.start}-${index}`}>
          <time>{timeLabel(segment.start)}–{timeLabel(segment.end)}</time><span>{segment.text}</span>
        </li>)}</ol>
      </details>}
    </>}
  </section>;
}
