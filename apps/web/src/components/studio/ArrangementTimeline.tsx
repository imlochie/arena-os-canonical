"use client";

import { effectiveMuted } from "@/lib/remix";
import { clock, type Remix } from "./types";

export function ArrangementTimeline({
  remix,
  duration,
  onChange,
}: {
  remix: Remix;
  duration: number;
  onChange: (transform: (current: Remix) => Remix) => void;
}) {
  return (
    <>
      <p className="notice">
        Clips reference existing private stems. Moving, trimming, duplicating,
        and deleting clips changes arrangement metadata only; no audio file is
        copied. The transport above is a real stem inspection/audition path,
        not a rendered timeline mix.
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
                        onChange((current) => ({
                          ...current,
                          tracks: current.tracks.map((candidate) =>
                            candidate.id === track.id
                              ? {
                                  ...candidate,
                                  clips: candidate.clips.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          timelineStartMs: Math.max(0, Number(event.target.value) * 1000),
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
                        onChange((current) => ({
                          ...current,
                          tracks: current.tracks.map((candidate) =>
                            candidate.id === track.id
                              ? {
                                  ...candidate,
                                  clips: candidate.clips.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, durationMs: Math.max(1, Number(event.target.value) * 1000) }
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
                      onChange((current) => ({
                        ...current,
                        tracks: current.tracks.map((candidate) =>
                          candidate.id === track.id
                            ? {
                                ...candidate,
                                clips: candidate.clips.flatMap((item, itemIndex) =>
                                  itemIndex === index
                                    ? [item, { ...item, id: undefined, timelineStartMs: item.timelineStartMs + item.durationMs }]
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
                      onChange((current) => ({
                        ...current,
                        tracks: current.tracks.map((candidate) =>
                          candidate.id === track.id
                            ? { ...candidate, clips: candidate.clips.filter((_, itemIndex) => itemIndex !== index) }
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
    </>
  );
}
