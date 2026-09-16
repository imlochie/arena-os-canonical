// Cut Lab — exporter.
//
// Exports the timeline to a video file entirely in-browser:
//   canvas.captureStream(30)  → video track (the same renderer the preview uses)
//   Web Audio graph           → mixed audio track from the clips' <video> elements
//   MediaRecorder             → webm (vp9/vp8) with mp4 fallback (Safari)
//
// This is a real-time capture (a 20s timeline takes ~20s) with zero
// dependencies — the local-first v1 path. When frame-accurate/faster-than-
// realtime export is needed, MediaBunny (WebCodecs, MIT) is the upgrade:
// https://github.com/Vanilagy/mediabunny — see REFERENCES.md.

export interface ExportClipAudioNode {
  el: HTMLVideoElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export interface ExportHandle {
  promise: Promise<{ blob: Blob; mime: string }>;
  cancel: () => void;
}

export function pickExportMime(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* keep trying */
    }
  }
  return "video/webm";
}

export interface ExporterArgs {
  canvas: HTMLCanvasElement;
  duration: number; // timeline duration (s)
  fps?: number;
  videoBitrate?: number;
  // (absolute timeline time, delta seconds since last tick) → draw the frame now
  onFrame: (time: number) => void;
  // audio elements to mix (created per unique video source)
  audioElements?: HTMLVideoElement[];
  volumes?: Map<HTMLVideoElement, number>;
  onProgress?: (ratio: number) => void;
}

export function exportTimeline(args: ExporterArgs): ExportHandle {
  const { canvas, duration, onFrame, audioElements = [], volumes } = args;
  const fps = args.fps ?? 30;
  const mime = pickExportMime();

  if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
    return {
      promise: Promise.reject(new Error("This browser cannot record canvas video (MediaRecorder missing)")),
      cancel: () => {},
    };
  }

  let cancelled = false;
  let raf = 0;

  const promise = new Promise<{ blob: Blob; mime: string }>((resolve, reject) => {
    // ---- audio graph (mixed clip audio) ----
    let audioCtx: AudioContext | null = null;
    let streamDest: MediaStreamAudioDestinationNode | null = null;
    const createdSources: MediaElementAudioSourceNode[] = [];
    if (audioElements.length) {
      try {
        audioCtx = new AudioContext();
        streamDest = audioCtx.createMediaStreamDestination();
        for (const el of audioElements) {
          const src = audioCtx.createMediaElementSource(el);
          const gain = audioCtx.createGain();
          gain.gain.value = volumes?.get(el) ?? 1;
          src.connect(gain).connect(streamDest);
          createdSources.push(src);
        }
      } catch {
        audioCtx = null;
        streamDest = null;
      }
    }

    const stream = canvas.captureStream(fps);
    if (streamDest && audioCtx) {
      for (const track of streamDest.stream.getAudioTracks()) stream.addTrack(track);
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: args.videoBitrate ?? 6_000_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      // disconnect the audio graph so elements play normally afterwards
      for (const s of createdSources) {
        try {
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
      void audioCtx?.close().catch(() => {});
      if (cancelled) return reject(new Error("export cancelled"));
      resolve({ blob: new Blob(chunks, { type: mime }), mime });
    };
    recorder.onerror = () => {
      cancelled = true;
      recorder.stop();
    };

    const startWall = performance.now();
    const tick = () => {
      if (cancelled) {
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      const t = (performance.now() - startWall) / 1000;
      const clamped = Math.min(t, duration);
      onFrame(clamped);
      args.onProgress?.(Math.min(1, t / Math.max(duration, 0.001)));
      if (t >= duration) {
        // let the last frames flush, then stop
        setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, 350);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    recorder.start(250);
    void audioCtx?.resume().catch(() => {});
    raf = requestAnimationFrame(tick);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
}

export function downloadBlob(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}
