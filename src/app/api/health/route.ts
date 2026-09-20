// Health check. Deliberately shallow: it proves the process is up and the
// database answers, and nothing else. A health endpoint that runs business
// logic becomes a way to trigger business logic from outside.
import { pool } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await pool.query("select 1");
    return Response.json({
      ok: true,
      database: "reachable",
      authMode: process.env.COLLEGE_AUTH_MODE === "strict" ? "strict" : "development",
      ms: Date.now() - started,
    });
  } catch {
    // Failure must be explicit and must not leak the connection string.
    return Response.json({ ok: false, database: "unreachable" }, { status: 503 });
  }
}
