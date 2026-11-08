/**
 * Bounded AudioContext resume.
 *
 * Why this is not a bare `await context.resume()`: the promise is allowed to
 * never settle. A context suspended because the machine has no usable audio
 * output does exactly that -- it neither resolves nor rejects. Play awaited it
 * directly, so playback stopped at the await with no error and the Playing
 * control never engaged, which is indistinguishable from a dead button.
 *
 * Observed in the Firefox browser-timing leg: resume() on the app's own context
 * and on a brand-new AudioContext both stayed pending past 3 s, while
 * AudioWorklet.addModule on that same context completed in 35 ms. Firefox
 * suspends the graph when there is no output device; Chromium and WebKit run it
 * anyway, which is why one engine stalled.
 *
 * The timeout releases the caller rather than deciding for it: the caller
 * inspects `state` afterwards and reports an accurate error.
 *
 * The bound must exceed a healthy cold start. Firefox's first resume() on a
 * context with a real (or null-sink) output took 1805 ms in CI before settling
 * "running"; a 1500 ms bound reported "interrupted" for a device that worked,
 * and the next resume() settled in 14 ms. A dead output never settles, so a
 * longer bound only delays that error.
 */
export const RESUME_TIMEOUT_MS = 6000;

export function resumeWithin(context: AudioContext, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // A rejected resume() is also not fatal here: the caller inspects `state`.
    void context.resume().then(finish, finish);
  });
}
