import type { MashupSourceProfile } from "./mashup";
import { unavailableEvidence } from "./musical-evidence";

/**
 * Source identity survives a stem edit; measurements of its previous mix do
 * not. Clear both representations before measuring the changed composition,
 * otherwise profileFromCurrentEvidence can silently restore removed material.
 *
 * This is deliberately not a compatibility classifier. Unknown evidence must
 * remain unknown while the existing continuous-placement fallback stays usable.
 */
export function invalidateCompositionEvidence(
  profile: MashupSourceProfile,
  changedStemTypes: readonly string[],
): MashupSourceProfile {
  if (changedStemTypes.length === 0) return profile;
  const reason = `The composition changed (${[...new Set(changedStemTypes)].sort().join(", ")}); previous mix measurements are not current composition evidence.`;
  return {
    ...profile,
    bpm: null,
    bpmConfidence: null,
    bpmCandidates: null,
    musicalKey: null,
    keyConfidence: null,
    beatGridMs: null,
    beatConfidence: null,
    downbeatGridMs: null,
    downbeatConfidence: null,
    sections: [],
    harmonyEvents: [],
    harmonyEvidenceSource: undefined,
    harmonyEvidenceStemType: undefined,
    drumEvents: [],
    bassEvents: [],
    vocalPhrases: [],
    vocalActivityIntervals: [],
    vocalPitchFrames: [],
    evidence: profile.evidence ? {
      ...profile.evidence,
      features: {
        tempo: unavailableEvidence(reason),
        key: unavailableEvidence(reason),
        beatGrid: unavailableEvidence(reason),
        sections: unavailableEvidence(reason),
        harmony: unavailableEvidence(reason),
        drumEvents: unavailableEvidence(reason),
        bassAttacks: unavailableEvidence(reason),
        vocalPhrases: unavailableEvidence(reason),
        vocalActivityIntervals: unavailableEvidence(reason),
        vocalPitchFrames: unavailableEvidence(reason),
      },
    } : undefined,
    grooveWarnings: [...(profile.grooveWarnings ?? []), reason],
  };
}
