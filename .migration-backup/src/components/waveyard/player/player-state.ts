export type PlayerPhase = "idle" | "loading" | "analysis" | "error" | "playing" | "paused" | "seeking";

/**
 * Presentation-only language for the Player. It observes source/transport
 * state; it never creates or advances a playback clock.
 */
export function derivePlayerPhase(input: {
  hasSource: boolean;
  duration: number;
  playing: boolean;
  seeking?: boolean;
  analysisStatus?: string | null;
  error?: string | null;
}): PlayerPhase {
  if (!input.hasSource) return "idle";
  if (input.error || input.analysisStatus === "failed" || input.analysisStatus === "cancelled") return "error";
  if (!Number.isFinite(input.duration) || input.duration <= 0) return "loading";
  if (["queued", "preparing", "processing", "finalizing"].includes(input.analysisStatus ?? "")) return "analysis";
  if (input.seeking) return "seeking";
  return input.playing ? "playing" : "paused";
}

export function playerPhaseLabel(phase: PlayerPhase) {
  return ({
    idle: "Choose a separated source to begin",
    loading: "Preparing source",
    analysis: "Source analysis in progress",
    error: "Source analysis needs attention",
    playing: "Now playing",
    paused: "Paused",
    seeking: "Seeking",
  })[phase];
}

export function formatPlayerTime(seconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

export function sectionWidths(sections: Array<{ startMs: number; endMs: number }> | undefined, durationSeconds: number) {
  const totalMs = Math.max(0, durationSeconds * 1000);
  if (!totalMs || !sections?.length) return [];
  return sections
    .filter((section) => Number.isFinite(section.startMs) && Number.isFinite(section.endMs) && section.endMs > section.startMs)
    .map((section) => ({
      startPercent: Math.max(0, Math.min(100, section.startMs / totalMs * 100)),
      widthPercent: Math.max(0, Math.min(100, (section.endMs - section.startMs) / totalMs * 100)),
    }));
}
