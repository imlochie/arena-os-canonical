/**
 * Separation modes — the product-facing answer to "what can the stem machine
 * be asked to do?", in ONE place so every surface agrees and none of them
 * hardcodes engine ids: the intake selects (upload + add-source), the worker
 * handler's branch, the deep route, and the stem deck's "go deeper" chip.
 *
 * The three modes:
 *  - the fast default (Kim Vocal 2 → vocals + instrumental), offered by
 *    leaving the target empty — the registry's first model;
 *  - the 4-stem recipe (`stems_4`) — one MDX model per stem, all in-process
 *    (see mdx.ts: registry models + recipes);
 *  - the DEEP pass (`deep_6s`) — the owner-prepared Python Demucs bridge
 *    (deep.ts, htdemucs_6s → six sources incl. guitar + piano). Nothing is
 *    bundled: the mode is offered, and when the machine has not been
 *    prepared the job records the honest unavailable state with the exact
 *    prepare step — never a fabricated stem.
 *
 * This module is CLIENT-SAFE by construction (ids, labels, counts — no node
 * imports): the deck imports the deep id/label from here, while the engine
 * itself (child processes, interpreter discovery) lives in ./deep and is
 * imported only by server code.
 */

export const DEEP_MODES_ENABLED = true;

/** Registry id a deep job targets (mirrors a model id; the worker handler
 *  branches on it before the MDX registry lookup). */
export const DEEP_MODEL_ID = "deep_6s";

/** Product label — never the Demucs file family name. */
export const DEEP_LABEL = "Deep — 6 stems";

/** The six sources htdemucs_6s separates, in the order lanes are created. */
export const DEEP_STEM_TYPES = ["vocals", "drums", "bass", "guitar", "piano", "other"] as const;

export type DeepStemType = (typeof DEEP_STEM_TYPES)[number];

export type SeparationModeOffering = {
  id: string;
  label: string;
  description: string;
  stemCount: number;
  engine: "mdx" | "demucs";
};

/** The deep mode's offering — the same shape selection.ts builds for the
 *  MDX fast default and recipes, so the UI renders one list. */
export const DEEP_MODE: SeparationModeOffering = {
  id: DEEP_MODEL_ID,
  label: DEEP_LABEL,
  description: "the deeper six-source pass — vocals, drums, bass, guitar, piano, melody",
  stemCount: DEEP_STEM_TYPES.length,
  engine: "demucs",
};

export function deepStemsEnabled(): boolean {
  return DEEP_MODES_ENABLED;
}

/** True for the deep registry id, and only while the mode is enabled. */
export function isDeepSeparationMode(id: string): boolean {
  return DEEP_MODES_ENABLED && id === DEEP_MODEL_ID;
}

/**
 * The intake target list (the "Separate into" selects). Empty id = the
 * machine default (fast two-stem pass). Kept here so the upload form and
 * the add-source form can never drift apart.
 */
export function separationTargetOptions(): Array<{ id: string; label: string }> {
  const options = [
    { id: "", label: "Vocals + instrumental — fastest" },
    { id: "stems_4", label: "4 stems — vocals, drums, bass, melody" },
  ];
  if (DEEP_MODES_ENABLED) {
    options.push({ id: DEEP_MODEL_ID, label: "Deep — 6 stems (guitar + piano)" });
  }
  return options;
}

// ---------------------------------------------------------------- lanes

/** Deck lane colors for the deep sources (the MDX palette lives in the deck
 *  component; these are the two lane types only the deep pass can produce). */
export const DEEP_STEM_COLORS: Record<DeepStemType, string> = {
  vocals: "#ff98bd",
  drums: "#8be5ff",
  bass: "#b7a0ff",
  guitar: "#f5a97f",
  piano: "#93e0c8",
  other: "#f8ca7b",
};
