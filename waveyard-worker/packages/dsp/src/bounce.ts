/** Offline bus bounce using the SAME validated DSP kernels as cleanup/master.
 * FFmpeg retains responsibility for source ranges, transforms, fades and
 * automation; floating-point buses are never requantized before processing. */
import { readFile, stat, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
import { join } from "node:path";
import { processWithChain, type InsertChain } from "./inserts";

export const MAX_INSERT_BOUNCE_SECONDS = 300;
type Bus = { label: string; inserts: InsertChain; phaseInverted: boolean };

export function insertBounceRequired(buses: Pick<Bus, "inserts" | "phaseInverted">[], master: InsertChain) {
  return buses.some((bus) => bus.phaseInverted || bus.inserts.some((insert) => insert.enabled && insert.wet > 0)) || master.some((insert) => insert.enabled && insert.wet > 0);
}
function floatBytes(pcm: Float32Array) {
  if (endianness() === "LE") return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const bytes = Buffer.alloc(pcm.byteLength); for (let index = 0; index < pcm.length; index++) bytes.writeFloatLE(pcm[index], index * 4); return bytes;
}
async function readPcm(file: string, sampleRate: number) {
  const size = (await stat(file)).size;
  if (size % 8 || size > sampleRate * 2 * 4 * MAX_INSERT_BOUNCE_SECONDS) throw new Error("Invalid or oversized floating-point FX bus.");
  const bytes = await readFile(file); const pcm = new Float32Array(size / 4);
  for (let index = 0; index < pcm.length; index++) pcm[index] = bytes.readFloatLE(index * 4);
  return pcm;
}
function validateProcessed(pcm: Float32Array, sampleRate: number, timelineSamples: number) {
  // Leave bounded room for processor tails; never silently truncate a tail.
  if (pcm.length > (timelineSamples + sampleRate * 60) * 2) throw new Error("FX tails exceed the bounded bounce length.");
  for (const sample of pcm) if (!Number.isFinite(sample)) throw new Error("FX processing produced a non-finite sample; no export was published.");
}
export async function bounceInsertBuses(options: {
  exec: (file: string, args: string[], options: { cwd: string }) => Promise<unknown>;
  ffmpeg: string; directory: string; inputs: string[]; filters: string[];
  buses: Bus[]; masterVolume: number; masterInserts: InsertChain;
  sampleRate: number; timelineSamples: number; outputPath: string;
}) {
  const { ffmpeg, directory, sampleRate, exec } = options;
  if (options.timelineSamples > sampleRate * MAX_INSERT_BOUNCE_SECONDS) throw new Error(`FX/phase bounce is currently limited to ${MAX_INSERT_BOUNCE_SECONDS / 60} minutes. Shorten this version or bypass its processors; no dry substitute was exported.`);
  const paths = options.buses.map((_, index) => join(directory, `bus-${index}.f32`));
  await exec(ffmpeg, ["-y", ...options.inputs, "-filter_complex", options.filters.join(";"), ...options.buses.flatMap((bus, index) => ["-map", bus.label, "-vn", "-f", "f32le", "-ar", String(sampleRate), "-ac", "2", paths[index]])], { cwd: directory });
  let mix = new Float32Array(options.timelineSamples * 2);
  for (const [index, bus] of options.buses.entries()) {
    const pcm = await readPcm(paths[index], sampleRate);
    if (bus.phaseInverted) for (let sample = 0; sample < pcm.length; sample++) pcm[sample] = -pcm[sample];
    const processed = processWithChain(pcm, bus.inserts, sampleRate); validateProcessed(processed, sampleRate, options.timelineSamples);
    if (processed.length > mix.length) { const longer = new Float32Array(processed.length); longer.set(mix); mix = longer; }
    for (let sample = 0; sample < processed.length; sample++) mix[sample] += processed[sample];
  }
  for (let sample = 0; sample < mix.length; sample++) mix[sample] *= options.masterVolume;
  const mastered = processWithChain(mix, options.masterInserts, sampleRate); validateProcessed(mastered, sampleRate, options.timelineSamples);
  const path = join(directory, "processed-master.f32"); await writeFile(path, floatBytes(mastered));
  await exec(ffmpeg, ["-y", "-f", "f32le", "-ar", String(sampleRate), "-ac", "2", "-i", path, "-af", "aresample=out_sample_fmt=s16:dither_method=triangular_hp", "-c:a", "pcm_s16le", options.outputPath], { cwd: directory });
}
