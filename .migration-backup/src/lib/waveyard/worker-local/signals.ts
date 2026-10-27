/**
 * Desktop-mode process signal wiring (nodejs runtime only).
 *
 * Imported dynamically from instrumentation.ts AFTER the runtime check, so
 * the Edge bundler never sees Node-only API calls in the instrumentation
 * entry module.
 */

import { drainLocalWorker } from "./index";

export function wireDesktopSignals(): void {
  process.once("SIGTERM", () => {
    void drainLocalWorker(10_000);
  });
}
