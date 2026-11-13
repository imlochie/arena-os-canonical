"use client";

import "./CandidateAlignmentLab.css";

export type CandidateAlignmentId = "continuous" | "paired-grid" | "downbeat" | "phrase-aware";

export type CandidateAlignmentCandidate = {
  id: CandidateAlignmentId;
  title: string;
  available: boolean;
  unavailableReason?: string;
  selected: boolean;
  rendering: boolean;
  renderedUrl?: string;
  entryMs: number | null;
  vocalTempoRatio: number | null;
  pitchShiftSemitones: number | null;
  pairedGridFit?: {
    matchedBeats: number;
    comparedBeats: number;
    meanErrorMs: number;
    toleranceMs: number;
  } | null;
  localRateDeviationPercent?: number | null;
  selectedDonorPassage?: { startMs: number; endMs: number } | null;
  selectedBedPassage?: { startMs: number; endMs: number } | null;
  evidenceNotes: string[];
  limitations: string[];
};

export type CandidateAlignmentLabProps = {
  candidates: CandidateAlignmentCandidate[];
  selectedId: CandidateAlignmentId | null;
  onSelect: (id: CandidateAlignmentId) => void;
  onRender: (id: CandidateAlignmentId) => void;
  onAudioPlay: (id: CandidateAlignmentId) => void;
};

function formatTime(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "Not provided";
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatRatio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Not provided" : `×${value.toFixed(3)}`;
}

function formatSemitones(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not provided";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} st`;
}

function formatPassage(passage: { startMs: number; endMs: number } | null | undefined): string {
  if (!passage) return "Not provided";
  return `${formatTime(passage.startMs)}–${formatTime(passage.endMs)}`;
}

export function CandidateAlignmentLab({
  candidates,
  selectedId,
  onSelect,
  onRender,
  onAudioPlay,
}: CandidateAlignmentLabProps) {
  return (
    <section className="candidate-alignment" aria-labelledby="candidate-alignment-title">
      <header className="candidate-alignment__header">
        <div>
          <span className="candidate-alignment__eyebrow">Arrangement alternatives</span>
          <h2 id="candidate-alignment-title">Compare entry and alignment</h2>
          <p>
            Choose a real arrangement proposal, inspect its measured timing evidence, then render
            and listen. Beat-grid fit describes alignment only, not how a mix will sound.
          </p>
        </div>
        {candidates.length > 0 && (
          <span className="candidate-alignment__count">
            {candidates.length} {candidates.length === 1 ? "candidate" : "candidates"}
          </span>
        )}
      </header>

      {candidates.length === 0 ? (
        <div className="candidate-alignment__empty" role="status">
          <span className="candidate-alignment__empty-mark" aria-hidden="true" />
          <div>
            <h3>No arrangement candidates yet</h3>
            <p>When the planner returns alternatives, they will appear here for direct comparison.</p>
          </div>
        </div>
      ) : (
        <div className="candidate-alignment__list">
          {candidates.map((candidate, index) => {
            const isSelected = candidate.id === selectedId;
            const hasBeatFit = candidate.pairedGridFit != null;
            return (
              <article
                className={`candidate-alignment__candidate${isSelected ? " is-selected" : ""}${!candidate.available ? " is-unavailable" : ""}`}
                key={candidate.id}
                aria-labelledby={`candidate-title-${candidate.id}`}
                data-testid={`candidate-alignment-${candidate.id}`}
              >
                <div className="candidate-alignment__rail" aria-hidden="true">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <i />
                </div>

                <div className="candidate-alignment__body">
                  <div className="candidate-alignment__topline">
                    <div className="candidate-alignment__title-wrap">
                      <button
                        className="candidate-alignment__select"
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`${isSelected ? "Selected" : "Select"} arrangement: ${candidate.title}`}
                        data-testid={`select-candidate-${candidate.id}`}
                        disabled={!candidate.available}
                        onClick={() => onSelect(candidate.id)}
                      >
                        <span className="candidate-alignment__radio" aria-hidden="true">
                          {isSelected && <span />}
                        </span>
                        <span>
                          <span className="candidate-alignment__candidate-name" id={`candidate-title-${candidate.id}`}>
                            {candidate.title}
                          </span>
                          <span className="candidate-alignment__candidate-id">{candidate.id}</span>
                        </span>
                      </button>
                    </div>
                    <div className="candidate-alignment__state">
                      {!candidate.available ? (
                        <span className="candidate-alignment__badge is-unavailable">Unavailable</span>
                      ) : candidate.rendering ? (
                        <span className="candidate-alignment__badge is-rendering" role="status">Rendering</span>
                      ) : isSelected ? (
                        <span className="candidate-alignment__badge is-selected">Selected</span>
                      ) : (
                        <span className="candidate-alignment__badge">Ready</span>
                      )}
                    </div>
                  </div>

                  {!candidate.available && (
                    <p className="candidate-alignment__unavailable" role="status">
                      <b>Why unavailable</b>
                      <span>{candidate.unavailableReason || "The planner did not provide an availability reason."}</span>
                    </p>
                  )}

                  <div className="candidate-alignment__metrics" aria-label={`${candidate.title} timing and transform measurements`}>
                    <div className="candidate-alignment__metric candidate-alignment__metric--entry">
                      <span>Vocal entry</span>
                      <strong>{formatTime(candidate.entryMs)}</strong>
                    </div>
                    <div className="candidate-alignment__metric">
                      <span>Vocal tempo ratio</span>
                      <strong>{formatRatio(candidate.vocalTempoRatio)}</strong>
                    </div>
                    <div className="candidate-alignment__metric">
                      <span>Pitch shift</span>
                      <strong>{formatSemitones(candidate.pitchShiftSemitones)}</strong>
                    </div>
                    <div className="candidate-alignment__metric">
                      <span>Local rate deviation</span>
                      <strong>
                        {candidate.localRateDeviationPercent == null || !Number.isFinite(candidate.localRateDeviationPercent)
                          ? "Not provided"
                          : `${candidate.localRateDeviationPercent > 0 ? "+" : ""}${candidate.localRateDeviationPercent.toFixed(2)}%`}
                      </strong>
                    </div>
                  </div>

                  <section className="candidate-alignment__evidence" aria-label={`${candidate.title} evidence`}>
                    <div className="candidate-alignment__evidence-head">
                      <h3>Timing evidence</h3>
                      <span className={`candidate-alignment__evidence-status${hasBeatFit ? " is-measured" : ""}`}>
                        <i aria-hidden="true" />
                        {hasBeatFit ? "Beat-phase measured" : "No paired beat-phase measurement"}
                      </span>
                    </div>
                    {hasBeatFit ? (
                      <dl className="candidate-alignment__fit">
                        <div>
                          <dt>Beats within tolerance</dt>
                          <dd>{candidate.pairedGridFit!.matchedBeats} / {candidate.pairedGridFit!.comparedBeats}</dd>
                        </div>
                        <div>
                          <dt>Mean phase error</dt>
                          <dd>{candidate.pairedGridFit!.meanErrorMs.toFixed(1)} ms</dd>
                        </div>
                        <div>
                          <dt>Tolerance</dt>
                          <dd>{candidate.pairedGridFit!.toleranceMs} ms</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="candidate-alignment__no-fit">
                        Paired beat-phase evidence was not provided for this arrangement.
                      </p>
                    )}

                    <dl className="candidate-alignment__passages">
                      <div>
                        <dt>Donor passage</dt>
                        <dd>{formatPassage(candidate.selectedDonorPassage)}</dd>
                      </div>
                      <div>
                        <dt>Bed passage</dt>
                        <dd>{formatPassage(candidate.selectedBedPassage)}</dd>
                      </div>
                    </dl>

                    {(candidate.evidenceNotes.length > 0 || candidate.limitations.length > 0) && (
                      <div className="candidate-alignment__notes">
                        {candidate.evidenceNotes.length > 0 && (
                          <div>
                            <h4>Evidence notes</h4>
                            <ul>{candidate.evidenceNotes.map((note, noteIndex) => <li key={`${note}-${noteIndex}`}>{note}</li>)}</ul>
                          </div>
                        )}
                        {candidate.limitations.length > 0 && (
                          <div className="candidate-alignment__limitations">
                            <h4>Unavailable evidence and limitations</h4>
                            <ul>{candidate.limitations.map((limitation, limitationIndex) => <li key={`${limitation}-${limitationIndex}`}>{limitation}</li>)}</ul>
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  <div className="candidate-alignment__actions">
                    <button
                      className="candidate-alignment__render"
                      type="button"
                      disabled={!candidate.available || candidate.rendering}
                      onClick={() => onRender(candidate.id)}
                      data-testid={`render-candidate-${candidate.id}`}
                    >
                      <span className="candidate-alignment__render-icon" aria-hidden="true" />
                      {candidate.rendering ? "Rendering WAV…" : candidate.renderedUrl ? "Render again" : "Render WAV"}
                    </button>
                    {candidate.available && candidate.renderedUrl ? (
                      <div className="candidate-alignment__player">
                        <span className="candidate-alignment__player-label">Rendered WAV</span>
                        <audio
                          controls
                          preload="none"
                          src={candidate.renderedUrl}
                          aria-label={`Play rendered WAV for ${candidate.title}`}
                          onPlay={() => onAudioPlay(candidate.id)}
                          data-testid={`audio-candidate-${candidate.id}`}
                        />
                        <a
                          className="candidate-alignment__download"
                          href={candidate.renderedUrl}
                          download={`waveyard-${candidate.id}-alignment.wav`}
                        >
                          Download WAV
                        </a>
                      </div>
                    ) : (
                      <p className="candidate-alignment__render-state" role={candidate.rendering ? "status" : undefined}>
                        {candidate.rendering
                          ? "The parent renderer is preparing this arrangement."
                          : candidate.available
                            ? "Not rendered yet. Render this proposal to audition its WAV."
                            : "Rendering is disabled while this candidate is unavailable."}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default CandidateAlignmentLab;
