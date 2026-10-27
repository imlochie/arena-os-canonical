import { db } from "@workspace/db";
import { collabs, collabContributions } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import { getStrategy } from "@workspace/arena/lib/strategies";
export async function loadPage(params: Record<string,string>) {
  const { id } = await params;
  const [collab] = await db.select().from(collabs).where(eq(collabs.id, id)).limit(1);
  if (!collab) return Response.json({ error: "Not found" }, { status: 404 });
  const contribs = await db
    .select()
    .from(collabContributions)
    .where(eq(collabContributions.collabId, id))
    .orderBy(asc(collabContributions.round), asc(collabContributions.contribIndex))
    .limit(120);

  const strategy = getStrategy(collab.strategy);
  const drafts = contribs.filter((c) => c.kind === "draft" && c.round === 1);
  const critiques = contribs.filter((c) => c.kind === "critique");
  const rest = contribs.filter((c) => !(c.kind === "draft" && c.round === 1) && c.kind !== "critique" && c.kind !== "synthesis");

  return Response.json({ collab, strategy, drafts, critiques, rest });
}
