import { pitchShift } from "./elastic";

export function pitchShiftPreviewStereoPcm(
  interleavedStereo: Float32Array,
  semitones: number,
  sampleRate: number,
) {
  if (!Number.isInteger(semitones) || semitones < -11 || semitones > 11)
    throw new RangeError("Preview key sync requires an integer shift from -11 to +11 semitones.");
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new RangeError("Preview key sync requires a valid sample rate.");
  if (interleavedStereo.length % 2 !== 0)
    throw new RangeError("Preview key sync requires interleaved stereo PCM.");
  return pitchShift(interleavedStereo, semitones, sampleRate);
}
