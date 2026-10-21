import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationEvaluator, type AutomationPoint } from './types/arrangement-automation';
import { prepareArrangementPcm } from './arrangement-pcm';

/** Previous shipping evaluator, retained as an independent regression oracle. */
function previous(points: AutomationPoint[], ms: number, fallback: number) {
  if (!Number.isFinite(ms) || !Number.isFinite(fallback) || !points.length) return fallback;
  const ordered = [...points].sort((a,b) => a.timelineMs-b.timelineMs);
  if (ms <= ordered[0].timelineMs) return ordered[0].value;
  const final = ordered.at(-1)!;
  if (ms >= final.timelineMs) return final.value;
  const segments = ordered.slice(1).map((b, i) => ({ a: ordered[i], b })).filter(({a,b}) => b.timelineMs>a.timelineMs);
  const segment = segments.find(({b}) => ms<=b.timelineMs);
  if (!segment) return final.value;
  const {a,b} = segment;
  return a.value+(b.value-a.value)*((ms-a.timelineMs)/(b.timelineMs-a.timelineMs));
}
test('compiled automation preserves unsorted, duplicate, boundary, seek and fallback semantics', () => {
  for (const points of [[], [{ timelineMs: 15, value: 0.3 }], Array.from({ length: 1024 }, (_, i) => ({ timelineMs: Math.floor((1023-i)/3)*4, value: (i%19)/19 }))]) {
    const original = structuredClone(points);
    const at = createAutomationEvaluator(points, 0.7);
    for (const ms of [-1, 0, 4, 16, 1364, 1365, Infinity, NaN, ...Array.from({ length: 300 }, (_, i) => (i*197)%1500+0.125)]) assert.equal(at(ms), previous(points, ms, 0.7));
    assert.deepEqual(points, original, 'compilation does not mutate persisted point order');
  }
  assert.ok(Number.isNaN(createAutomationEvaluator([], NaN)(0)));
});
test('compiled dense lane uses bounded logarithmic lookups, not sorting/scanning per sample', () => {
  let reads = 0;
  const points = Array.from({ length: 1024 }, (_, i) => ({ get timelineMs() { reads++; return i; }, value: i/1024 }));
  const at = createAutomationEvaluator(points, 1);
  reads = 0;
  for (let i = 0; i < 1000; i++) assert.equal(at(i+0.25), (i+0.25)/1024);
  assert.ok(reads < 24000, `point-time reads=${reads}; linear/sort-per-sample work regressed`);
});
test('actual PCM renderer with dense volume and pan automation agrees with previous evaluator', () => {
  const sampleRate = 2000, length = 2000;
  const samples = Float32Array.from({ length }, (_, i) => Math.sin(i*0.12)*0.2);
  const volume = Array.from({ length: 128 }, (_, i) => ({ timelineMs: i*8, value: 0.5+Math.sin(i)*0.2 }));
  const pan = Array.from({ length: 128 }, (_, i) => ({ timelineMs: i*8, value: Math.cos(i)*0.3 }));
  const clip = { stemAssetId: 'stem', timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false };
  const state = { masterVolume: 1, loopStartMs: 0, loopEndMs: null, tracks: [{ id: 'track', name: 'controlled', sortOrder: 0, stemAssetId: 'stem', volume: 1, pan: 0, muted: false, solo: false, clips: [clip] }], automation: [{ remixTrackId: 'track', parameter: 'volume' as const, points: volume }, { remixTrackId: 'track', parameter: 'pan' as const, points: pan }] };
  const pcm = prepareArrangementPcm(state, new Map([['stem', { sampleRate, length, numberOfChannels: 2, getChannelData: () => samples }]]), sampleRate);
  let maxError = 0;
  assert.equal(pcm.length, length*2);
  for (let i = 0; i < length; i++) {
    const ms = i*1000/sampleRate;
    const gain = previous(volume, ms, 1), angle = (previous(pan, ms, 0)+1)*Math.PI/4;
    maxError = Math.max(maxError, Math.abs(pcm[i*2]-Math.fround(samples[i]*gain*Math.cos(angle))), Math.abs(pcm[i*2+1]-Math.fround(samples[i]*gain*Math.sin(angle))));
  }
  assert.ok(maxError <= 1e-7, `max PCM sample error=${maxError}`);
});
