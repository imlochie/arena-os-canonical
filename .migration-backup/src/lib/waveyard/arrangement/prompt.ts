/**
 * Prompt → ArrangementInstruction.
 *
 * Two paths, both honest:
 *  1. DETERMINISTIC (always available): a lexicon parser maps words to
 *     instruction fields. Everything it finds is reported back in
 *     `interpretation`; anything it could not find is reported too — no
 *     silent defaults pretending the user asked for them.
 *  2. AI-ASSISTED (model-gated): a text model receives the user prompt +
 *     the analysis packet and emits the same ArrangementInstruction JSON.
 *     The output is validated by the same schema (validateArrangementInstruction)
 *     and rejected — never "best-effort corrected" — if malformed.
 *
 * The deterministic parser is the fallback and the contract test: the AI
 * must do at least as well as the lexicon to be worth calling.
 */

import {
  ArrangementInstructionSchema,
  DENSITIES,
  INSTRUMENT_FAMILIES,
  MOODS,
  ARRANGEMENT_INSTRUCTION_FORMAT,
  type ArrangementInstruction,
  type Mood,
} from "./composer";

export type PromptInterpretation = {
  instruction: ArrangementInstruction;
  /** What the parser understood, in order — shown to the user verbatim. */
  interpretation: string[];
  /** True when a field defaulted instead of being requested. */
  usedDefaults: string[];
  /** Words the parser could not map (honest signal for the AI path). */
  unmappedPhrases: string[];
};

const INSTRUMENT_LEXICON: Record<string, ArrangementInstruction["instrument"]> = {
  string: "strings", strings: "strings", violin: "strings", viola: "strings",
  cello: "strings", orchestral: "strings", orchestra: "strings",
  pad: "pad", pads: "pad", ambient: "pad", texture: "pad", drone: "pad", drones: "pad",
  pluck: "pluck", plucks: "pluck", harp: "pluck", guitar: "pluck", arpeggio: "pluck",
  choir: "choir", vocal: "choir", vocals: "choir", voices: "choir", aahs: "choir",
  bass: "sub-bass", "sub-bass": "sub-bass", sub: "sub-bass", 808: "sub-bass",
};

const MOOD_LEXICON: Array<[RegExp, Mood]> = [
  [/\bsinister\b/i, "sinister"],
  [/\bevil\b/i, "sinister"],
  [/\bmenacing\b/i, "sinister"],
  [/\bdark\b/i, "dark"],
  [/\bmood?y\b/i, "dark"],
  [/\btense\b/i, "tense"],
  [/\bsuspense(ful)?\b/i, "tense"],
  [/\bepic\b/i, "epic"],
  [/\btriumphant\b/i, "epic"],
  [/\bcinematic\b/i, "cinematic"],
  [/\bfilmic\b/i, "cinematic"],
  [/\bbright\b/i, "bright"],
  [/\bhappy\b/i, "bright"],
  [/\bwarm\b/i, "warm"],
  [/\bcozy\b/i, "warm"],
  [/\bdream(y|like)?\b/i, "dreamy"],
  [/\bethereal\b/i, "dreamy"],
  [/\bsad\b/i, "melancholy"],
  [/\bmelanchol(y|ic)\b/i, "melancholy"],
  [/\bemotion(al)?\b/i, "melancholy"],
  [/\baggressive\b/i, "aggressive"],
  [/\bhard(hitting)?\b/i, "aggressive"],
  [/\bminimal\b/i, "minimal"],
  [/\bsubtle\b/i, "minimal"],
];

const DENSITY_LEXICON: Array<[RegExp, ArrangementInstruction["density"]]> = [
  [/\bsparse\b/i, "sparse"],
  [/\bthin\b/i, "sparse"],
  [/\boccasional(ly)?\b/i, "sparse"],
  [/\bdense\b/i, "dense"],
  [/\bbusy\b/i, "dense"],
  [/\bfull\b/i, "dense"],
  [/\blayered\b/i, "dense"],
];

const REGISTER_LEXICON: Array<[RegExp, ArrangementInstruction["register"]]> = [
  [/\blow\b/i, "low"],
  [/\bdeep\b/i, "low"],
  [/\bsub\b/i, "low"],
  [/\bhigh\b/i, "high"],
  [/\bbright\b/i, "high"],
  [/\bairy\b/i, "high"],
];

/** Section words the deterministic parser understands. */
const SECTION_WORDS: Record<string, number[]> = {
  // Sections are analyzed as indexed units; words map to relative position.
  intro: [0],
  outro: [-1],
  first: [0],
  last: [-1],
};

function defaultSeed(): number {
  // Stable within a session is unnecessary; the seed is returned explicitly
  // so compositions are reproducible once created.
  return 1_337;
}

export function parsePromptToInstruction(
  prompt: string,
  context: { sectionCount: number },
): PromptInterpretation {
  const interpretation: string[] = [];
  const usedDefaults: string[] = [];
  const unmapped: string[] = [];
  const text = prompt.trim();
  if (text.length === 0) throw new Error("Empty prompt — nothing to interpret.");

  const lower = text.toLowerCase();

  // Instrument
  let instrument: ArrangementInstruction["instrument"] | null = null;
  for (const [word, family] of Object.entries(INSTRUMENT_LEXICON)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(lower)) {
      instrument = family;
      interpretation.push(`Instrument: ${family} (from "${word}").`);
      break;
    }
  }
  if (instrument === null) {
    instrument = "pad";
    usedDefaults.push("instrument");
    unmapped.push("no instrument recognized — defaulted to pad");
  }

  // Mood
  let mood: Mood | null = null;
  for (const [pattern, value] of MOOD_LEXICON) {
    if (pattern.test(text)) {
      mood = value;
      interpretation.push(`Mood: ${value}.`);
      break;
    }
  }
  if (mood === null) {
    mood = "cinematic";
    usedDefaults.push("mood");
    interpretation.push("No mood word found — defaulting to cinematic (say the word to change it).");
  }

  // Density
  let density: ArrangementInstruction["density"] = "medium";
  for (const [pattern, value] of DENSITY_LEXICON) {
    if (pattern.test(text)) {
      density = value;
      interpretation.push(`Density: ${value}.`);
      break;
    }
  }
  if (!DENSITY_LEXICON.some(([pattern]) => pattern.test(text))) {
    usedDefaults.push("density");
    interpretation.push("Density: medium (default).");
  }

  // Register
  let register: ArrangementInstruction["register"] = "mid";
  for (const [pattern, value] of REGISTER_LEXICON) {
    if (pattern.test(text)) {
      register = value;
      interpretation.push(`Register: ${value}.`);
      break;
    }
  }
  if (!REGISTER_LEXICON.some(([pattern]) => pattern.test(text))) {
    usedDefaults.push("register");
    interpretation.push("Register: mid (default).");
  }

  // Sections
  let targetSections: ArrangementInstruction["targetSections"] = "all";
  const sectionWord = Object.keys(SECTION_WORDS).find((word) =>
    new RegExp(`\\b${word}\\b`, "i").test(lower),
  );
  if (sectionWord !== undefined) {
    const relative = SECTION_WORDS[sectionWord];
    const resolved = relative.map((index) =>
      index < 0 ? context.sectionCount + index : index,
    );
    const valid = resolved.filter((index) => index >= 0 && index < context.sectionCount);
    if (valid.length > 0) {
      targetSections = valid;
      interpretation.push(`Sections: ${sectionWord} → section ${valid.join(", ")} of ${context.sectionCount}.`);
    } else {
      interpretation.push(`Asked for "${sectionWord}" but the analysis found no matching section — using all sections.`);
      usedDefaults.push("sections");
    }
  } else {
    interpretation.push("Sections: all (no section word found).");
  }

  // Level
  let level = 0.5;
  if (/\bquiet(ly)?\b|\bsoft(ly)?\b/i.test(text)) {
    level = 0.3;
    interpretation.push("Level: soft.");
  } else if (/\bloud(ly)?\b|\bhard\b/i.test(text)) {
    level = 0.8;
    interpretation.push("Level: loud.");
  }

  const instruction: ArrangementInstruction = ArrangementInstructionSchema.parse({
    format: ARRANGEMENT_INSTRUCTION_FORMAT,
    instrument,
    mood,
    targetSections,
    density,
    register,
    level,
    seed: defaultSeed(),
  });

  return { instruction, interpretation, usedDefaults, unmappedPhrases: unmapped };
}

/**
 * AI-adapter contract: validate a model-produced instruction. Strict —
 * a malformed instruction is rejected, not repaired silently. The caller
 * reports the rejection honestly and falls back to the deterministic
 * parser.
 */
export function validateAiInstruction(raw: unknown): ArrangementInstruction | null {
  const parsed = ArrangementInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.targetSections !== "all" && parsed.data.targetSections.length === 0) return null;
  return parsed.data;
}

export { INSTRUMENT_FAMILIES, MOODS };
