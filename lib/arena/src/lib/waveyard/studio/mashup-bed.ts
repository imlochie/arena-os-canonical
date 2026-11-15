/**
 * Instrumental bed synthesis for the mashup renderer.
 *
 * The four-stem separation engine produces vocals / drums / bass / other;
 * the deep engine produces vocals / drums / bass / guitar / piano / other.
 * It does NOT produce an "instrumental" stem. The mashup route previously
 * looked for that non-existent stem and fell back to the bed track's
 * original file, which contains the bed's own vocal. This module builds a
 * clean instrumental bed from the separated non-vocal stems instead.
 *
 * The helper is deliberately strict:
 *   - only non-vocal stems from the SAME source and SAME completed
 *     separation run may be combined;
 *   - every included stem must have identical sample rate, channel layout,
 *     start offset and sample count;
 *   - the sum is scaled for headroom and, if a stem set is still hot, scaled
 *     down to a peak ceiling rather than silently clipped.
 *
 * It does not claim the result is vocal-free. Separation leakage is real;
 * the returned warning says so explicitly.
 */

export const INSTRUMENTAL_BED_STEM_TYPES = [
  "drums",
  "bass",
  "other",
  "guitar",
  "piano",
  "percussion",
] as const;

export type InstrumentalBedStemType = (typeof INSTRUMENTAL_BED_STEM_TYPES)[number];

export type InstrumentalBedStem = {
  stemType: string;
  sourceAssetId: string;
  separationJobId: string;
  /** Start offset in the source timeline. Full-length stems are 0. */
  startMs: number;
  sampleRate: number;
  channels: number;
  frames: number;
  /** Interleaved stereo PCM. */
  samples: Float32Array;
};

export type InstrumentalBed = {
  pcm: Float32Array;
  sampleRate: number;
  channels: number;
  frames: number;
  includedStemTypes: InstrumentalBedStemType[];
  excludedStemTypes: string[];
  /** Bed stem types deliberately omitted because a donor layer replaces them. */
  replacedStemTypes: string[];
  /** Gain actually applied to the summed bed (headroom + peak safety). */
  appliedGain: number;
  peak: number;
  warning: string;
};

export class InstrumentalBedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstrumentalBedError";
    this.code = code;
  }
}

/** Fixed headroom for the sum. A full-scale stem set still has ~6 dB room. */
export const MASHUP_BED_HEADROOM_GAIN = 0.5;
/** Never let the synthesized bed itself reach full scale. */
export const MASHUP_BED_PEAK_CEILING = 0.98;

const BED_STEM_TYPE_SET = new Set<string>(INSTRUMENTAL_BED_STEM_TYPES);

/**
 * Sum separated non-vocal stems into one stereo bed.
 *
 * Throws InstrumentalBedError when provenance or exact alignment cannot be
 * established. Never silently combines stems from different runs or formats.
 */
export function sumInstrumentalStems(
  stems: readonly InstrumentalBedStem[],
  options: {
    /**
     * Bed stem types to *omit* because a donor layer is replacing them.
     *
     * This is the difference between a replacement and a doubled section: if
     * the donor's drums are layered while the bed keeps its own drums, two
     * complete rhythm sections play at once, which is exactly the "chaotic,
     * not deliberately produced" failure. Replacement drops the bed's copy.
     */
    omitStemTypes?: readonly string[];
  } = {},
): InstrumentalBed {
  const omit = new Set(options.omitStemTypes ?? []);
  if (stems.length === 0) {
    throw new InstrumentalBedError(
      "no-stems",
      "No separated stems are available to build an instrumental bed.",
    );
  }

  const included = stems.filter((stem) => BED_STEM_TYPE_SET.has(stem.stemType) && !omit.has(stem.stemType));
  const replacedStemTypes = [...new Set(
    stems
      .filter((stem) => BED_STEM_TYPE_SET.has(stem.stemType) && omit.has(stem.stemType))
      .map((stem) => stem.stemType),
  )];
  const excludedStemTypes = [...new Set(
    stems
      .filter((stem) => !BED_STEM_TYPE_SET.has(stem.stemType))
      .map((stem) => stem.stemType),
  )];

  if (included.length === 0) {
    throw new InstrumentalBedError(
      replacedStemTypes.length > 0 ? "all-stems-replaced" : "no-instrumental-stems",
      replacedStemTypes.length > 0
        ? `Every instrumental bed stem (${replacedStemTypes.join(", ")}) was replaced by a donor layer, leaving no bed to place the vocal over.`
        : "The separation run contains no instrumental stems (only vocals or unsupported stem types).",
    );
  }

  const sourceAssetId = included[0]!.sourceAssetId;
  const separationJobId = included[0]!.separationJobId;
  for (const stem of included) {
    if (stem.sourceAssetId !== sourceAssetId) {
      throw new InstrumentalBedError(
        "provenance-mismatch",
        "Instrumental stems come from different source tracks; refusing to combine them.",
      );
    }
    if (stem.separationJobId !== separationJobId) {
      throw new InstrumentalBedError(
        "provenance-mismatch",
        "Instrumental stems come from different separation runs; refusing to combine them.",
      );
    }
  }

  const sampleRate = included[0]!.sampleRate;
  const channels = included[0]!.channels;
  const frames = included[0]!.frames;
  const startMs = included[0]!.startMs;

  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new InstrumentalBedError(
      "alignment-mismatch",
      "Instrumental stems have an invalid start offset.",
    );
  }

  for (const stem of included) {
    if (stem.sampleRate !== sampleRate) {
      throw new InstrumentalBedError(
        "alignment-mismatch",
        `Instrumental stem "${stem.stemType}" has sample rate ${stem.sampleRate}; expected ${sampleRate}.`,
      );
    }
    if (stem.channels !== channels) {
      throw new InstrumentalBedError(
        "alignment-mismatch",
        `Instrumental stem "${stem.stemType}" has ${stem.channels} channels; expected ${channels}.`,
      );
    }
    if (stem.frames !== frames) {
      throw new InstrumentalBedError(
        "alignment-mismatch",
        `Instrumental stem "${stem.stemType}" has ${stem.frames} frames; expected ${frames}.`,
      );
    }
    if (stem.startMs !== startMs) {
      throw new InstrumentalBedError(
        "alignment-mismatch",
        `Instrumental stem "${stem.stemType}" starts at ${stem.startMs} ms; expected ${startMs} ms.`,
      );
    }
    if (stem.samples.length !== frames * channels) {
      throw new InstrumentalBedError(
        "alignment-mismatch",
        `Instrumental stem "${stem.stemType}" has ${stem.samples.length} samples; expected ${frames * channels}.`,
      );
    }
  }

  if (channels !== 2) {
    throw new InstrumentalBedError(
      "channel-layout",
      `The mashup renderer expects stereo interleaved stems; got ${channels} channels.`,
    );
  }

  const pcm = new Float32Array(frames * channels);
  for (const stem of included) {
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] += stem.samples[index]! * MASHUP_BED_HEADROOM_GAIN;
    }
  }

  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));

  let appliedGain = MASHUP_BED_HEADROOM_GAIN;
  if (peak > MASHUP_BED_PEAK_CEILING) {
    const scale = MASHUP_BED_PEAK_CEILING / peak;
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] *= scale;
    }
    appliedGain *= scale;
    peak = MASHUP_BED_PEAK_CEILING;
  }

  return {
    pcm,
    sampleRate,
    channels,
    frames,
    includedStemTypes: included.map((stem) => stem.stemType as InstrumentalBedStemType),
    excludedStemTypes,
    replacedStemTypes,
    appliedGain,
    peak,
    warning:
      "The bed is synthesized from separated stems. Separation is not perfect; residual vocal or instrument leakage may remain.",
  };
}

// ---------------------------------------------------------------------------
// Fail-closed stem replacement
// ---------------------------------------------------------------------------

/**
 * What a requested `layerStemTypes` list actually becomes for one bed.
 *
 * Replacement is only ever allowed to happen when *both* halves are proven:
 * the donor stem was loaded from the authoritative separation run, and the
 * bed genuinely carries a separate, removable stem of the same role. A bed
 * that is one premixed file, or a single combined `instrumental` stem, has no
 * separable drums to remove — a "replacement" against it can only double the
 * part or silently do nothing, so it is refused instead of reported.
 */
export type StemCompositionPlan =
  | {
    ok: true;
    mode: "none" | "replace" | "layer";
    /** Donor types that are actually mixed in. */
    layerStemTypes: string[];
    /** Bed stem types actually omitted from the instrumental sum. */
    omittedBedStemTypes: string[];
    note: string;
  }
  | {
    ok: false;
    code:
      | "replacement-not-separable"
      | "replacement-donor-missing"
      | "replacement-bed-stem-missing";
    error: string;
  };

export function planStemComposition(input: {
  stemLayerMode: "replace" | "layer";
  requestedLayerStemTypes: readonly string[];
  /** What the bed can actually have removed: its separable stem types. */
  bedSeparableStemTypes: readonly string[];
  /**
   * Why the bed is not separable, when it is not. Used to say something
   * actionable rather than "no".
   */
  bedIndivisibleReason?: string | null;
  /** Donor stem types that were loaded and validated from the one run. */
  verifiedDonorStemTypes: readonly string[];
}): StemCompositionPlan {
  const requested = [...new Set(input.requestedLayerStemTypes)];
  if (requested.length === 0) {
    return {
      ok: true,
      mode: "none",
      layerStemTypes: [],
      omittedBedStemTypes: [],
      note: "Default composition: the donor supplies the vocal and the bed keeps its own drums, bass and other.",
    };
  }

  if (input.stemLayerMode === "layer") {
    const missing = requested.filter((type) => !input.verifiedDonorStemTypes.includes(type));
    if (missing.length > 0) {
      return {
        ok: false,
        code: "replacement-donor-missing",
        error: `Layering ${missing.join(", ")} needs the donor's separated ${missing.join(", ")} stem, which was not available in the donor's completed separation run. Nothing was layered.`,
      };
    }
    return {
      ok: true,
      mode: "layer",
      layerStemTypes: requested,
      omittedBedStemTypes: [],
      note: `Deliberate doubling: donor ${requested.join(", ")} plays alongside the bed's own ${requested.join(", ")}. Two sources cover the same role.`,
    };
  }

  // replace: both halves must be provable before anything is removed.
  if (input.bedSeparableStemTypes.length === 0) {
    return {
      ok: false,
      code: "replacement-not-separable",
      error: input.bedIndivisibleReason
        ?? "This instrumental has no separable drum, bass or other stems, so a replacement cannot remove anything. Choose deliberate layering, or separate the instrumental into stems first.",
    };
  }

  const missingDonor = requested.filter((type) => !input.verifiedDonorStemTypes.includes(type));
  if (missingDonor.length > 0) {
    return {
      ok: false,
      code: "replacement-donor-missing",
      error: `Replacing the bed's ${missingDonor.join(", ")} needs the donor's separated ${missingDonor.join(", ")} stem, which was not available in the donor's completed separation run. The bed's ${missingDonor.join(", ")} was left in place; nothing was replaced.`,
    };
  }

  const missingBed = requested.filter((type) => !input.bedSeparableStemTypes.includes(type));
  if (missingBed.length > 0) {
    return {
      ok: false,
      code: "replacement-bed-stem-missing",
      error: `Replacing the bed's ${missingBed.join(", ")} is not possible: this instrumental's separation run has no separate ${missingBed.join(", ")} stem. Nothing was removed.`,
    };
  }

  return {
    ok: true,
    mode: "replace",
    layerStemTypes: requested,
    omittedBedStemTypes: requested,
    note: `Replacement: donor ${requested.join(", ")} plays, and the bed's own ${requested.join(", ")} is removed so there is one ${requested.join(", ")} part rather than two. This is a deliberate request; no drum/bass compatibility measurement backs it yet.`,
  };
}
