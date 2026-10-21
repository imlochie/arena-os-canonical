import { exec } from "../audio";
import { bounceInsertBuses as bounce } from "../../../../waveyard-worker/packages/dsp/src/bounce";
export { MAX_INSERT_BOUNCE_SECONDS, insertBounceRequired } from "../../../../waveyard-worker/packages/dsp/src/bounce";
export function bounceInsertBuses(options: Omit<Parameters<typeof bounce>[0], "exec">) { return bounce({ ...options, exec }); }
