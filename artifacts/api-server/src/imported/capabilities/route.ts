

import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { buildCapabilityReport } from "@workspace/arena/lib/capabilities/report";
import { realCapabilityProbes } from "@workspace/arena/lib/capabilities/probes";

export const dynamic = "force-dynamic";

/** READY / DEGRADED / UNAVAILABLE per dependency, with path, version and remediation. */
export async function GET(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  return Response.json(await buildCapabilityReport(realCapabilityProbes()), { headers: { "cache-control": "no-store" } });
}
