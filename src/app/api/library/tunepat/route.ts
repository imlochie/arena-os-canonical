import { z } from "zod";
import { requireApiAccess } from "@/lib/security/api-access";
import { authenticatedRequestIdentity, assertSameOrigin } from "@/lib/requestIdentity";
import { FRESH_AUTH_WINDOW_MS } from "@/lib/authorization";
import { requireUser } from "@/lib/waveyard/local-context";
import { tunePatStatus, launchTunePat } from "@/lib/waveyard/conversion/tunepat";
export const runtime = "nodejs";
const schema = z.object({ action: z.enum(["status", "launch"]), path: z.string().max(2048), confirm: z.boolean().optional() }).strict();
export async function POST(request: Request) {
  const denied = await requireApiAccess(request); if (denied) return denied;
  try {
    assertSameOrigin(request);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 4096) return Response.json({ error: "Tool request too large." }, { status: 413 });
    const reader=request.body?.getReader();let bytes=0;const chunks=[];if(reader)for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>4096){await reader.cancel();return Response.json({error:"Tool request too large."},{status:413});}chunks.push(Buffer.from(part.value));}
    const input = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (input.action === "status") return Response.json(await tunePatStatus(input.path));
    if (!input.confirm || process.env.ARENA_DESKTOP_MODE !== "1") return Response.json({ error: "Explicit owner confirmation in the local desktop runtime is required for external process launch." }, { status: 403 });
    const identity = await authenticatedRequestIdentity(request);
    if (identity.ownerId !== (await requireUser()).id || !identity.freshVerifiedAt || Date.now() - identity.freshVerifiedAt.getTime() > FRESH_AUTH_WINDOW_MS) return Response.json({ error: "Fresh owner authentication required to launch an external application." }, { status: 403 });
    return Response.json(await launchTunePat(input.path));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Tool operation failed; no output claimed." }, { status: 422 }); }
}
