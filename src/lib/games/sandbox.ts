/** One sandbox policy for the Arcade player and its browser publication gate.
 * srcdoc still runs with an opaque origin (allow-scripts, never same-origin).
 * Parent frame-src blocks even obfuscated self-navigation out of srcdoc. */
export const ARCADE_HOST_CSP = "frame-src 'none'; object-src 'none'; base-uri 'self'";
export const GAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function sandboxGameDocument(code: string): string {
  // Trusted policy precedes ALL untrusted markup, including malformed heads.
  // A later policy cannot loosen this one; removing the meta cannot undo it.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${GAME_CSP}"><meta name="referrer" content="no-referrer"></head><body>${code}</body></html>`;
}

export interface GameRuntimeReport {
  policyVersion: 1;
  codeSha256: string;
  ok: boolean;
  status: "passed" | "failed" | "unavailable";
  scope: string;
  issues: string[];
  browser?: string;
  observations?: {
    rendered: boolean;
    visualChange: boolean;
    keyboardInputs: string[];
    pointerInput: boolean;
    blockedRequests: number;
    canvasHashes: string[];
  };
}
