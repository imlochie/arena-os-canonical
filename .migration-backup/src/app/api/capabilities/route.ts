import { NextResponse } from "next/server";

import { requireApiAccess } from "@/lib/security/api-access";
import { buildCapabilityReport } from "@/lib/capabilities/report";
import { realCapabilityProbes } from "@/lib/capabilities/probes";

export const dynamic = "force-dynamic";

/** READY / DEGRADED / UNAVAILABLE per dependency, with path, version and remediation. */
export async function GET(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  return NextResponse.json(await buildCapabilityReport(realCapabilityProbes()), { headers: { "cache-control": "no-store" } });
}
