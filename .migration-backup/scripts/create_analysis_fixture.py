#!/usr/bin/env python3
"""Create a deterministic original fixture for local musical-analysis checks.

It is a 24-second, 120 BPM F-sharp-minor pulse/chord study with three
bar-aligned energy and texture passages. Every sample is synthesized here; it
contains no sampled or copyrighted audio.
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44_100
SECONDS = 24
BPM = 120
OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "analysis-fsharp-minor-120.wav"
OUT.parent.mkdir(parents=True, exist_ok=True)

# F# natural-minor tones, weighted toward the tonic triad so profile matching is
# intentional rather than an accidental property of the separation fixture.
TONES = (
    (185.00, 0.22),  # F#3 tonic
    (220.00, 0.11),  # A3 minor third
    (277.18, 0.13),  # C#4 fifth
    (329.63, 0.07),  # E4
    (246.94, 0.05),  # B3
    (293.66, 0.04),  # D4
    (415.30, 0.04),  # G#4
)
BEAT_SECONDS = 60 / BPM
with wave.open(str(OUT), "w") as stream:
    stream.setnchannels(2)
    stream.setsampwidth(2)
    stream.setframerate(RATE)
    for frame in range(RATE * SECONDS):
        t = frame / RATE
        # 8-second / four-bar passages provide measurable but non-semantic
        # structure for the local detector while keeping the same key and beat.
        passage = min(2, int(t // 8))
        chord_gain = (0.48, 1.00, 0.70)[passage]
        pulse_gain = (0.55, 1.00, 0.78)[passage]
        shimmer_gain = (0.00, 0.12, 0.05)[passage]
        chord = chord_gain * sum(level * math.sin(2 * math.pi * frequency * t) for frequency, level in TONES)
        beat_phase = t % BEAT_SECONDS
        # A short F#-leaning low pulse provides unambiguous beat attacks.
        pulse = pulse_gain * 0.42 * math.exp(-beat_phase * 33) * math.sin(2 * math.pi * 92.5 * t)
        click = (0.09 + shimmer_gain) * math.exp(-beat_phase * 70) * math.sin(2 * math.pi * 1_850 * t)
        left = max(-0.92, min(0.92, chord + pulse + click))
        right = max(-0.92, min(0.92, chord + pulse - click))
        stream.writeframesraw(struct.pack("<hh", int(left * 32767), int(right * 32767)))
print(OUT)
