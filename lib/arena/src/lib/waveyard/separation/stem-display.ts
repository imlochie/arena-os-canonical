/**
 * Stem display names — ONE place that turns a stored `stem_type` into the
 * lane label the deck, notices and aria-labels show.
 *
 * The vocabulary problem it solves: two engines both emit a stem called
 * `other`, and they mean different things.
 *  - The MDX 4-stem recipe's `other` (kuielab_b_other) is everything that
 *    is not vocals/drums/bass — guitar, keys, synths — the product's
 *    "Melody" lane.
 *  - The deep pass's `other` (htdemucs_6s) is the residual AFTER guitar and
 *    piano have been pulled into their own lanes. Calling it "Melody" would
 *    claim the melody instruments are in it when the point of the deep pass
 *    is that they are not. It is "Other".
 *
 * Layered stems are "<parent>/<child>"; each segment is named by the engine
 * that produced it: the child by the stem's own `model`, the parent by the
 * parent stem's model. Stem rows do not reference their parent, so
 * `laneDisplayName` resolves it the one way every playback surface can:
 * among the lanes it renders (same source, stem type = the parent segment).
 * When no such lane is there, or two parents of that type disagree on the
 * engine, the MDX vocabulary is used for the parent — parents are
 * overwhelmingly first-pass MDX stems ("other/guitar" = guitar inside the
 * Melody lane). Every surface MUST go through `laneDisplayName` (not the
 * bare `stemDisplayName`) so a deep-on-deep "other/vocals" reads
 * "Other · Vocals" everywhere, never "Melody · Vocals" on one screen.
 *
 * Client-safe (no node imports): the deck and the player import it directly.
 */

import { DEEP_MODEL_ID } from "./modes";

export type StemDisplayOptions = {
  /** The stem row's `model` (registry id, e.g. "kuielab_b_other" or "deep_6s"). */
  model?: string | null;
  /** The PARENT stem's `model` for layered stems, when known. */
  parentModel?: string | null;
};

/** True when the given model id is the deep engine's. */
export function isDeepStemModel(model: string | null | undefined): boolean {
  return model === DEEP_MODEL_ID;
}

function segmentLabel(segment: string, deep: boolean): string {
  if (segment === "other") return deep ? "Other" : "Melody";
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/** "vocals" → "Vocals"; MDX "other" → "Melody"; deep "other" → "Other";
 *  "other/guitar" (deep layers of the MDX melody) → "Melody · Guitar". */
export function stemDisplayName(stemType: string, options: StemDisplayOptions = {}): string {
  const segments = stemType.split("/");
  const ownDeep = isDeepStemModel(options.model);
  const parentDeep = options.parentModel === undefined || options.parentModel === null
    ? false
    : isDeepStemModel(options.parentModel);
  return segments
    .map((segment, index) => segmentLabel(segment, index === segments.length - 1 ? ownDeep : parentDeep))
    .join(" · ");
}

/** What a playback surface knows about each lane it renders. */
export type DisplayLane = {
  stemType: string;
  model?: string | null;
  sourceAssetId?: string | null;
};

/**
 * The parent lane's model for a layered stem, resolved among the rendered
 * lanes: same source, stem type equal to the parent segment. `undefined`
 * when there is no such lane or the candidates disagree on the engine
 * (the caller then falls back to the MDX vocabulary); `null`-model parents
 * count as MDX.
 */
export function parentLaneModel(stem: DisplayLane, lanes: readonly DisplayLane[]): string | null | undefined {
  const slash = stem.stemType.indexOf("/");
  if (slash === -1) return undefined;
  const parentType = stem.stemType.slice(0, slash);
  const parents = lanes.filter(
    (candidate) =>
      candidate !== stem &&
      candidate.stemType === parentType &&
      (candidate.sourceAssetId ?? null) === (stem.sourceAssetId ?? null),
  );
  if (parents.length === 0) return undefined;
  const deep = isDeepStemModel(parents[0].model);
  return parents.every((candidate) => isDeepStemModel(candidate.model) === deep) ? parents[0].model ?? null : undefined;
}

/** The lane label a surface shows — `stemDisplayName` with the parent's
 *  engine resolved among the rendered lanes. The ONE entry point for UI. */
export function laneDisplayName(stem: DisplayLane, lanes: readonly DisplayLane[]): string {
  return stemDisplayName(stem.stemType, { model: stem.model, parentModel: parentLaneModel(stem, lanes) });
}
