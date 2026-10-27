/**
 * Mutation gate for the local-first deployment (bug & security sweep).
 *
 * The product serves over http://127.0.0.1:<random port> (desktop runtime)
 * or localhost in dev. Any *website* the user has open in their browser can
 * fire requests at that port. JSON POSTs are naturally protected (a JSON
 * content-type forces a CORS preflight, which we never approve), but
 * "simple" content types — multipart/form-data, text/plain — are sent
 * WITHOUT preflight, so a malicious page could otherwise mutate local state
 * (upload junk audio, create projects) and pollute the user's library.
 *
 * Rules (allowlist, browser-typed):
 *  - GET/HEAD/OPTIONS always pass (reads are same-origin-only readable).
 *  - Sec-Fetch-Site: cross-site (any modern browser, including Electron's
 *    Chromium) → rejected outright.
 *  - An Origin header that does not match the request Host → rejected.
 *  - Non-browser clients (curl, node fetch, Playwright's APIRequestContext,
 *    the worker) send neither header → allowed. They are not CSRF-capable.
 *
 * Legitimate app traffic is always same-origin (the UI uses relative URLs),
 * so the gate is invisible to the product. A reverse-proxy deployment that
 * rewrites Host would need this revisited — the documented deployments
 * (desktop, dev, single-origin web) do not. Tests: local-request-gate.test.ts.
 */

export type GateRequest = {
  method: string;
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
};

export function isLocalMutationAllowed(request: GateRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const site = request.secFetchSite?.toLowerCase() ?? null;
  if (site === "cross-site") return false;

  if (request.origin !== null && request.origin !== "") {
    // A browser sent this: it must be same-origin with the Host it addressed.
    if (request.host === null || request.host === "") return false;
    let parsed: URL;
    try {
      parsed = new URL(request.origin);
    } catch {
      return false;
    }
    if (parsed.host.toLowerCase() !== request.host.toLowerCase()) return false;
  }
  return true;
}
