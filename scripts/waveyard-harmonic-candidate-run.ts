/** Run the offline candidate and unchanged production detector on hash-verified
 * source, stem and (when available) recombined-bed inputs. Private audio stays
 * at its source path. Set WAVEYARD_ASSET_OVERRIDES_JSON to map manifest SHA-256
 * values to exact local files. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { ANALYSIS_PCM_RATE, detectHarmonyTimeline } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import type { HarmonyEvent } from "../lib/arena/src/lib/waveyard/types/harmony-analysis";

type PinnedAsset = { file: string; sha256: string };
type Track = PinnedAsset & { id: string; title: string; containerDurationMs: number; stems?: Record<string, PinnedAsset> };
type CandidateResult = { runtimeMs: number; rssBeforeBytes: number; rssAfterBytes: number; events: HarmonyEvent[]; tuning: unknown; diagnostics: unknown; hypotheses: unknown[] };
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "scripts/fixtures/waveyard-musical-evaluation.json"), "utf8")) as { tracks: Track[] };
const overrides = JSON.parse(process.env.WAVEYARD_ASSET_OVERRIDES_JSON ?? "{}") as Record<string, string>;
const inputStatus: Array<Record<string, unknown>> = [];
const measurements: Array<Record<string, unknown>> = [];
let peakRssBytes = process.memoryUsage().rss;

function pathFor(asset: PinnedAsset): string { return resolve(overrides[asset.sha256] ?? resolve(root, asset.file)); }
async function verifiedPath(trackId: string, role: string, asset: PinnedAsset): Promise<string | null> {
  const path = pathFor(asset);
  try {
    const bytes = await readFile(path);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    const status = actualSha256 === asset.sha256 ? "verified" : "sha256-mismatch";
    inputStatus.push({ trackId, role, manifestPath: asset.file, localFileName: overrides[asset.sha256] ? basename(path) : null,
      expectedSha256: asset.sha256, actualSha256, sizeBytes: bytes.byteLength, status });
    return status === "verified" ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    inputStatus.push({ trackId, role, manifestPath: asset.file, localFileName: overrides[asset.sha256] ? basename(path) : null,
      expectedSha256: asset.sha256, actualSha256: null, sizeBytes: null, status: "missing" });
    return null;
  }
}
function decode(path: string): Float32Array {
  const bytes = execFileSync(process.env.ARENA_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-v", "error", "-i", path,
    "-f", "f32le", "-ac", "1", "-ar", String(ANALYSIS_PCM_RATE), "pipe:1"], { maxBuffer: 96 * 1024 * 1024 });
  if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error(`Invalid decoded analysis PCM for ${basename(path)}`);
  const pcm = new Float32Array(bytes.length / 4);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = bytes.readFloatLE(index * 4);
  if (pcm.some((sample) => !Number.isFinite(sample))) throw new Error(`Non-finite analysis PCM for ${basename(path)}`);
  return pcm;
}
function probe(path: string): Record<string, unknown> {
  try {
    const json = execFileSync(process.env.ARENA_FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" });
    const parsed = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    return { container: parsed.format?.format_name ?? null, durationSeconds: Number(parsed.format?.duration) || null,
      audioCodec: audio?.codec_name ?? null, sampleRate: Number(audio?.sample_rate) || null,
      channels: Number(audio?.channels) || null, channelLayout: audio?.channel_layout ?? null };
  } catch (error) {
    return { probeError: error instanceof Error ? error.message : String(error) };
  }
}
async function candidateInWorker(pcm: Float32Array): Promise<CandidateResult & { sampledPeakRssBytes: number }> {
  const transfer = pcm.buffer as ArrayBuffer;
  const baseline = process.memoryUsage().rss;
  peakRssBytes = Math.max(peakRssBytes, baseline);
  const worker = new Worker(new URL("./waveyard-harmonic-candidate-worker.ts", import.meta.url), {
    workerData: { pcm: transfer }, transferList: [transfer], execArgv: process.execArgv,
  });
  let sampledPeakRssBytes = baseline;
  const sampler = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 10);
  try {
    const result = await new Promise<CandidateResult>((resolveResult, reject) => {
      worker.once("message", resolveResult);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`candidate worker exited with ${code}`)); });
    });
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, result.rssAfterBytes);
    peakRssBytes = Math.max(peakRssBytes, sampledPeakRssBytes);
    return { ...result, sampledPeakRssBytes };
  } finally { clearInterval(sampler); await worker.terminate(); }
}
async function evaluate(trackId: string, role: string, path: string, sha256: string, pcm: Float32Array): Promise<void> {
  const durationMs = Math.round(pcm.length * 1000 / ANALYSIS_PCM_RATE);
  const productionStart = performance.now();
  const productionEvents = detectHarmonyTimeline(pcm);
  const productionRuntimeMs = performance.now() - productionStart;
  const result = await candidateInWorker(pcm);
  const named = (event: HarmonyEvent) => event.root !== null && event.quality !== "unknown";
  const productionNamed = productionEvents.filter(named).length;
  const candidateNamed = result.events.filter(named).length;
  const candidateKeys = new Set(result.events.filter(named).map((event) => `${event.root}:${event.quality}`));
  const productionKeys = new Set(productionEvents.filter(named).map((event) => `${event.root}:${event.quality}`));
  measurements.push({ trackId, sourceDomain: role, assetSha256: sha256, durationMs, inputFormat: path.startsWith("derived:") ? null : probe(path),
    production: { engine: "arena-js-dsp", namedWindows: productionNamed, totalWindows: productionEvents.length, runtimeMs: productionRuntimeMs, events: productionEvents },
    candidate: { engine: "waveyard-multires-overtone-context-candidate", version: "0.2.0", namedSegments: candidateNamed,
      totalSegments: result.events.length, abstentionRate: result.events.length ? 1 - candidateNamed / result.events.length : null,
      runtimeMs: result.runtimeMs, rssBeforeBytes: result.rssBeforeBytes, rssAfterBytes: result.rssAfterBytes,
      sampledPeakRssBytes: result.sampledPeakRssBytes,
      additionalPeakRssBytes: Math.max(0, result.sampledPeakRssBytes - result.rssBeforeBytes), tuning: result.tuning,
      diagnostics: result.diagnostics, events: result.events, hypotheses: result.hypotheses },
    diagnosticDisagreement: { productionNamedChordTypes: [...productionKeys].sort(), candidateNamedChordTypes: [...candidateKeys].sort(),
      labelSetIntersectionSize: [...candidateKeys].filter((key) => productionKeys.has(key)).length },
    accuracy: null,
  });
}

for (const track of manifest.tracks) {
  const source = await verifiedPath(track.id, "original-source", track);
  if (source) await evaluate(track.id, "original-source", source, track.sha256, decode(source));
  const stemPaths: Record<string, string> = {};
  for (const [stem, asset] of Object.entries(track.stems ?? {})) {
    const path = await verifiedPath(track.id, `stem:${stem}`, asset);
    if (path) { stemPaths[stem] = path; await evaluate(track.id, `stem:${stem}`, path, asset.sha256, decode(path)); }
  }
  if (Object.keys(track.stems ?? {}).length === 4 && Object.keys(stemPaths).length === 4) {
    const decoded = Object.fromEntries(Object.entries(stemPaths).map(([stem, path]) => [stem, decode(path)]));
    const lengths = Object.values(decoded).map((pcm) => pcm.length);
    if (new Set(lengths).size !== 1) throw new Error(`Cannot recombine ${track.id}: stem decoded lengths differ; alignment is unverified.`);
    const mix = new Float32Array(lengths[0]!);
    // The target is the instrumental bed. Vocals are hash-verified above but
    // deliberately excluded from the recombination.
    for (const role of ["bass", "drums", "other"]) {
      const pcm = decoded[role];
      if (!pcm) throw new Error(`Cannot recombine ${track.id}: required ${role} stem missing`);
      for (let i = 0; i < mix.length; i += 1) mix[i] += pcm[i]!;
    }
    const compositeSha256 = createHash("sha256").update(`waveyard-instrumental-bed-v1:${["bass", "drums", "other"].map((role) => track.stems![role]!.sha256).join(":")}`).digest("hex");
    await evaluate(track.id, "recombined-instrumental-bed", `derived:${track.id}`, compositeSha256, mix);
  }
}

const sourceCount = inputStatus.filter((input) => input.role === "original-source" && input.status === "verified").length;
const stemsRequired = inputStatus.filter((input) => String(input.role).startsWith("stem:")).length;
const stemsVerified = inputStatus.filter((input) => String(input.role).startsWith("stem:") && input.status === "verified").length;
const report = { schemaVersion: 1, candidate: { engine: "waveyard-multires-overtone-context-candidate", version: "0.2.0" },
  production: { engine: "arena-js-dsp", behaviorChanged: false }, manifest: "scripts/fixtures/waveyard-musical-evaluation.json",
  status: sourceCount === 6 ? (stemsVerified === stemsRequired ? "all-pinned-domains-measured" : "original-sources-measured-stems-missing") : "source-audio-missing",
  assets: inputStatus, sourceCountVerified: sourceCount, stemsVerified, stemsRequired,
  measurements, aggregate: { accuracy: null, reason: "No independent verified chord labels are available; named coverage and disagreements are diagnostic only." },
  peakProcessRssBytes: peakRssBytes,
  limitations: ["Source, separated-stem and recombined-bed domains are reported separately.",
    "Recombined instrumental beds require all four verified pinned stems (bass, drums, vocals, other) with equal decoded lengths; only bass, drums and other are summed. Equal length does not adjudicate phase/gain alignment.",
    "No chords, boundaries or reviewer judgments are inferred from the audio.",
    "Source melody and bed harmonic evidence are not separated in original-source measurements."] };
const output = resolve(root, process.argv[2] ?? "docs/waveyard-harmonic-candidate-run-report.json");
if (sourceCount < 6) {
  try {
    const previous = JSON.parse(await readFile(output, "utf8")) as { sourceCountVerified?: number };
    if ((previous.sourceCountVerified ?? 0) > sourceCount)
      throw new Error(`Refusing to replace richer verified evidence at ${output} with an incomplete run (${sourceCount}/6 original sources). Restore the six pinned sources or choose a new output path.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing to replace richer")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: output.replace(`${root}/`, ""), status: report.status, sourceCountVerified: sourceCount,
  stemsVerified, stemsRequired, measurementCount: measurements.length, peakProcessRssBytes: peakRssBytes,
  aggregate: report.aggregate }, null, 2));
