import { db } from "@/db";
import { arcadeGames } from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  detectGameType,
  generateGameOffline,
  validateGameCode,
  type GameType,
} from "@/lib/games";
import { isEphemeralBody, logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Arcade Forge is offline-by-design: generation NEVER touches the cloud.
// Engines: verified cores + parametric remix (server, instant) and
// on-device AI (runs in the visitor's browser via WebGPU).

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const full = url.searchParams.get("full") === "1";
  try {
    const rows = await db.select().from(arcadeGames).orderBy(desc(arcadeGames.createdAt)).limit(limit);
    if (full) return Response.json({ games: rows });
    return Response.json({
      games: rows.map((r) => ({
        id: r.id,
        prompt: r.prompt,
        gameType: r.gameType,
        engine: r.engine,
        parentId: r.parentId,
        bytes: r.code.length,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    console.error(e);
    return Response.json({ games: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const prompt: string = (body.prompt ?? "").toString().trim();
    const ephemeral = isEphemeralBody(body);
    const parentId: string | undefined = body.parentId;

    if (!prompt && !body.clientCode) {
      return Response.json({ error: "prompt required" }, { status: 400 });
    }
    if (prompt.length > 2000) return Response.json({ error: "prompt too long" }, { status: 400 });

    // Path 1: client ran on-device AI in-browser → validate + persist code.
    if (body.clientCode) {
      const code = String(body.clientCode);
      const v = validateGameCode(code);
      if (!v.ok) {
        return Response.json({ error: "generated code failed validation", issues: v.issues }, { status: 400 });
      }
      const gameType = (body.gameType as GameType) ?? detectGameType(prompt || "ai game");
      if (ephemeral) {
        await logPrivacyEvent("ephemeral_arcade", `engine=on-device-ai type=${gameType}`);
        return Response.json({
          game: {
            id: `ephemeral-${Date.now().toString(36)}`,
            ephemeral: true,
            prompt: prompt || "on-device AI game",
            gameType,
            engine: "on-device-ai",
            code,
            createdAt: new Date().toISOString(),
          },
          validation: v,
        });
      }
      const [row] = await db
        .insert(arcadeGames)
        .values({ prompt: prompt || "on-device AI game", gameType, engine: "on-device-ai", code, parentId: parentId ?? null })
        .returning();
      return Response.json({ game: row, validation: v }, { status: 201 });
    }

    // Path 2: instant offline pipeline (verified core + remix).
    const forceType = (body.gameType as GameType | undefined) || undefined;
    const g = generateGameOffline(prompt, forceType === "arena" && !body.gameType ? undefined : forceType);
    const v = validateGameCode(g.code);
    if (ephemeral) {
      await logPrivacyEvent("ephemeral_arcade", `engine=${g.engine} type=${g.gameType}`);
      return Response.json({
        game: {
          id: `ephemeral-${Date.now().toString(36)}`,
          ephemeral: true,
          prompt,
          gameType: g.gameType,
          engine: g.engine,
          code: g.code,
          createdAt: new Date().toISOString(),
        },
        validation: v,
        ms: g.ms,
      });
    }
    const [row] = await db
      .insert(arcadeGames)
      .values({ prompt, gameType: g.gameType, engine: g.engine, code: g.code, parentId: parentId ?? null })
      .returning();
    return Response.json({ game: row, validation: v, ms: g.ms }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "arcade generation failed" }, { status: 500 });
  }
}
