#!/usr/bin/env python3
"""Deterministic local BPM, beat-grid, and key analysis for Waveyard sources.

The engine intentionally uses only ffmpeg decoding and pinned NumPy. It does not
call a network API or mutate audio. BPM comes from spectral-flux autocorrelation;
key uses a summed chroma vector against Krumhansl-Schmuckler major/minor profiles.

Confidence is evidence, not a model probability:
* BPM confidence = 65% separation of the strongest autocorrelation lag from its
  runner-up + 35% regularity of the fitted beat intervals.
* Key confidence = separation between the strongest and second profile scores.
* Beat confidence = 55% BPM confidence + 45% beat-interval regularity.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

ENGINE = "waveyard-numpy-dsp"
ENGINE_VERSION = "1.0.0"
SAMPLE_RATE = 22_050
FRAME_SIZE = 2_048
HOP_SIZE = 512
# Beat autocorrelation has octave ambiguity; this conventional musical range
# normalizes half-time/double-time candidates into one reproducible result.
MIN_BPM = 80.0
MAX_BPM = 180.0
PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
EPSILON = 1e-9


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def confidence_from_scores(best: float, runner_up: float, regularity: float = 1.0) -> float:
    """The documented score-separation/regularity confidence heuristic."""
    separation = clamp((best - runner_up) / max(abs(best), EPSILON))
    return clamp(0.65 * separation + 0.35 * clamp(regularity))


def decode_mono(source: Path) -> np.ndarray:
    command = [
        "ffmpeg", "-v", "error", "-i", str(source), "-vn", "-ac", "1",
        "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode source: {completed.stderr.decode(errors='replace')[-1200:]}")
    samples = np.frombuffer(completed.stdout, dtype="<f4").astype(np.float64)
    if samples.size < SAMPLE_RATE:
        raise RuntimeError("Source is shorter than one second; musical analysis is unavailable.")
    if not np.isfinite(samples).all():
        raise RuntimeError("Decoded source contains non-finite samples.")
    return samples


def frames_for(samples: np.ndarray) -> np.ndarray:
    if samples.size < FRAME_SIZE:
        samples = np.pad(samples, (0, FRAME_SIZE - samples.size))
    remainder = (samples.size - FRAME_SIZE) % HOP_SIZE
    if remainder:
        samples = np.pad(samples, (0, HOP_SIZE - remainder))
    count = 1 + (samples.size - FRAME_SIZE) // HOP_SIZE
    frames = np.lib.stride_tricks.as_strided(
        samples,
        shape=(count, FRAME_SIZE),
        strides=(samples.strides[0] * HOP_SIZE, samples.strides[0]),
        writeable=False,
    )
    return frames * np.hanning(FRAME_SIZE)


def spectral_flux(spectra: np.ndarray) -> np.ndarray:
    magnitude = np.abs(spectra)
    change = np.maximum(magnitude[1:] - magnitude[:-1], 0.0)
    flux = np.concatenate(([np.linalg.norm(magnitude[0])], np.linalg.norm(change, axis=1)))
    # Remove slow spectral-energy changes while retaining attacks.
    baseline = np.convolve(flux, np.ones(17) / 17.0, mode="same")
    novelty = np.maximum(flux - baseline, 0.0)
    maximum = float(np.max(novelty))
    return novelty / maximum if maximum > EPSILON else novelty


def beat_regularity(grid_ms: list[int]) -> float:
    if len(grid_ms) < 3:
        return 0.0
    intervals = np.diff(np.array(grid_ms, dtype=np.float64))
    mean = float(np.mean(intervals))
    if mean <= EPSILON:
        return 0.0
    # 0 variance yields 1; a 25% coefficient of variation reaches 0.
    return clamp(1.0 - 4.0 * float(np.std(intervals)) / mean)


def find_bpm_and_grid(onset: np.ndarray) -> tuple[float | None, float | None, list[int] | None, float | None]:
    onset_rate = SAMPLE_RATE / HOP_SIZE
    min_lag = max(1, int(math.floor(onset_rate * 60.0 / MAX_BPM)))
    max_lag = max(min_lag + 1, int(math.ceil(onset_rate * 60.0 / MIN_BPM)))
    if onset.size <= max_lag or float(np.max(onset)) <= EPSILON:
        return None, None, None, None

    candidates: list[tuple[int, float]] = []
    for lag in range(min_lag, max_lag + 1):
        left = onset[:-lag]
        right = onset[lag:]
        denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
        score = float(np.dot(left, right) / denominator) if denominator > EPSILON else 0.0
        candidates.append((lag, score))
    candidates.sort(key=lambda item: (-item[1], item[0]))
    lag, best = candidates[0]
    runner = candidates[1][1] if len(candidates) > 1 else 0.0
    period_frames = onset_rate * 60.0 / (onset_rate * 60.0 / lag)
    bpm = onset_rate * 60.0 / period_frames

    # Select a grid phase by interpolating onset evidence at each candidate beat.
    phase_steps = max(8, int(round(period_frames * 8)))
    best_phase = 0.0
    best_phase_score = -1.0
    frame_axis = np.arange(onset.size, dtype=np.float64)
    for phase in np.linspace(0.0, period_frames, phase_steps, endpoint=False):
        positions = np.arange(phase, onset.size, period_frames)
        score = float(np.sum(np.interp(positions, frame_axis, onset)))
        if score > best_phase_score:
            best_phase_score = score
            best_phase = float(phase)

    # Snap each predicted beat to the strongest nearby novelty peak. This keeps
    # real onset timing, rather than serializing only a tempo-derived grid.
    search = max(1, int(round(period_frames * 0.16)))
    grid_frames: list[int] = []
    for expected in np.arange(best_phase, onset.size, period_frames):
        center = int(round(expected))
        lower, upper = max(0, center - search), min(onset.size, center + search + 1)
        if lower >= upper:
            continue
        candidate = lower + int(np.argmax(onset[lower:upper]))
        if grid_frames and candidate <= grid_frames[-1]:
            continue
        grid_frames.append(candidate)
    grid_ms = [int(round(frame * HOP_SIZE * 1000.0 / SAMPLE_RATE)) for frame in grid_frames]
    if len(grid_ms) < 2:
        return None, None, None, None
    # Use fitted beat positions for the final BPM so the stored tempo agrees
    # with the persisted timing sequence rather than an internal frame lag.
    interval_ms = float(np.median(np.diff(np.array(grid_ms, dtype=np.float64))))
    if interval_ms <= EPSILON:
        return None, None, None, None
    bpm = 60_000.0 / interval_ms
    while bpm < MIN_BPM:
        bpm *= 2.0
    while bpm > MAX_BPM:
        bpm /= 2.0
    regularity = beat_regularity(grid_ms)
    bpm_confidence = confidence_from_scores(best, runner, regularity)
    beat_confidence = clamp(0.55 * bpm_confidence + 0.45 * regularity)
    return round(bpm, 3), round(bpm_confidence, 6), grid_ms, round(beat_confidence, 6)


def find_key(spectra: np.ndarray) -> tuple[str | None, float | None]:
    frequencies = np.fft.rfftfreq(FRAME_SIZE, 1.0 / SAMPLE_RATE)
    valid = (frequencies >= 55.0) & (frequencies <= 5_000.0)
    if not np.any(valid):
        return None, None
    # Sum linear magnitudes so the fixture's stable tonal peaks retain their
    # chroma identity while still using deterministic source evidence.
    weights = np.sum(np.abs(spectra[:, valid]), axis=0)
    midi = np.rint(69.0 + 12.0 * np.log2(frequencies[valid] / 440.0)).astype(int)
    chroma = np.zeros(12, dtype=np.float64)
    np.add.at(chroma, np.mod(midi, 12), weights)
    if float(np.linalg.norm(chroma)) <= EPSILON:
        return None, None
    chroma /= np.linalg.norm(chroma)

    candidates: list[tuple[str, float]] = []
    for tonic in range(12):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            candidate = np.roll(profile, tonic)
            candidate = candidate / np.linalg.norm(candidate)
            candidates.append((f"{PITCH_CLASSES[tonic]} {mode}", float(np.dot(chroma, candidate))))
    candidates.sort(key=lambda item: (-item[1], item[0]))
    key, best = candidates[0]
    runner = candidates[1][1] if len(candidates) > 1 else 0.0
    if best <= 0.0:
        return None, None
    return key, round(clamp((best - runner) / max(abs(best), EPSILON)), 6)


def _bar_feature_vectors(samples: np.ndarray, spectra: np.ndarray, onset: np.ndarray, beat_grid_ms: list[int]) -> tuple[list[int], np.ndarray]:
    """Return 4/4 beat-boundary indices and cheap deterministic bar evidence.

    This is intentionally a conservative structural detector, not a semantic
    classifier. Energy, spectrum, attack density, and chroma each contribute
    one locally computed feature family; it never uploads source audio.
    """
    final_index = len(beat_grid_ms) - 1
    boundaries = list(range(0, final_index, 4))
    if not boundaries or boundaries[-1] != final_index:
        boundaries.append(final_index)
    if len(boundaries) < 5:  # fewer than four usable bars is not evidence
        return boundaries, np.empty((0, 0), dtype=np.float64)
    frame_ms = np.arange(spectra.shape[0], dtype=np.float64) * HOP_SIZE * 1000.0 / SAMPLE_RATE
    magnitudes = np.abs(spectra)
    frequencies = np.fft.rfftfreq(FRAME_SIZE, 1.0 / SAMPLE_RATE)
    bands = (
        (frequencies >= 40.0) & (frequencies < 250.0),
        (frequencies >= 250.0) & (frequencies < 2_000.0),
        (frequencies >= 2_000.0) & (frequencies <= 8_000.0),
    )
    chroma_mask = (frequencies >= 55.0) & (frequencies <= 5_000.0)
    chroma_midi = np.rint(69.0 + 12.0 * np.log2(frequencies[chroma_mask] / 440.0)).astype(int)
    features: list[np.ndarray] = []
    for start_index, end_index in zip(boundaries[:-1], boundaries[1:]):
        start_ms, end_ms = beat_grid_ms[start_index], beat_grid_ms[end_index]
        selected = (frame_ms >= start_ms) & (frame_ms < end_ms)
        if not np.any(selected):
            continue
        magnitude = magnitudes[selected]
        # RMS/energy is derived directly from the same source frames, with a
        # log scale so a conservative level change does not dominate all data.
        energy = float(np.sqrt(np.mean(np.square(magnitude))))
        band_energy = np.array([float(np.mean(magnitude[:, band])) if np.any(band) else 0.0 for band in bands])
        band_energy /= max(float(np.sum(band_energy)), EPSILON)
        selected_onset = onset[selected]
        onset_activity = float(np.mean(selected_onset))
        chroma = np.zeros(12, dtype=np.float64)
        np.add.at(chroma, np.mod(chroma_midi, 12), np.sum(magnitude[:, chroma_mask], axis=0))
        chroma /= max(float(np.linalg.norm(chroma)), EPSILON)
        features.append(np.concatenate(([math.log1p(energy * 30.0)], band_energy, [onset_activity], chroma)))
    return boundaries, np.vstack(features) if len(features) == len(boundaries) - 1 else np.empty((0, 0), dtype=np.float64)


def detect_sections(samples: np.ndarray, spectra: np.ndarray, onset: np.ndarray, beat_grid_ms: list[int] | None) -> dict[str, object]:
    """Find measurable, bar-aligned structural changes without semantic claims."""
    if not beat_grid_ms or len(beat_grid_ms) < 17:
        return {"sections": [], "unavailableReason": "insufficient_beat_grid"}
    boundaries, features = _bar_feature_vectors(samples, spectra, onset, beat_grid_ms)
    if features.size == 0 or features.shape[0] < 4:
        return {"sections": [], "unavailableReason": "insufficient_bars"}
    # Per-feature standardization makes the evidence explainable and prevents
    # chroma's vector dimensionality from silently outweighing energy changes.
    deviation = np.std(features, axis=0)
    normalized = (features - np.mean(features, axis=0)) / np.where(deviation > EPSILON, deviation, 1.0)
    novelty = np.linalg.norm(normalized[1:] - normalized[:-1], axis=1) / math.sqrt(normalized.shape[1])
    if novelty.size == 0 or float(np.max(novelty)) <= EPSILON:
        return {"sections": [], "unavailableReason": "structural_evidence_weak"}
    median = float(np.median(novelty))
    spread = float(np.std(novelty))
    threshold = median + max(0.12, 0.35 * spread)
    ranked = sorted(
        ((index + 1, float(score)) for index, score in enumerate(novelty) if score >= threshold),
        key=lambda item: (-item[1], item[0]),
    )
    # A section must span at least two complete bars. Picking strongest evidence
    # first suppresses duplicate boundary clusters deterministically.
    selected_bars: list[tuple[int, float]] = []
    for bar_index, score in ranked:
        if bar_index < 2 or len(boundaries) - 1 - bar_index < 2:
            continue
        if all(abs(bar_index - selected) >= 2 for selected, _ in selected_bars):
            selected_bars.append((bar_index, score))
    if not selected_bars:
        return {"sections": [], "unavailableReason": "structural_evidence_weak"}
    selected_bars.sort(key=lambda item: item[0])
    edge_bars = [0] + [bar for bar, _ in selected_bars] + [len(boundaries) - 1]
    score_by_bar = dict(selected_bars)
    maximum = max(score_by_bar.values())
    sections = []
    for start_bar, end_bar in zip(edge_bars[:-1], edge_bars[1:]):
        supporting = score_by_bar.get(end_bar, score_by_bar.get(start_bar, maximum))
        sections.append({
            "startBeatIndex": int(boundaries[start_bar]),
            "endBeatIndex": int(boundaries[end_bar]),
            "label": "section",
            "labelConfidence": 0.0,
            "structuralConfidence": round(clamp(supporting / max(maximum, EPSILON)), 6),
        })
    return {"sections": sections, "unavailableReason": None}


def analyze_sections(source: Path, beat_grid_ms: list[int]) -> dict[str, object]:
    samples = decode_mono(source)
    spectra = np.fft.rfft(frames_for(samples), axis=1)
    onset = spectral_flux(spectra)
    result = detect_sections(samples, spectra, onset, beat_grid_ms)
    return {
        "analysisEngine": "waveyard-numpy-structure",
        "analysisEngineVersion": "1.0.0",
        **result,
    }


def analyze(source: Path) -> dict[str, object]:
    samples = decode_mono(source)
    spectra = np.fft.rfft(frames_for(samples), axis=1)
    onset = spectral_flux(spectra)
    bpm, bpm_confidence, beat_grid_ms, beat_confidence = find_bpm_and_grid(onset)
    # Framing pads the final FFT window; never serialize a beat beyond actual
    # decoded source duration just because that padding contains onset energy.
    if beat_grid_ms:
        beat_grid_ms = [
            position
            for position in beat_grid_ms
            if position <= int(round(samples.size * 1000.0 / SAMPLE_RATE))
        ]
        if len(beat_grid_ms) < 2:
            bpm, bpm_confidence, beat_grid_ms, beat_confidence = None, None, None, None
    musical_key, key_confidence = find_key(spectra)
    return {
        "analysisEngine": ENGINE,
        "analysisEngineVersion": ENGINE_VERSION,
        "bpm": bpm,
        "bpmConfidence": bpm_confidence,
        "musicalKey": musical_key,
        "keyConfidence": key_confidence,
        "beatGridMs": beat_grid_ms,
        "beatConfidence": beat_confidence,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--sections", action="store_true", help="detect structure from a persisted beat grid")
    parser.add_argument("--beat-grid", help="JSON array of persisted source beat milliseconds")
    args = parser.parse_args()
    source = Path(args.input).resolve()
    if not source.is_file():
        raise RuntimeError(f"Input does not exist: {source}")
    if args.sections:
        try:
            beat_grid = json.loads(args.beat_grid or "null")
        except json.JSONDecodeError as error:
            raise RuntimeError("Persisted beat grid is not valid JSON.") from error
        if not isinstance(beat_grid, list) or any(not isinstance(value, int) or value < 0 for value in beat_grid):
            raise RuntimeError("Persisted beat grid is unavailable or invalid.")
        print(json.dumps(analyze_sections(source, beat_grid), sort_keys=True))
    else:
        print(json.dumps(analyze(source), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
