export const SESSION_DJ_LOOP_LENGTHS = [1, 2, 4, 8] as const;

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
): SessionBeatLoop | null {
  if (!beatGridMs || !Number.isFinite(positionSeconds) || positionSeconds < 0
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
