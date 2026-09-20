# Audio Pipeline

## Ingest

The upload API accepts WAV, MP3, FLAC, M4A, AAC, and OGG only after safe server-side inspection. It sanitizes the original filename, writes to a randomly generated private object key, and runs FFprobe against a temporary local file. The recorded metadata includes container/codec, duration, sample rate, channels, bitrate, size and SHA-256 checksum.

An unsupported, undecodable, zero-duration, over-limit, or otherwise invalid file is rejected; no source asset or processing job is marked complete.

## Separation

The worker:

1. claims the durable BullMQ job;
2. transitions its database row to `PREPARING`;
3. creates a unique temporary directory;
4. retrieves the authorized source object;
5. invokes the real Demucs adapter with the configured model/device;
6. expects model-produced `vocals.wav`, `drums.wav`, `bass.wav`, and `other.wav`;
7. validates each output using FFprobe and non-zero-signal analysis;
8. stores outputs through `StorageProvider` under private non-guessable keys;
9. creates stem records in one database transaction; and
10. removes temporary files whether successful, failed, or cancelled.

A process exit status alone is not success. Missing/undecodable/silent output fails the job with a safe user-facing reason and preserves diagnostic metadata for operators.

## Device policy

- `auto`: use CUDA only if `torch.cuda.is_available()` is true; otherwise CPU.
- `cpu`: force actual CPU inference.
- `cuda`: verify CUDA and fail clearly if unavailable.

The worker doctor and job metadata report the requested and resolved device. They never claim GPU acceleration based on an environment variable alone.

## Waveforms and playback

Waveform generation consumes actual stored audio and writes cached peak data. The browser does not decode full large audio files repeatedly just to draw overview data. Playback uses real stem media elements scheduled from a shared transport clock; mute/solo/volume/pan adjust gain/panner nodes without creating substitute audio.

## Verification

`npm run prove:demucs` is the acceptance command. It requires FFmpeg, Python, PyTorch and Demucs, runs the standard model against the copyright-safe fixture, then rejects output that is missing, empty, undecodable, has no signal, or does not contain the four expected stems.
