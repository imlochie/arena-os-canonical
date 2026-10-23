// Controlled Node PCM workload, not browser/Electron or genuine-song performance.
// Run unchanged before/after with: node --import ./scripts/register-src-loader.mjs scripts/benchmark-arrangement-automation.mjs
import { prepareArrangementPcm } from '../src/lib/waveyard/arrangement-pcm.ts';
import { createHash } from 'node:crypto';
const sampleRate = 44100, length = sampleRate;
const left = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.11) * 0.25);
const right = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.17) * 0.2);
const clip = { stemAssetId: 'controlled-source', timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false };
const state = { masterVolume: 0.9, tracks: [{ id: 'track', name: 'automation benchmark', sortOrder: 0, stemAssetId: clip.stemAssetId, volume: 1, pan: 0, muted: false, solo: false, clips: [clip] }], automation: ['volume', 'pan'].map(parameter => ({ remixTrackId: 'track', parameter, points: Array.from({ length: 1024 }, (_, i) => ({ timelineMs: i, value: parameter === 'volume' ? 0.5 + Math.sin(i * 0.09) * 0.4 : Math.cos(i * 0.07) * 0.7 })) })) };
const sources = new Map([[clip.stemAssetId, { sampleRate, length, numberOfChannels: 2, getChannelData: c => c === 0 ? left : right }]]);
const rounds = [];
let checksum;
for (let round = 0; round < 3; round++) {
  const start = performance.now();
  const pcm = prepareArrangementPcm(state, sources, sampleRate);
  rounds.push(performance.now() - start);
  const sha256 = createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  if (checksum && checksum !== sha256) throw new Error('non-deterministic PCM');
  checksum = sha256;
}
console.log(JSON.stringify({ scope: 'Node controlled PCM, 1 track, two 1024-point lanes, 1 second stereo 44100Hz; not browser/Electron', roundsMs: rounds, medianMs: [...rounds].sort((a,b) => a-b)[1], sha256: checksum }, null, 2));
