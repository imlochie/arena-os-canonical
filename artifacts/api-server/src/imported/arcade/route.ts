import { db } from "@workspace/db";
import { arcadeGames } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import {
  detectGameType,
  generateGameOffline,
  validateGameCode,
  type GameType,
} from "@workspace/arena/lib/games";
import { insertArcadeGame } from "@workspace/arena/lib/arcadeStore";
import { isEphemeralBody, logPrivacyEvent } from "@workspace/arena/lib/privacy";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { verifyArcadeRuntime } from "./runtime-verification";

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
  const denied = await requireApiAccess(req);
  if (denied) return denied;
  try {
    // Mutations are owner-scoped: every persisted game records who owns it,
    // and unvalidated code is never persisted (the catalogue is a public
    // read surface — arbitrary HTML must not be insertable through it).
    const user = await requireUser();
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
        return Response.json({
          error: "Generated code failed Arcade's static checks and was not published.",
          issues: v.issues,
          draft: code.length <= 120_000 ? {
            code,
            title: prompt.slice(0, 40) || "Unverified game",
            gameType: body.gameType ?? detectGameType(prompt || "ai game"),
            runtimeVerification: { status: "failed", scope: "startup-render-only", issues: v.issues },
          } : undefined,
        }, { status: 422 });
      }
      const gameType = (body.gameType as GameType) ?? detectGameType(prompt || "ai game");
      const runtimeVerification = await verifyArcadeRuntime(code);
      if (runtimeVerification.status !== "passed") {
        return Response.json({
          error: runtimeVerification.status === "unavailable"
            ? "Arcade could not start its isolated browser check. The game was not published."
            : "The game did not pass its isolated startup check. The game was not published.",
          draft: {
            code,
            title: prompt.slice(0, 40) || "Unverified game",
            gameType,
            runtimeVerification,
          },
          runtimeVerification,
        }, { status: 422 });
      }
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
          runtimeVerification,
        });
      }
      const row = await insertArcadeGame(db, {
        prompt: prompt || "on-device AI game",
        gameType,
        engine: "on-device-ai",
        code,
        parentId: parentId ?? null,
        ownerId: user.id,
      });
      return Response.json({ game: row, validation: v, runtimeVerification }, { status: 201 });
    }

    // Path 2: instant offline pipeline (verified core + remix).
    const forceType = (body.gameType as GameType | undefined) || undefined;
    const g = generateGameOffline(prompt, forceType === "arena" && !body.gameType ? undefined : forceType);
    const v = validateGameCode(g.code);
    if (!v.ok) {
      return Response.json({
        error: "Generated code failed Arcade's static checks and was not published.",
        issues: v.issues,
        draft: {
          code: g.code,
          title: g.title,
          gameType: g.gameType,
          runtimeVerification: { status: "failed", scope: "startup-render-only", issues: v.issues },
        },
      }, { status: 422 });
    }
    const runtimeVerification = await verifyArcadeRuntime(g.code);
    if (runtimeVerification.status !== "passed") {
      return Response.json({
        error: runtimeVerification.status === "unavailable"
          ? "Arcade could not start its isolated browser check. The game was not published."
          : "The game did not pass its isolated startup check. The game was not published.",
        draft: { code: g.code, title: g.title, gameType: g.gameType, runtimeVerification },
        runtimeVerification,
      }, { status: 422 });
    }
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
        runtimeVerification,
        ms: g.ms,
      });
    }
    // Persist only code that passed validation — a failed validation must
    // never become a stored "game" the catalogue then serves to everyone.
    const row = await insertArcadeGame(db, {
      prompt,
      gameType: g.gameType,
      engine: g.engine,
      code: g.code,
      parentId: parentId ?? null,
      ownerId: user.id,
    });
    return Response.json({ game: row, validation: v, runtimeVerification, ms: g.ms }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "arcade generation failed" }, { status: 500 });
  }
}
