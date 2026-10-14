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
 * parent stem's model when the caller knows it (the deck does, from the
 * lanes it renders), otherwise by the MDX vocabulary — parents are
 * overwhelmingly first-pass MDX stems ("other/guitar" = guitar inside the
 * Melody lane).
 *
 * Client-safe (no node imports): the deck imports it directly.
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
