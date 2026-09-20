// Health check. Deliberately shallow: it proves the process is up and the
// database answers, and nothing else. A health endpoint that runs business
// logic becomes a way to trigger business logic from outside.
//
// It is intentionally unauthenticated — monitoring cannot hold a device token
// — so it must never leak the connection string or any institutional state.
//
// The one thing it does beyond liveness: it refuses to report a healthy
// College that is standing open. An unauthenticated API on a public hostname
// is not a warning to note and move past; it is the exact condition Layer 9
// exists to prevent. So the endpoint fails loudly rather than returning
// ok:true with a caveat buried in a field nobody reads at 11pm.
import { pool } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Is this request arriving from somewhere other than the machine the server
 * runs on? Mirrors the guard's reasoning: the Host header is what actually
 * distinguishes a developer on localhost from the public internet, and a
 * non-loopback hop in the forwarded chain means the request travelled.
 *
 * Kept local rather than imported so the health check has no dependency on
 * the guard's internals — if that module ever breaks, this still answers.
 */
function looksPublic(req: Request): boolean {
  const h = req.headers;
  const host = (h.get("host") ?? "").split(":")[0];
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!hostIsLocal) return true;

  const hops = `${h.get("x-forwarded-for") ?? ""},${h.get("x-real-ip") ?? ""}`
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return hops.some(
    (ip) => ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1"
  );
}

export async function GET(req: Request) {
  const started = Date.now();
  const strict = process.env.COLLEGE_AUTH_MODE === "strict";
  const httpsHint = (req.headers.get("x-forwarded-proto") ?? "").includes("https");

  try {
    await pool.query("select 1");
  } catch {
    // Failure must be explicit and must not leak the connection string.
    return Response.json(
      { ok: false, status: "DATABASE UNREACHABLE", database: "unreachable" },
      { status: 503 }
    );
  }

  const exposed = looksPublic(req) && !strict;

  if (exposed) {
    // 503, not 200-with-a-note. A load balancer should refuse to bring this
    // instance into service, and a deploy script checking for a 2xx should
    // fail. Being loudly broken is safer than being quietly open.
    return Response.json(
      {
        ok: false,
        status: "REFUSING TO REPORT HEALTHY",
        database: "reachable",
        authMode: "development",
        error:
          "This College is reachable from outside and COLLEGE_AUTH_MODE is not set to strict.",
        consequence:
          "Every College route is answering unauthenticated callers right now. Curriculum, faculty, the timetable, the event ledger and bootstrap are all writable by anyone who can reach this address.",
        remedy:
          "Set COLLEGE_AUTH_MODE=strict in the environment and restart. Then re-check this endpoint: it must report authMode \"strict\".",
      },
      { status: 503 }
    );
  }

  return Response.json({
    ok: true,
    database: "reachable",
    authMode: strict ? "strict" : "development",
    // Surfaced rather than enforced: tokens travel in an Authorization header,
    // so plain HTTP leaks them. The College cannot reliably detect its own
    // TLS termination, so this reports what the proxy claimed.
    transport: httpsHint ? "https" : "unverified",
    ms: Date.now() - started,
  });
}
