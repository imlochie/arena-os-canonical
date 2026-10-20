import { db } from "@/db";
import { arcadeGames } from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  detectGameType,
  generateGameOffline,
  validateGameCode,
  type GameType,
} from "@/lib/games";
import { insertArcadeGame } from "@/lib/arcadeStore";
import { isEphemeralBody, logPrivacyEvent } from "@/lib/privacy";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireApiAccess } from "@/lib/security/api-access";
import { validateGameRuntime } from "@/lib/games/runtime-validation";
import { beginAttempt, checkpointAttempt, finishAttempt } from "@/lib/games/attempts";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Arcade Forge is offline-by-design: generation NEVER touches the cloud.
// Engines: verified cores + parametric remix (server, instant) and
// on-device AI (runs in the visitor's browser via WebGPU).

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 50)) : 20;
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
    return Response.json({ error: "Game library unavailable. Saved games were not removed; retry when the database is available." }, { status: 503 });
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
        return Response.json({ error: "generated code failed validation", issues: v.issues }, { status: 400 });
      }
      const gameType = (body.gameType as GameType) ?? detectGameType(prompt || "ai game") ?? "custom";
      // A client may label a verified core only if its bytes match that core.
      let engine = "on-device-ai";
      if (body.engine === "verified" || body.engine === "remix") {
        try {
          const core = generateGameOffline(prompt, body.gameType);
          if (core.code === code) engine = core.engine;
        } catch { /* custom code remains on-device-ai */ }
      }
      // Byte-identical built-in cores retain their trusted offline path.
      // Arbitrary on-device/client HTML cannot bypass the browser gate.
      if (engine === "on-device-ai") {
        const draft = { code, validation: v, runtime: { modelId: "client-reported-on-device", backend: "browser", ms: 0 } };
        let cursor;
        if (!ephemeral) {
          const begun = await beginAttempt(user.id, body.attemptId ?? randomUUID(), prompt || "Client game", parentId);
          if (!begun.created) return Response.json({ error: "Attempt already exists; inspect or retry saving its exact retained bytes.", attemptId: begun.cursor.id }, { status: 409 });
          cursor = await checkpointAttempt(begun.cursor, { state: "validated" }, draft);
        }
        const runtimeValidation = await validateGameRuntime(code);
        if (!runtimeValidation.ok) {
          if (cursor) await checkpointAttempt(cursor, { state: "failed", error: runtimeValidation.issues.join("; ") }, { ...draft, runtimeValidation });
          return Response.json({ error: runtimeValidation.issues.join("; "), draft: { ...draft, runtimeValidation }, attemptId: cursor?.id }, { status: runtimeValidation.status === "unavailable" ? 503 : 422 });
        }
        if (cursor) {
          const game = await finishAttempt(cursor, code, gameType, engine, runtimeValidation);
          return Response.json({ game, validation: v, runtimeValidation, attemptId: cursor.id }, { status: 201 });
        }
        // Ephemeral still needs runtime verification, but never writes a draft.
        return Response.json({ game: { id: `ephemeral-${Date.now().toString(36)}`, ephemeral: true, prompt, gameType, code, engine }, runtimeValidation });
      }
      if (ephemeral) {
        await logPrivacyEvent("ephemeral_arcade", `engine=${engine} type=${gameType}`);
        return Response.json({
          game: {
            id: `ephemeral-${Date.now().toString(36)}`,
            ephemeral: true,
            prompt: prompt || "on-device AI game",
            gameType,
            engine,
            code,
            createdAt: new Date().toISOString(),
          },
          validation: v,
        });
      }
      const row = await insertArcadeGame(db, {
        prompt: prompt || "on-device AI game",
        gameType,
        engine,
        code,
        parentId: parentId ?? null,
        ownerId: user.id,
      });
      return Response.json({ game: row, validation: v }, { status: 201 });
    }

    // Path 2: instant offline pipeline (verified core + remix).
    const forceType = (body.gameType as GameType | undefined) || undefined;
    if (!forceType && !detectGameType(prompt)) return Response.json({ error: "No offline template matches. Use AI generation or choose an explicit template." }, { status: 422 });
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
    // Persist only code that passed validation — a failed validation must
    // never become a stored "game" the catalogue then serves to everyone.
    if (!v.ok) {
      return Response.json({ error: "generated code failed validation", issues: v.issues }, { status: 422 });
    }
    const row = await insertArcadeGame(db, {
      prompt,
      gameType: g.gameType,
      engine: g.engine,
      code: g.code,
      parentId: parentId ?? null,
      ownerId: user.id,
    });
    return Response.json({ game: row, validation: v, ms: g.ms }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "arcade generation failed" }, { status: 500 });
  }
}
