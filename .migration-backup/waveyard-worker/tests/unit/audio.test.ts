import { describe, expect, it } from "vitest";
import { acceptedAudioFilename, sanitizedFilename } from "@waveyard/audio";
describe("audio upload guard", () => {
  it("accepts only supported filename extensions", () => { expect(acceptedAudioFilename("track.FLAC")).toBe(true); expect(acceptedAudioFilename("track.exe")).toBe(false); });
  it("removes path components from names", () => { expect(sanitizedFilename("../../mix\\source.wav")).not.toContain("/"); expect(sanitizedFilename("../../mix\\source.wav")).not.toContain("\\"); });
});
