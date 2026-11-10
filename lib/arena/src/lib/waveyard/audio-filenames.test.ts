import { describe, it } from "node:test";
import { expect } from "./test-shim";
import { acceptedAudioFilename, sanitizedFilename } from "./audio";
describe("audio upload guard", () => {
  it("accepts only supported filename extensions", () => { expect(acceptedAudioFilename("track.FLAC")).toBe(true); expect(acceptedAudioFilename("track.exe")).toBe(false); });
  it("removes path components from names", () => { expect(sanitizedFilename("../../mix\\source.wav")).not.toContain("/"); expect(sanitizedFilename("../../mix\\source.wav")).not.toContain("\\"); });
});
