import { db } from "@/db";
import { battles, battleMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { assignSides, resolveFighters } from "@/lib/battleSetup";
import { generateStream } from "@/lib/stream";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 90;
export const runtime = "nodejs";

// POST → SSE streaming battle. Events:
// {type:"meta", battleId, sampling} · {type:"delta", side:"a"|"b", delta}
// {type:"done", side, ms} · {type:"battle", battle} · {type:"error", error}
export async function POST(req: Request) {
  await ensureSeeded();
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const prompt: string = (body.prompt ?? "").toString().trim();
  const keys = body.keys;
  const localOnly = body.localOnly === true || process.env.FORCE_LOCAL_MODE === "1";
  const genKeys = localOnly ? undefined : keys;
  if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
  if (prompt.length > 4000) return Response.json({ error: "prompt too long" }, { status: 400 });

  let setup;
  try {
    setup = await resolveFighters(body);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "setup failed" }, { status: 500 });
  }
  const { left, right } = assignSides(setup);

  const [battle] = await db
    .insert(battles)
    .values({
      prompt,
      category: setup.category,
      modelAId: left.modelId,
      modelBId: right.modelId,
      assistantAId: left.assistantId ?? null,
      assistantBId: right.assistantId ?? null,
      responseA: "",
      responseB: "",
      latencyA: 0,
      latencyB: 0,
    })
    .returning();
  await db.insert(battleMessages).values({ battleId: battle.id, role: "user", content: prompt });

  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: any) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send({ type: "meta", battleId: battle.id, sampling: setup.sampling, positionRandomized: true });
      let fullA = "";
      let fullB = "";
      try {
        const runSide = async (
          side: "a" | "b",
          modelId: string,
          sys: string,
          acc: { t: string }
        ) => {
          const t0 = Date.now();
          for await (const chunk of generateStream({
            modelId,
            messages: [{ role: "user", content: prompt }],
            system: sys,
            keys: genKeys,
            localOnly,
          })) {
            acc.t += chunk;
            send({ type: "delta", side, delta: chunk });
          }
          send({ type: "done", side, ms: Date.now() - t0 });
        };
        const accA = { t: "" };
        const accB = { t: "" };
        await Promise.all([
          runSide("a", left.modelId, left.sys, accA),
          runSide("b", right.modelId, right.sys, accB),
        ]);
        fullA = accA.t;
        fullB = accB.t;
        const totalMs = Date.now() - started;
        await db
          .update(battles)
          .set({ responseA: fullA, responseB: fullB, latencyA: totalMs, latencyB: totalMs })
          .where(eq(battles.id, battle.id));
        await db.insert(battleMessages).values([
          { battleId: battle.id, role: "a", content: fullA },
          { battleId: battle.id, role: "b", content: fullB },
        ]);
        const [final] = await db.select().from(battles).where(eq(battles.id, battle.id)).limit(1);
        send({
          type: "battle",
          battle: {
            id: final.id,
            prompt: final.prompt,
            category: final.category,
            responseA: fullA,
            responseB: fullB,
            latencyA: totalMs,
            latencyB: totalMs,
            createdAt: final.createdAt,
            sampling: setup.sampling,
            positionRandomized: true,
          },
        });
      } catch (e) {
        console.error("stream error", e);
        // Best-effort persist of partials
        try {
          await db
            .update(battles)
            .set({
              responseA: fullA || "⚠️ Stream interrupted — retry the battle.",
              responseB: fullB || "⚠️ Stream interrupted — retry the battle.",
            })
            .where(eq(battles.id, battle.id));
        } catch {}
        send({ type: "error", error: "stream failed" });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
