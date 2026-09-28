import { db } from "@/db";
import { battles } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Transparency export (LMArena publishes vote data; so do you — it's yours).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toString();
  const votedOnly = url.searchParams.get("votedOnly") === "1";
  try {
    let rows = await db.select().from(battles).orderBy(desc(battles.createdAt)).limit(1000);
    if (votedOnly) rows = rows.filter((r) => r.winner);
    if (format === "csv") {
      const esc = (s: string | null) => `"${(s ?? "").replace(/"/g, '""').slice(0, 2000)}"`;
      const header = "id,created_at,category,model_a,model_b,winner,latency_a_ms,latency_b_ms,prompt,response_a,response_b";
      const lines = rows.map((r) =>
        [
          r.id,
          r.createdAt?.toISOString() ?? "",
          r.category,
          r.modelAId,
          r.modelBId,
          r.winner ?? "",
          r.latencyA,
          r.latencyB,
          esc(r.prompt),
          esc(r.responseA),
          esc(r.responseB),
        ].join(",")
      );
      return new Response([header, ...lines].join("\n"), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=arenaforge-votes.csv",
        },
      });
    }
    return Response.json({
      exportedAt: new Date().toISOString(),
      count: rows.length,
      methodology: {
        rating: "online Elo K=32 + Bradley-Terry MLE refit",
        scale: "100 Elo ≈ 64% expected win rate",
        voteOptions: ["a", "b", "tie", "both-bad"],
        bothBadHandling: "excluded from Bradley-Terry fit, small Elo penalty in online update",
        blinding: "model identities hidden until vote; A/B sides position-randomized",
      },
      battles: rows,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "export failed" }, { status: 500 });
  }
}
