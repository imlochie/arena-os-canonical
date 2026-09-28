import { db } from "@/db";
import { battles, battleMessages } from "@/db/schema";
import { desc } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { assignSides, resolveFighters } from "@/lib/battleSetup";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent, sealReveal } from "@/lib/privacy";
import { getProjectContext, withProjectContext } from "@/lib/projectContext";
import { ensureSeeded } from "@/lib/seed";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

// GET → recent battles (history)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const category = url.searchParams.get("category");
  try {
    const rows = await db.select().from(battles).orderBy(desc(battles.createdAt)).limit(100);
    const filtered = category ? rows.filter((r) => r.category === category) : rows;
    // Hide model identities for unvoted battles (blind arena rule)
    const masked = filtered.slice(0, limit).map((r) =>
      r.winner ? r : { ...r, modelAId: "???", modelBId: "???", assistantAId: null, assistantBId: null }
    );
    return Response.json({ battles: masked });
  } catch (e) {
    console.error(e);
    return Response.json({ battles: [] });
  }
}

// POST → run a new blind battle (non-streaming; /api/battles/stream streams)
// Privacy: localOnly → zero-egress on-device generation; ephemeral →
// nothing is persisted (sealed reveal token keeps the battle blind).
export async function POST(req: Request) {
  try {
    await ensureSeeded();
    const body = await req.json();
    const prompt: string = (body.prompt ?? "").toString().trim();
    const keys = body.keys;
    const imageSize: string | undefined = body.imageSize;
    const localOnly = isLocalOnlyBody(body);
    const ephemeral = isEphemeralBody(body);

    if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
    if (prompt.length > 4000) return Response.json({ error: "prompt too long" }, { status: 400 });

    const setup = await resolveFighters(body);
    const { left, right } = assignSides(setup);
    const genKeys = localOnly ? undefined : keys;
    const projectId = body.projectId ? String(body.projectId) : null;
    const ctx = await getProjectContext(projectId);
    const effectivePrompt = withProjectContext(prompt, ctx);

    const [rA, rB] = await Promise.all([
      generate({ modelId: left.modelId, messages: [{ role: "user", content: effectivePrompt }], system: left.sys, keys: genKeys, imageSize, category: setup.category, localOnly }),
      generate({ modelId: right.modelId, messages: [{ role: "user", content: effectivePrompt }], system: right.sys, keys: genKeys, imageSize, category: setup.category, localOnly }),
    ]);

    if (ephemeral) {
      // Nothing touches the database. Blindness preserved via sealed token.
      const revealToken = sealReveal({
        a: left.modelId,
        b: right.modelId,
        aa: left.assistantId ?? null,
        bb: right.assistantId ?? null,
        exp: Date.now() + 1000 * 60 * 60 * 6,
      });
      await logPrivacyEvent("ephemeral_battle", `category=${setup.category} localOnly=${localOnly}`);
      return Response.json({
        battle: {
          id: `ephemeral-${Date.now().toString(36)}`,
          ephemeral: true,
          revealToken,
          prompt,
          category: setup.category,
          responseA: rA.text,
          responseB: rB.text,
          latencyA: rA.ms,
          latencyB: rB.ms,
          createdAt: new Date().toISOString(),
          viaA: rA.via,
          viaB: rB.via,
          sampling: setup.sampling,
          positionRandomized: true,
          localOnly,
        },
      });
    }

    const inserted = await db
      .insert(battles)
      .values({
        prompt,
        category: setup.category,
        modelAId: left.modelId,
        modelBId: right.modelId,
        assistantAId: left.assistantId ?? null,
        assistantBId: right.assistantId ?? null,
        responseA: rA.text,
        responseB: rB.text,
        latencyA: rA.ms,
        latencyB: rB.ms,
        projectId,
      })
      .returning();
    if (projectId) {
      await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    }

    const battle = inserted[0];
    // Seed the multi-turn thread
    await db.insert(battleMessages).values([
      { battleId: battle.id, role: "user", content: prompt },
      { battleId: battle.id, role: "a", content: rA.text },
      { battleId: battle.id, role: "b", content: rB.text },
    ]);

    // Return blind: do NOT reveal model ids until vote
    return Response.json({
      battle: {
        id: battle.id,
        prompt: battle.prompt,
        category: battle.category,
        responseA: battle.responseA,
        responseB: battle.responseB,
        latencyA: battle.latencyA,
        latencyB: battle.latencyB,
        createdAt: battle.createdAt,
        viaA: rA.via,
        viaB: rB.via,
        sampling: setup.sampling,
        positionRandomized: true,
        localOnly,
      },
    });
  } catch (e) {
    console.error("battle error", e);
    return Response.json({ error: "battle failed" }, { status: 500 });
  }
}
