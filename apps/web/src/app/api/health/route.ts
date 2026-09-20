import { NextResponse } from "next/server";
import { getPool } from "@waveyard/database";
import { getQueueConnection } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";

export const runtime = "nodejs";
export async function GET() {
  const checks: Record<string, "ok" | "failed"> = {};
  try { await getPool().query("select 1"); checks.database = "ok"; } catch { checks.database = "failed"; }
  try { checks.redis = (await getQueueConnection().ping()) === "PONG" ? "ok" : "failed"; } catch { checks.redis = "failed"; }
  try { await getStorage().healthcheck(); checks.storage = "ok"; } catch { checks.storage = "failed"; }
  const healthy = Object.values(checks).every((status) => status === "ok");
  return NextResponse.json({ ok: healthy, checks }, { status: healthy ? 200 : 503 });
}
