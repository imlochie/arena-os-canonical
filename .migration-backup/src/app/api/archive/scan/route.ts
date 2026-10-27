import { scanInbox } from "@/lib/archive";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// POST → scan inbox items (AI describe/tag/categorize, near-dupe flags):
// {keys?, localOnly?, limit?}
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await scanInbox({
      keys: body.localOnly ? undefined : body.keys,
      localOnly: Boolean(body.localOnly),
      limit: Number(body.limit ?? 8) || 8,
    });
    return Response.json(result);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "scan failed" }, { status: 500 });
  }
}
