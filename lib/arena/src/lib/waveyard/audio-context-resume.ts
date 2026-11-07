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
 */
export const RESUME_TIMEOUT_MS = 1500;

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
