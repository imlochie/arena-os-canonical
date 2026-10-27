/** Directory names that must never appear inside the staged server. */
export declare const FORBIDDEN_DIR_NAMES: Set<string>;
/** Find packaging-output contamination (empty array = clean). */
export declare function findPackagingContamination(
  root: string,
): Array<{ path: string; reason: string }>;
/** Throw (actionable message) if the staged tree contains packaging output. */
export declare function assertStagedTreeClean(root: string): void;
