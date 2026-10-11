import { bootstrapCollege } from "@/lib/college/bootstrap";
import { computeCollegeState } from "@/lib/college/state";
import { guard, refuse } from "@/lib/college/guard";

export const dynamic = "force-dynamic";

// POST → seed verified institutional canon (idempotent).
// Only seeds what fetched sources actually support; reports what it refused
// to invent in `notes`.
export async function POST(req: Request) {
  const _g = await guard(req, "bootstrap");
  if (!_g.ok) return refuse(_g);

  try {
    const result = await bootstrapCollege();
    const state = await computeCollegeState();
    return Response.json({ ok: true, ...result, state }, { status: 201 });
  } catch (e) {
    console.error("college bootstrap error", e);
    return Response.json(
      { error: "bootstrap failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
