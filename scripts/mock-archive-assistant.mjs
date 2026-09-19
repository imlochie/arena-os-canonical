/**
 * mock-archive-assistant.mjs — a small DEVELOPMENT fixture that answers the
 * six read-only Archive Assistant endpoints from the committed test
 * fixtures (src/lib/archive-assistant/fixtures.ts).
 *
 * It exists so the full bridge can be exercised end-to-end — real client,
 * real generated-contract validators, real normalizers, real routes —
 * before a live Archive Assistant deployment is reachable. It is NOT
 * Archive Assistant: no database, no auth enforcement (any Bearer is
 * accepted; browser access is plain HTTP on loopback), and every response
 * is fixture data.
 *
 * Usage:
 *   node --import ./scripts/register-src-loader.mjs scripts/mock-archive-assistant.mjs [port]
 *   # default port 4017, binds 127.0.0.1
 *
 * Then point the bridge at it:
 *   ARCHIVE_ASSISTANT_API_URL=http://127.0.0.1:4017/api
 *   npm run smoke:archive -- --token dev-token --history --lineage 42
 */

import { createServer } from "node:http";
import {
  JELLYFIN_HISTORY,
  JELLYFIN_STATE_FAILED_UNKNOWN,
  LINEAGE,
  OVERVIEW,
  PLEX_HISTORY,
  PLEX_HISTORY_ORDINARY,
  PLEX_STATE_ORDINARY_AUTHORITY,
  PLEX_STATE_PARTIAL_FAILURE,
  RECONCILIATION_REPORT,
  WORKLOAD,
} from "../src/lib/archive-assistant/fixtures.ts";

/** Scenario toggle for the reasoning lab (docs/archive-reasoning-lab-001.md):
 *    trap     (default) r18 partial non-authoritative over authoritative r17
 *             — the disappearance trap (Run A);
 *    ordinary           complete authoritative r19 observing fewer items than
 *             the previous authority — authoritative contrast (Run B).
 *  Only plex refresh state/history varies; everything else stays fixed. */
const scenario = (process.env.AA_SCENARIO ?? "trap").trim().toLowerCase();
if (scenario !== "trap" && scenario !== "ordinary") {
  console.error(`AA_SCENARIO must be "trap" or "ordinary" (got "${scenario}").`);
  process.exit(2);
}
const plexState = scenario === "ordinary" ? PLEX_STATE_ORDINARY_AUTHORITY : PLEX_STATE_PARTIAL_FAILURE;
const plexHistory = scenario === "ordinary" ? PLEX_HISTORY_ORDINARY : PLEX_HISTORY;

const port = Number(process.argv[2] ?? 4017);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: mock-archive-assistant.mjs [port]");
  process.exit(2);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  const path = url.pathname;
  if (path.endsWith("/assistant/overview")) return send(200, OVERVIEW);
  if (path.endsWith("/assistant/workload")) return send(200, WORKLOAD);
  if (path.endsWith("/archive/reconciliation")) return send(200, RECONCILIATION_REPORT);

  const lineageMatch = /\/archive\/reconciliation\/findings\/(\d+)\/lineage$/.exec(path);
  if (lineageMatch) {
    return Number(lineageMatch[1]) === 42
      ? send(200, LINEAGE)
      : send(404, { error: "Finding not found" });
  }

  if (path.endsWith("/provider/refresh/history")) {
    const provider = url.searchParams.get("provider");
    if (provider === "plex") return send(200, plexHistory);
    if (provider === "jellyfin") return send(200, JELLYFIN_HISTORY);
    return send(400, { error: "Provider must be plex or jellyfin." });
  }
  if (path.endsWith("/provider/refresh")) {
    const provider = url.searchParams.get("provider");
    if (provider === "plex") return send(200, plexState);
    if (provider === "jellyfin") return send(200, JELLYFIN_STATE_FAILED_UNKNOWN);
    return send(400, { error: "Provider must be plex or jellyfin." });
  }

  return send(404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock archive assistant (DEV FIXTURE — fixture data, no auth) listening on http://127.0.0.1:${port}/api`);
  console.log(
    scenario === "ordinary"
      ? "scenario=ordinary: plex authority r19 (complete, 35,802 items) after r17 (35,890); jellyfin authority jf-r08 with failed unknown attempt jf-r09; finding lineage at reviewItemId 42."
      : "scenario=trap: plex authority r17 (35,890 items) with failed partial attempt r18; jellyfin authority jf-r08 with failed unknown attempt jf-r09; finding lineage at reviewItemId 42.",
  );
});
