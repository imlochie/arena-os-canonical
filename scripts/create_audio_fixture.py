#!/usr/bin/env python3
"""Generate a deterministic, original 20-second stereo WAV test fixture."""
import math
import struct
import wave
from pathlib import Path

RATE = 44100
SECONDS = 20
OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "copyright-safe-fixture.wav"
OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), "w") as stream:
    stream.setnchannels(2); stream.setsampwidth(2); stream.setframerate(RATE)
    for frame in range(RATE * SECONDS):
        t = frame / RATE
        # Original harmonic pad + pulse + low oscillation. No sampled/copyrighted audio.
        pad = 0.20 * math.sin(2 * math.pi * 220 * t) + 0.10 * math.sin(2 * math.pi * 330 * t) + 0.06 * math.sin(2 * math.pi * 440 * t)
        pulse = (0.16 * math.sin(2 * math.pi * 70 * t)) if (t % 0.5) < 0.12 else 0
        shimmer = 0.06 * math.sin(2 * math.pi * (660 + 40 * math.sin(2 * math.pi * .15 * t)) * t)
        left = max(-.92, min(.92, pad + pulse + shimmer))
        right = max(-.92, min(.92, pad + pulse - shimmer))
        stream.writeframesraw(struct.pack("<hh", int(left * 32767), int(right * 32767)))
print(OUT)
