/** Minimal structural shape of an in-app acceptance report
 * (desktop/acceptance.ts) as consumed by the recovery verdict. */
export declare interface RecoveryStep {
  name: string;
  ok: boolean;
  info?: string;
}
export declare interface RecoverySection {
  ok: boolean;
  steps: RecoveryStep[];
}
export declare interface RecoveryReport {
  ok?: boolean;
  error?: string;
  sections: Record<string, RecoverySection>;
}
/** firstLaunch step that is a first-ever-launch invariant only. */
export declare const FIRST_RUN_INVARIANT_STEP: string;
/** firstLaunch steps a recovery launch MUST still pass. */
export declare const REQUIRED_FIRST_LAUNCH_STEPS: string[];
/** Every section the in-app acceptance emits; all required on recovery. */
export declare const REQUIRED_RECOVERY_SECTIONS: string[];
/** Evaluate a recovery-launch acceptance report. */
export declare function evaluateRecovery(
  body: RecoveryReport | null | undefined,
): { ok: boolean; failures: string[]; exempted: string[] };
