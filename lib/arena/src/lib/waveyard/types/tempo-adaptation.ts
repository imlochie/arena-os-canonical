/**
 * Automatic passage adaptation is deliberately narrower than the renderer's
 * general-purpose WSOLA range. Beyond this envelope, timing distortion is too
 * large to treat as an automatic remix decision.
 */
export const MIN_AUTOMATIC_TEMPO_RATIO = 0.5;
export const MAX_AUTOMATIC_TEMPO_RATIO = 2;
