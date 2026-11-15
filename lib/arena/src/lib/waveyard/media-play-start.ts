/**
 * Bounded media start.
 *
 * Why this is not a bare `await element.play()`: WebKit can leave that promise
 * pending forever even though the media actually started. It is the same class
 * of browser bug `resumeWithin` documents for AudioContext.resume().
 *
 * Observed in the WebKit browser-timing leg: after the Play control was
 * activated, every stem was unpaused, the audio clock advanced past twelve
 * seconds, the context was "running", and no play() had rejected -- yet the
 * `Promise.allSettled(elements.map((element) => element.play()))` await never
 * settled. `play()` had already been entered and the audio was audible, so the
 * transport sat in `starting` with no playback error and the control stayed
 * aria-busy "Cancel playback start" indefinitely.
 *
 * The bound releases the caller rather than deciding for it, mirroring
 * `resumeWithin`. On expiry the outcome is derived from the media element's own
 * observable state: the element is genuinely producing audio only if it is not
 * paused, has no error, and has decoded data for the current position. A stem
 * that is still paused, or has no current data, is reported as stalled so
 * callers surface an accurate error instead of claiming playback.
 */
export const MEDIA_START_TIMEOUT_MS = 4000;

export type MediaStartOutcome =
  /** `play()` settled, or the bound expired with audible media. */
  | { status: "started" }
  /** `play()` rejected; the caller classifies the reason. */
  | { status: "blocked"; reason: unknown }
  /** The bound expired with no evidence that this element is producing audio. */
  | { status: "stalled" };

const HAVE_CURRENT_DATA = 2;

function isAudiblyRunning(element: HTMLMediaElement): boolean {
  return !element.paused && element.error === null && element.readyState >= HAVE_CURRENT_DATA;
}

export function startMediaWithin(
  element: HTMLMediaElement,
  timeoutMs: number = MEDIA_START_TIMEOUT_MS,
): Promise<MediaStartOutcome> {
  return new Promise<MediaStartOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: MediaStartOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish(isAudiblyRunning(element) ? { status: "started" } : { status: "stalled" });
    }, timeoutMs);
    let started: Promise<void>;
    try {
      started = element.play();
    } catch (error) {
      // Older engines throw synchronously instead of rejecting.
      finish({ status: "blocked", reason: error });
      return;
    }
    void started.then(
      () => finish({ status: "started" }),
      (reason: unknown) => finish({ status: "blocked", reason }),
    );
  });
}
