"use client";

import type { MusicalMeetingPoint } from "@waveyard/types";

export function MeetingPointsPanel({ points, busyId, message, onAccept }: {
  points: MusicalMeetingPoint[];
  busyId: string | null;
  message: string | null;
  onAccept: (point: MusicalMeetingPoint) => void;
}) {
  if (!points.length && !message) return null;
  return <section className="meeting-points-panel" aria-label="Musical meeting points">
    <div className="panel-title"><div><span className="eyebrow">Editing assistant</span><h3>Where this fits</h3></div><span>{points.length} placement{points.length === 1 ? "" : "s"}</span></div>
    {points.length ? <div className="meeting-points-grid">{points.map((point) => <article className={`meeting-point ${point.state}`} key={point.id} data-testid={`meeting-point-${point.id}`}>
      <div className="meeting-point-block"><span>{point.state.toUpperCase()}</span><b>{point.barCount ?? "—"} BARS</b><small>Timeline {Math.round(point.target.timelineStartMs / 1000)}s</small></div>
      <div><h4>{point.sectionAligned ? "Section aligned here" : "Timeline window"}</h4><p>{point.reasons.slice(0, 4).join(" · ")}</p><dl><dt>Tempo</dt><dd>{point.tempoSyncEnabled ? `${point.tempoRatio?.toFixed(4)}× transform` : "Native"}</dd><dt>Key</dt><dd>{point.keyShiftSemitones === null ? "Unavailable" : point.keySyncEnabled ? `${point.keyShiftSemitones >= 0 ? "+" : ""}${point.keyShiftSemitones} semitones` : "Native"}</dd><dt>Phrase</dt><dd>{point.phraseAligned ? "Boundary aligned" : "Not asserted"}</dd></dl><button className="button" disabled={busyId !== null || point.state === "experimental"} onClick={() => onAccept(point)}>{busyId === point.id ? "Adding…" : "Add here"}</button></div>
    </article>)}</div> : <p className="notice">{message}</p>}
    {message && points.length > 0 && <p className="notice" role="status">{message}</p>}
  </section>;
}
