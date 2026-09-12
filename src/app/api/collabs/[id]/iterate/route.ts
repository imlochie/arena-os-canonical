import { db } from "@/db";
import { collabs, collabContributions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generate } from "@/lib/ai";
import { getStrategy, resolveCollaborator } from "@/lib/collab";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → next thinking pass: new instruction → fresh parallel takes → new synthesis
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const instruction: string = (body.instruction ?? "").toString().trim();
    const keys = body.keys;
    if (!instruction) return Response.json({ error: "instruction required" }, { status: 400 });
    if (instruction.length > 4000) return Response.json({ error: "too long" }, { status: 400 });

    const [collab] = await db.select().from(collabs).where(eq(collabs.id, id)).limit(1);
    if (!collab) return Response.json({ error: "not found" }, { status: 404 });
    if ((collab.rounds ?? 1) >= 6) {
      return Response.json({ error: "pass limit reached (6) — start a fresh challenge" }, { status: 400 });
    }

    const strategy = getStrategy(collab.strategy);
    const stored: any[] = JSON.parse(collab.collaborators || "[]");
    const resolved = [];
    for (const s of stored) {
      const c = await resolveCollaborator({ type: s.type, id: s.type === "assistant" ? s.assistantId ?? s.id : s.modelId ?? s.id }, s.role);
      if (c) resolved.push(c);
    }
    if (resolved.length < 2) return Response.json({ error: "collaborators unavailable" }, { status: 400 });

    const nextRound = (collab.rounds ?? 1) + 1;

    const takes = await Promise.all(
      resolved.map((c) =>
        generate({
          modelId: c.modelId,
          messages: [
            {
              role: "user",
              content: `ORIGINAL CHALLENGE:\n${collab.challenge.slice(0, 2500)}\n\nCURRENT BEST RESULT:\n${collab.synthesis.slice(0, 4000)}\n\nHUMAN'S NEW DIRECTION (pass ${nextRound}):\n${instruction}\n\nRespond as ${c.label} (${c.role}): apply the direction, improve the result. Markdown, concrete.`,
            },
          ],
          system: c.sys,
          keys,
          localOnly: body.localOnly === true,
        })
      )
    );

    const material = resolved
      .map((c, i) => `--- ${c.emoji} ${c.label} (${c.role}) ---\n${takes[i].text.slice(0, 2400)}`)
      .join("\n\n");
    const synth = await generate({
      modelId: collab.synthesisModel,
      messages: [
        {
          role: "user",
          content: `CHALLENGE:\n${collab.challenge.slice(0, 2000)}\n\nPREVIOUS BEST:\n${collab.synthesis.slice(0, 3500)}\n\nHUMAN DIRECTION:\n${instruction}\n\nFRESH TAKES:\n${material.slice(0, 10000)}`,
        },
      ],
      system: `${strategy.synthesisInstruction}\n\nThis is iteration pass ${nextRound}: preserve what the human liked, apply their direction decisively, and output the new single best result.`,
      temperature: 0.5,
      keys,
      localOnly: body.localOnly === true,
    });

    await db.update(collabs).set({ synthesis: synth.text, rounds: nextRound }).where(eq(collabs.id, id));
    await db.insert(collabContributions).values({
      collabId: id,
      round: nextRound,
      contribIndex: -2,
      kind: "user",
      label: "🧑 Human direction",
      modelId: "human",
      content: instruction,
    });
    const rows: (typeof collabContributions.$inferInsert)[] = resolved.map((c, i) => ({
      collabId: id,
      round: nextRound,
      contribIndex: i,
      kind: "draft",
      label: `${c.emoji} ${c.label} · ${c.role}`,
      modelId: c.modelId,
      assistantId: c.assistantId ?? null,
      content: takes[i].text,
      latencyMs: takes[i].ms,
    }));
    rows.push({
      collabId: id,
      round: nextRound,
      contribIndex: -1,
      kind: "synthesis",
      label: "💎 Synthesis (updated)",
      modelId: collab.synthesisModel,
      content: synth.text,
      latencyMs: synth.ms,
    });
    await db.insert(collabContributions).values(rows);

    return Response.json({ round: nextRound, synthesis: synth.text });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "iterate failed" }, { status: 500 });
  }
}
