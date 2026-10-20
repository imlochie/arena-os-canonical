/** Browser preparation uses the export DSP kernels, not approximate native FX.
 * Clip decoding/resampling differs from FFmpeg; parity is tolerance-based.
 * Always render from zero before seeking so history-dependent FX retain state.
 */
import { clipFadeShapeOrLinear, fadeGainAt } from "./fades";
import { effectiveMuted, type RemixStateInput } from "./remix";
import { createAutomationEvaluator } from "./types/arrangement-automation";
import { INSERTS_FORMAT, parseInserts, processWithChain, type InsertChain } from "./mixer/inserts";

export type ArrangementPreviewState = Pick<RemixStateInput, "masterVolume" | "masterInserts" | "tracks" | "loopStartMs" | "loopEndMs" | "automation"> & Partial<Pick<RemixStateInput, "tempoBpm" | "targetKey">>;
export type DecodedPreviewAudio = { sampleRate: number; length: number; numberOfChannels: number; getChannelData(channel: number): Float32Array };
export const MAX_ARRANGEMENT_SECONDS = 300;
export const MAX_ARRANGEMENT_TAIL_SECONDS = 60;
export function previewChain(raw: unknown): InsertChain {
  if (raw == null) return [];
  if (typeof raw === "string") { try { return previewChain(JSON.parse(raw)); } catch { throw new Error("Invalid arrangement insert chain."); } }
  const chain = parseInserts(Array.isArray(raw) ? { format: INSERTS_FORMAT, inserts: raw } : raw);
  if (!chain) throw new Error("Unsupported or malformed arrangement insert chain; no dry substitute was played.");
  return chain;
}
export function assertBoundedPcm(pcm: Float32Array, sampleRate: number) {
  if (pcm.length > (MAX_ARRANGEMENT_SECONDS + MAX_ARRANGEMENT_TAIL_SECONDS) * sampleRate * 2) throw new Error("Arrangement effect tails exceed the 60-second allowance.");
  for (const value of pcm) if (!Number.isFinite(value)) throw new Error("Arrangement processing produced a non-finite sample.");
}
/** One pre-master bus, bounded independently from decoded/source ownership.
 * Master-only edits must rerun master DSP from zero, not every track's DSP.
 * The caller's immutable source revision participates in the full identity. */
export type ArrangementMixCache = { revision: string; key?: string; pcm?: Float32Array; hit?: boolean };
export const MAX_MIX_CACHE_BYTES = 64 * 1024 * 1024;
export function arrangementPreMasterCacheKey(state: ArrangementPreviewState, sampleRate: number, revision: string) {
  return JSON.stringify([state.tracks, state.automation, state.tempoBpm, state.targetKey, sampleRate, revision]);
}
function finishMix(mix: Float32Array, state: ArrangementPreviewState, sampleRate: number, drySamples: number) {
  for (let sample = 0; sample < mix.length; sample++) mix[sample] *= state.masterVolume;
  const result = processWithChain(mix, previewChain(state.masterInserts), sampleRate); assertBoundedPcm(result, sampleRate);
  if (result.length > drySamples + MAX_ARRANGEMENT_TAIL_SECONDS * sampleRate * 2) throw new Error("Combined arrangement FX tails exceed the 60-second allowance.");
  return result;
}
export function finishArrangementMix(mix: Float32Array, state: ArrangementPreviewState, sampleRate: number, drySamples: number) {
  return finishMix(mix, state, sampleRate, drySamples);
}
export type ArrangementMixPass = { mix: Float32Array; drySamples: number; anySolo: boolean; scratch: Float32Array | null };
export function startArrangementMix(state: ArrangementPreviewState, sampleRate: number): ArrangementMixPass {
  const endMs = Math.max(0, ...state.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStartMs + clip.durationMs)));
  if (!Number.isFinite(endMs) || endMs > MAX_ARRANGEMENT_SECONDS * 1000) throw new Error("Processed arrangement audition is limited to 5 minutes.");
  const drySamples = Math.ceil(endMs * sampleRate / 1000) * 2;
  return {
    mix: new Float32Array(drySamples), drySamples,
    anySolo: state.tracks.some((track) => track.solo && !track.muted), scratch: null,
  };
}
/** Add one track in canonical order, allowing the Worker to discard that
 * track's sources before staging the next track. The dry scratch bus is reused. */
export function addArrangementTrackToMix(pass: ArrangementMixPass, state: ArrangementPreviewState, track: ArrangementPreviewState["tracks"][number], buffers: ReadonlyMap<string, DecodedPreviewAudio>, sampleRate: number) {
  const inserts = previewChain(track.inserts);
  if (effectiveMuted(track, pass.anySolo)) return;
  const bus = pass.scratch ??= new Float32Array(pass.drySamples);
  bus.fill(0);
  for (const clip of track.clips) {
    // Never silently audition a different pitch or timing from the snapshot.
    if (clip.tempoSyncEnabled || clip.keySyncEnabled) throw new Error("Tempo/key-synced arrangement audition is not available yet. Use the WAV render to hear these transforms.");
    const audio = buffers.get(clip.stemAssetId);
    if (!audio || audio.sampleRate !== sampleRate) throw new Error("Arrangement source audio is unavailable or has the wrong sample rate.");
    const offset = Math.round(clip.sourceOffsetMs * sampleRate / 1000);
    const count = Math.round(clip.durationMs * sampleRate / 1000);
    const start = Math.round(Math.round(clip.timelineStartMs) * sampleRate / 1000);
    if (offset + count > audio.length + 1) throw new Error("Arrangement clip extends beyond its source audio.");
    const left = audio.getChannelData(0), right = audio.getChannelData(Math.min(1, audio.numberOfChannels - 1));
    const shape = clipFadeShapeOrLinear(clip.fadeShape);
    for (let frame = 0; frame < count; frame++) {
      const ms = frame * 1000 / sampleRate;
      const fadeIn = clip.fadeInMs > 0 ? fadeGainAt(shape, Math.min(1, ms / clip.fadeInMs)) : 1;
      const fadeOut = clip.fadeOutMs > 0 ? fadeGainAt(shape, Math.min(1, (clip.durationMs - ms) / clip.fadeOutMs)) : 1;
      const index = start + frame;
      bus[index * 2] += (left[offset + frame] ?? 0) * clip.gain * fadeIn * fadeOut;
      bus[index * 2 + 1] += (right[offset + frame] ?? 0) * clip.gain * fadeIn * fadeOut;
    }
  }
  const lanes = (state.automation ?? []).filter((lane) => lane.remixTrackId === track.id);
  const volumes = lanes.find((lane) => lane.parameter === "volume")?.points ?? [];
  const pans = lanes.find((lane) => lane.parameter === "pan")?.points ?? [];
  const constantVolume = track.volume * (track.phaseInverted ? -1 : 1);
  const constantLeft = constantVolume * Math.cos((track.pan + 1) * Math.PI / 4);
  const constantRight = constantVolume * Math.sin((track.pan + 1) * Math.PI / 4);
  if (!volumes.length && !pans.length) {
    for (let frame = 0; frame < bus.length / 2; frame++) { bus[frame * 2] *= constantLeft; bus[frame * 2 + 1] *= constantRight; }
  } else {
    const volumeAt = createAutomationEvaluator(volumes, track.volume);
    const panAt = createAutomationEvaluator(pans, track.pan);
    for (let frame = 0; frame < bus.length / 2; frame++) {
      const ms = frame * 1000 / sampleRate;
      const volume = volumeAt(ms) * (track.phaseInverted ? -1 : 1);
      const pan = panAt(ms);
      bus[frame * 2] *= volume * Math.cos((pan + 1) * Math.PI / 4);
      bus[frame * 2 + 1] *= volume * Math.sin((pan + 1) * Math.PI / 4);
    }
  }
  const processed = processWithChain(bus, inserts, sampleRate); assertBoundedPcm(processed, sampleRate);
  if (processed.length > pass.drySamples + MAX_ARRANGEMENT_TAIL_SECONDS * sampleRate * 2) throw new Error("Combined track FX tails exceed the 60-second allowance.");
  if (processed.length > pass.mix.length) { const longer = new Float32Array(processed.length); longer.set(pass.mix); pass.mix = longer; }
  for (let sample = 0; sample < processed.length; sample++) pass.mix[sample] += processed[sample];
}
export function prepareArrangementPcm(state: ArrangementPreviewState, buffers: ReadonlyMap<string, DecodedPreviewAudio>, sampleRate: number, cache?: ArrangementMixCache) {
  const key = cache ? arrangementPreMasterCacheKey(state, sampleRate, cache.revision) : "";
  if (cache) {
    cache.hit = cache.key === key && !!cache.pcm;
    if (cache.hit) {
      const pass = startArrangementMix(state, sampleRate);
      return finishArrangementMix(cache.pcm!.slice(), state, sampleRate, pass.drySamples);
    }
    cache.pcm = undefined; cache.key = undefined;
  }
  const pass = startArrangementMix(state, sampleRate);
  // Tracks are processed serially into the master sum. Reuse ONE zeroed dry
  // bus rather than allocating a full arrangement per track and waiting for
  // worker GC. FX may return a separate longer tail; it is summed before reuse.
  for (const track of state.tracks) addArrangementTrackToMix(pass, state, track, buffers, sampleRate);
  if (cache && pass.mix.byteLength <= MAX_MIX_CACHE_BYTES) { cache.pcm = pass.mix.slice(); cache.key = key; }
  return finishArrangementMix(pass.mix, state, sampleRate, pass.drySamples);
}
