import { timeStretch, type TimeStretchMapPoint } from "../elastic";

export type LocalTempoMap = {
  points: Array<{ sourceMs: number; outputMs: number }>;
  baselineFit: { matchedBeats: number; comparedBeats: number; meanErrorMs: number };
  correctedFit: { matchedBeats: number; comparedBeats: number; meanErrorMs: number };
  maximumRateDeviationPercent: number;
  entryShiftMs: number;
};

/**
 * A map is bound to the exact editable clip and source bytes it was measured
 * against. It lives in the version's mashupPlan JSON, not in a second clip
 * persistence system.
 */
export type PersistedClipTempoMap = LocalTempoMap & {
  format: "waveyard-clip-tempo-map-v1";
  clipId: string;
  remixTrackId: string;
  stemAssetId: string;
  sourceAssetId: string;
  sourceChecksumSha256: string;
  stemChecksumSha256: string;
  sourceOffsetMs: number;
  timelineStartMs: number;
  durationMs: number;
  sessionTempoBpm: number;
  baseStretchRatio: number;
};

export type ClipTempoMapIdentity = {
  clipId: string;
  remixTrackId: string;
  stemAssetId: string;
  sourceAssetId: string;
  sourceChecksumSha256: string;
  stemChecksumSha256: string;
  sourceOffsetMs: number;
  timelineStartMs: number;
  durationMs: number;
  sessionTempoBpm: number;
  stemDurationMs: number;
};

export type LocalTempoMapRenderWindow = {
  /** Source frames relative to the map's clip source start; end is exclusive. */
  inputStartFrame: number;
  inputEndFrame: number;
  /** Output frames relative to the map's clip output start; end is exclusive. */
  outputStartFrame: number;
  outputEndFrame: number;
  renderMap: TimeStretchMapPoint[];
  cropStartFrame: number;
  cropEndFrame: number;
};

const FORMAT = "waveyard-clip-tempo-map-v1" as const;
const MAX_MAP_POINTS = 512;
const MAX_SOURCE_SPAN_MS = 60 * 60 * 1_000;
const MAX_RATE_DEVIATION_PERCENT = 1.5;
const TIMING_TOLERANCE_MS = 1;
const SHA256 = /^[a-f0-9]{64}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fit(raw: unknown) {
  const value = record(raw);
  if (!value
    || !Number.isSafeInteger(value.matchedBeats)
    || !Number.isSafeInteger(value.comparedBeats)
    || !finite(value.meanErrorMs)
    || (value.matchedBeats as number) < 0
    || (value.comparedBeats as number) < 1
    || (value.matchedBeats as number) > (value.comparedBeats as number)
    || (value.meanErrorMs as number) < 0) return null;
  return {
    matchedBeats: value.matchedBeats as number,
    comparedBeats: value.comparedBeats as number,
    meanErrorMs: value.meanErrorMs as number,
  };
}

export function parseLocalTempoMap(raw: unknown, baseStretchRatio: number): LocalTempoMap | null {
  const value = record(raw);
  if (!value || !Array.isArray(value.points) || value.points.length < 3 || value.points.length > MAX_MAP_POINTS
    || !finite(baseStretchRatio) || baseStretchRatio < 0.1 || baseStretchRatio > 10
    || !finite(value.maximumRateDeviationPercent) || value.maximumRateDeviationPercent < 0
    || value.maximumRateDeviationPercent > MAX_RATE_DEVIATION_PERCENT + 0.001
    || !finite(value.entryShiftMs) || Math.abs(value.entryShiftMs) > 60_000) return null;

  const points: LocalTempoMap["points"] = [];
  let previousSource = -1;
  let previousOutput = -1;
  for (const rawPoint of value.points) {
    const point = record(rawPoint);
    if (!point || !finite(point.sourceMs) || !finite(point.outputMs)
      || point.sourceMs < 0 || point.outputMs < 0
      || point.sourceMs <= previousSource || point.outputMs <= previousOutput
      || point.sourceMs > MAX_SOURCE_SPAN_MS || point.outputMs > MAX_SOURCE_SPAN_MS) return null;
    points.push({ sourceMs: point.sourceMs, outputMs: point.outputMs });
    previousSource = point.sourceMs;
    previousOutput = point.outputMs;
  }
  if (points[0]!.sourceMs !== 0 || points[0]!.outputMs !== 0) return null;
  const last = points.at(-1)!;
  if (last.sourceMs <= 0 || last.outputMs <= 0) return null;

  let actualMaximumDeviation = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const segmentRate = (current.outputMs - previous.outputMs) / (current.sourceMs - previous.sourceMs);
    const deviationPercent = Math.abs(segmentRate / baseStretchRatio - 1) * 100;
    if (!Number.isFinite(segmentRate) || segmentRate <= 0
      || deviationPercent > MAX_RATE_DEVIATION_PERCENT + 0.001) return null;
    actualMaximumDeviation = Math.max(actualMaximumDeviation, deviationPercent);
  }
  if (value.maximumRateDeviationPercent + 0.001 < actualMaximumDeviation) return null;
  const baselineFit = fit(value.baselineFit);
  const correctedFit = fit(value.correctedFit);
  if (!baselineFit || !correctedFit) return null;

  return {
    points,
    baselineFit,
    correctedFit,
    maximumRateDeviationPercent: value.maximumRateDeviationPercent,
    entryShiftMs: value.entryShiftMs,
  };
}

export function parsePersistedClipTempoMap(raw: unknown): PersistedClipTempoMap | null {
  const value = record(raw);
  if (!value || value.format !== FORMAT) return null;
  const baseStretchRatio = value.baseStretchRatio;
  const map = parseLocalTempoMap(value, typeof baseStretchRatio === "number" ? baseStretchRatio : Number.NaN);
  if (!map
    || !["clipId", "remixTrackId", "stemAssetId", "sourceAssetId"].every((key) =>
      typeof value[key] === "string" && (value[key] as string).length > 0)
    || typeof value.sourceChecksumSha256 !== "string" || !SHA256.test(value.sourceChecksumSha256)
    || typeof value.stemChecksumSha256 !== "string" || !SHA256.test(value.stemChecksumSha256)
    || !finite(value.sourceOffsetMs) || value.sourceOffsetMs < 0
    || !finite(value.timelineStartMs) || value.timelineStartMs < 0
    || !finite(value.durationMs) || value.durationMs <= 0
    || !finite(value.sessionTempoBpm) || value.sessionTempoBpm < 20 || value.sessionTempoBpm > 300
    || !finite(value.baseStretchRatio) || value.baseStretchRatio < 0.1 || value.baseStretchRatio > 10
    || Math.abs(map.points.at(-1)!.outputMs - value.durationMs) > TIMING_TOLERANCE_MS) return null;

  return {
    ...map,
    format: FORMAT,
    clipId: value.clipId as string,
    remixTrackId: value.remixTrackId as string,
    stemAssetId: value.stemAssetId as string,
    sourceAssetId: value.sourceAssetId as string,
    sourceChecksumSha256: value.sourceChecksumSha256,
    stemChecksumSha256: value.stemChecksumSha256,
    sourceOffsetMs: value.sourceOffsetMs,
    timelineStartMs: value.timelineStartMs,
    durationMs: value.durationMs,
    sessionTempoBpm: value.sessionTempoBpm,
    baseStretchRatio: value.baseStretchRatio,
  };
}

export function clipTempoMapMatches(
  map: PersistedClipTempoMap,
  identity: ClipTempoMapIdentity,
): boolean {
  const sourceSpan = map.points.at(-1)!.sourceMs;
  const outputSpan = map.points.at(-1)!.outputMs;
  return map.clipId === identity.clipId
    && map.remixTrackId === identity.remixTrackId
    && map.stemAssetId === identity.stemAssetId
    && map.sourceAssetId === identity.sourceAssetId
    && map.sourceChecksumSha256 === identity.sourceChecksumSha256
    && map.stemChecksumSha256 === identity.stemChecksumSha256
    && map.sourceOffsetMs === identity.sourceOffsetMs
    && map.timelineStartMs === identity.timelineStartMs
    && map.durationMs === identity.durationMs
    && map.sessionTempoBpm === identity.sessionTempoBpm
    && Math.abs(outputSpan - identity.durationMs) <= TIMING_TOLERANCE_MS
    && map.sourceOffsetMs + sourceSpan <= identity.stemDurationMs + TIMING_TOLERANCE_MS;
}

export function localTempoSourceAtOutputMs(map: LocalTempoMap, outputMs: number): number {
  const points = map.points;
  if (outputMs <= points[0]!.outputMs) return points[0]!.sourceMs;
  if (outputMs >= points.at(-1)!.outputMs) return points.at(-1)!.sourceMs;
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.outputMs <= outputMs) low = middle;
    else high = middle;
  }
  const left = points[low]!;
  const right = points[high]!;
  const fraction = (outputMs - left.outputMs) / (right.outputMs - left.outputMs);
  return left.sourceMs + fraction * (right.sourceMs - left.sourceMs);
}

/** Build a bounded WSOLA window, including context so each preview chunk has
 * the same neighboring waveform evidence as the full-clip export. */
export function makeLocalTempoMapWindow(
  map: LocalTempoMap,
  sampleRate: number,
  outputStartMs: number,
  outputDurationMs: number,
  contextMs = 100,
): LocalTempoMapRenderWindow | null {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000
    || !finite(outputStartMs) || !finite(outputDurationMs) || outputStartMs < 0 || outputDurationMs <= 0
    || !finite(contextMs) || contextMs < 0 || contextMs > 2_000) return null;
  const totalOutputFrames = Math.round(map.points.at(-1)!.outputMs * sampleRate / 1_000);
  const outputStartFrame = Math.max(0, Math.min(totalOutputFrames, Math.round(outputStartMs * sampleRate / 1_000)));
  const outputEndFrame = Math.max(outputStartFrame, Math.min(
    totalOutputFrames,
    Math.round((outputStartMs + outputDurationMs) * sampleRate / 1_000),
  ));
  if (outputEndFrame <= outputStartFrame) return null;

  const contextFrames = Math.round(contextMs * sampleRate / 1_000);
  const windowOutputStart = Math.max(0, outputStartFrame - contextFrames);
  const windowOutputEnd = Math.min(totalOutputFrames, outputEndFrame + contextFrames);
  const mapAtFrame = (frame: number) => localTempoSourceAtOutputMs(map, frame * 1_000 / sampleRate);
  const inputStartFrame = Math.max(0, Math.round(mapAtFrame(windowOutputStart) * sampleRate / 1_000));
  const inputEndFrame = Math.round(mapAtFrame(windowOutputEnd) * sampleRate / 1_000);
  if (inputEndFrame <= inputStartFrame) return null;

  const anchors = [
    { outputFrame: windowOutputStart, inputFrame: inputStartFrame },
    ...map.points.slice(1, -1).flatMap((point) => {
      const pointOutputFrame = Math.round(point.outputMs * sampleRate / 1_000);
      if (pointOutputFrame <= windowOutputStart || pointOutputFrame >= windowOutputEnd) return [];
      return [{
        outputFrame: pointOutputFrame,
        inputFrame: Math.round(point.sourceMs * sampleRate / 1_000),
      }];
    }),
    { outputFrame: windowOutputEnd, inputFrame: inputEndFrame },
  ];
  const renderMap: TimeStretchMapPoint[] = [];
  for (const anchor of anchors) {
    const point = {
      outputFrame: anchor.outputFrame - windowOutputStart,
      inputFrame: anchor.inputFrame - inputStartFrame,
    };
    const previous = renderMap.at(-1);
    if (previous && (point.outputFrame <= previous.outputFrame || point.inputFrame <= previous.inputFrame)) continue;
    renderMap.push(point);
  }
  const inputFrames = inputEndFrame - inputStartFrame;
  const outputFrames = windowOutputEnd - windowOutputStart;
  if (renderMap.length < 2) return null;
  const previous = renderMap.at(-2)!;
  if (outputFrames <= previous.outputFrame || inputFrames <= previous.inputFrame) return null;
  renderMap[0] = { outputFrame: 0, inputFrame: 0 };
  renderMap[renderMap.length - 1] = { outputFrame: outputFrames, inputFrame: inputFrames };

  return {
    inputStartFrame,
    inputEndFrame,
    outputStartFrame,
    outputEndFrame,
    renderMap,
    cropStartFrame: outputStartFrame - windowOutputStart,
    cropEndFrame: outputEndFrame - windowOutputStart,
  };
}

/** Apply a previously bounded source window and return only its requested
 * output frames. The caller owns WAV decode/range access; both browser preview
 * and the export worker use this exact renderer. */
export function renderLocalTempoMapRange(
  sourceWindow: Float32Array,
  sampleRate: number,
  window: LocalTempoMapRenderWindow,
): Float32Array | null {
  const inputFrames = window.inputEndFrame - window.inputStartFrame;
  const outputFrames = window.renderMap.at(-1)!.outputFrame;
  if (sourceWindow.length !== inputFrames * 2 || inputFrames <= 0 || outputFrames <= 0) return null;
  const stretched = timeStretch(sourceWindow, outputFrames / inputFrames, sampleRate, window.renderMap);
  const from = window.cropStartFrame * 2;
  const to = window.cropEndFrame * 2;
  if (from < 0 || to > stretched.length || to <= from) return null;
  return stretched.slice(from, to);
}

export function renderLocalTempoMapWhole(
  source: Float32Array,
  sampleRate: number,
  map: LocalTempoMap,
): Float32Array | null {
  const window = makeLocalTempoMapWindow(map, sampleRate, 0, map.points.at(-1)!.outputMs, 0);
  if (!window || window.inputStartFrame !== 0 || window.inputEndFrame * 2 > source.length) return null;
  return renderLocalTempoMapRange(
    source.subarray(0, window.inputEndFrame * 2),
    sampleRate,
    window,
  );
}

export function createPersistedClipTempoMap(input: {
  clipId: string;
  remixTrackId: string;
  stemAssetId: string;
  sourceAssetId: string;
  sourceChecksumSha256: string;
  stemChecksumSha256: string;
  sourceOffsetMs: number;
  timelineStartMs: number;
  durationMs: number;
  sessionTempoBpm: number;
  baseStretchRatio: number;
  map: LocalTempoMap;
}): PersistedClipTempoMap | null {
  return parsePersistedClipTempoMap({
    ...input.map,
    format: FORMAT,
    clipId: input.clipId,
    remixTrackId: input.remixTrackId,
    stemAssetId: input.stemAssetId,
    sourceAssetId: input.sourceAssetId,
    sourceChecksumSha256: input.sourceChecksumSha256,
    stemChecksumSha256: input.stemChecksumSha256,
    sourceOffsetMs: input.sourceOffsetMs,
    timelineStartMs: input.timelineStartMs,
    durationMs: input.durationMs,
    sessionTempoBpm: input.sessionTempoBpm,
    baseStretchRatio: input.baseStretchRatio,
  });
}
