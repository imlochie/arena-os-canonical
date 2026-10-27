/**
 * Waveyard P4 — the Stem2 adapter boundary.
 *
 * The ONLY surface the rest of Waveyard uses to talk to Stem2. Everything
 * behind it is either real (OS audio-output routing, standard media-key
 * receive path) or explicitly unavailable (see the capability matrix in
 * capability.ts and the research in docs/waveyard-stem2-plan.md).
 */
export {
  STEM2_STATES,
  STEM2_CAPABILITY_KEYS,
  type Stem2State,
  type Stem2Endpoint,
  type Stem2Environment,
  type Stem2CapabilityReport,
  type Stem2CapabilityKey,
  type Stem2OutputStatus,
  type Stem2RuntimeState,
} from "./types";
export {
  stem2NameHeuristic,
  resolveOutputStatus,
  stem2CapabilityMatrix,
  describeStem2State,
  type OutputRoutingFacts,
} from "./capability";
export {
  createStem2Routing,
  getStem2Routing,
  installRoutedAudioContext,
  resetStem2RoutingSingleton,
  type Stem2RoutingController,
  type RoutingDeps,
  type AudioContextLike,
  type AudioContextCtor,
  type MediaDevicesLike,
  type StorageLike,
} from "./routing";
export {
  applyHardwareMediaBindings,
  useHardwareMediaKeys,
  type MediaSessionLike,
  type MediaMetadataCtor,
  type HardwareMediaHandlers,
  type HardwareMediaNowPlaying,
} from "./media-session";
