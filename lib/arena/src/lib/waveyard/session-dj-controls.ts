export const SESSION_DJ_LOOP_LENGTHS = [1, 2, 4, 8] as const;
export const SESSION_MIN_BEAT_CONFIDENCE = 0.5;

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
