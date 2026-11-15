export const SESSION_DJ_LOOP_LENGTHS = [1, 2, 4, 8] as const;
export const SESSION_MIN_BEAT_CONFIDENCE = 0.5;
export const SESSION_DJ_BAR_LENGTHS = [1, 2] as const;
export const SESSION_MIN_DOWNBEAT_CONFIDENCE = 0.65;

export function hasReliableSessionBeatEvidence(value: unknown): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value <= 1
    && value >= SESSION_MIN_BEAT_CONFIDENCE;
}

export type SessionBeatLoop = {
  start: number;
  end: number;
};

function validDownbeatGrid(value: unknown): value is readonly number[] {
  return Array.isArray(value)
    && value.length >= 2
    && value.every((position, index) =>
      Number.isSafeInteger(position)
      && position >= 0
      && (index === 0 || position > value[index - 1]),
    );
}

export function hasReliableSessionDownbeatEvidence(
  confidence: unknown,
  downbeatGridMs: unknown,
): boolean {
  return typeof confidence === "number"
    && Number.isFinite(confidence)
    && confidence >= SESSION_MIN_DOWNBEAT_CONFIDENCE
    && confidence <= 1
    && validDownbeatGrid(downbeatGridMs);
}

/**
 * Build a loop from the analyzed beat grid, entering on the next beat.
 * Returns null rather than guessing when the grid does not cover the loop.
 */
export function nextSessionBeatLoop(
  beatGridMs: readonly number[] | null | undefined,
  positionSeconds: number,
  beats: number,
  beatConfidence: number | null | undefined,
): SessionBeatLoop | null {
  if (!hasReliableSessionBeatEvidence(beatConfidence)
    || !beatGridMs
    || !Number.isFinite(positionSeconds)
    || positionSeconds < 0
    || !Number.isInteger(beats) || beats < 1) return null;

  const grid = beatGridMs.filter((value) => Number.isFinite(value) && value >= 0);
  if (grid.length < beats + 1) return null;

  const positionMs = positionSeconds * 1000;
  const startIndex = grid.findIndex((value) => value >= positionMs - 10);
  if (startIndex < 0 || startIndex + beats >= grid.length) return null;

  const start = grid[startIndex] / 1000;
  const end = grid[startIndex + beats] / 1000;
  if (end <= start) return null;
  return { start, end };
}

/** Build a one- or two-bar loop from persisted, verified downbeat positions. */
export function nextSessionBarLoop(
  downbeatGridMs: readonly number[] | null | undefined,
  positionSeconds: number,
  bars: number,
  downbeatConfidence: number | null | undefined,
): SessionBeatLoop | null {
  if (
    !hasReliableSessionDownbeatEvidence(downbeatConfidence, downbeatGridMs)
    || !Number.isFinite(positionSeconds)
    || positionSeconds < 0
    || !Number.isInteger(bars)
    || bars < 1
    || bars > 8
  ) return null;

  if (!downbeatGridMs) return null;
  const startIndex = downbeatGridMs.findIndex((value) => value >= positionSeconds * 1000 - 10);
  if (startIndex < 0 || startIndex + bars >= downbeatGridMs.length) return null;
  const start = downbeatGridMs[startIndex]! / 1000;
  const end = downbeatGridMs[startIndex + bars]! / 1000;
  return end > start ? { start, end } : null;
}
