/** Generation attempts are private, immutable-history Artifacts, not playable
 * catalogue entries or a second artifact registry. Code uses existing verified
 * private objects; credentials/request keys are never part of this payload. */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { arcadeGames, artifacts, type ArtifactContentObject } from "@/db/schema";
import { getArtifact, insertArtifact, updateArtifact, insertArcadeGame } from "@/lib/arcadeStore";
import { readArtifactObject, writeArtifactObject } from "@/lib/artifact-objects";
import { isUuid } from "@/lib/api/ids";
import { validateGameCode } from "./index";
import type { ForgeDraft } from "./forge-ai";
type State = "running" | "draft" | "validated" | "failed" | "cancelled" | "completed";
export type Attempt = { version: 1; state: State; prompt: string; fingerprint: string; parentId?: string; retryFrom?: string; retryFromRevisionId?: string; priorCodeSha256?: string; draftObject?: ArtifactContentObject; runtime?: ForgeDraft["runtime"]; validation?: ForgeDraft["validation"]; error?: string; gameId?: string; updatedAt: string; leaseExpiresAt: string };
export type AttemptCursor = { id: string; owner: string; revision: number; revisionId: string | null; value: Attempt };
export class AttemptError extends Error { readonly status: number; constructor(message: string, status = 409) { super(message); this.status=status; } }
function decode(row: typeof artifacts.$inferSelect): AttemptCursor {
  if (row.sourceType !== "arcade-generation" || row.sourceId !== row.id || row.deletedAt) throw new AttemptError("Generation attempt unavailable.", 404);
  let value: Attempt; try { value = JSON.parse(row.body); } catch { throw new AttemptError("Attempt metadata changed; inspect its immutable Artifact history."); }
  if (typeof value.prompt!=="string" || typeof value.fingerprint!=="string" || (value.validation && (!Array.isArray(value.validation.issues)||value.validation.issues.some(issue=>typeof issue!=="string"))) || value.version !== 1 || !["running","draft","validated","failed","cancelled","completed"].includes(value.state)) throw new AttemptError("Attempt metadata changed; inspect its immutable Artifact history.");
  return { id: row.id, owner: row.ownerId, revision: row.revision, revisionId: row.currentRevisionId, value };
}
export async function getAttempt(owner: string, id: string) {
  if (!isUuid(id)) throw new AttemptError("Valid attempt UUID required.", 400);
  const row = await getArtifact(db, id, owner); if (!row) throw new AttemptError("Generation attempt unavailable.", 404); return decode(row);
}
export async function listAttempts(owner: string) {
  const rows = await db.select().from(artifacts).where(and(eq(artifacts.ownerId, owner), eq(artifacts.sourceType, "arcade-generation"))).orderBy(desc(artifacts.createdAt)).limit(50);
  return rows.filter(row => !row.deletedAt).map(row => { const attempt=decode(row); return { ...attempt, owner: undefined, stalled: ["running","draft","validated"].includes(attempt.value.state) && Date.parse(attempt.value.leaseExpiresAt)<Date.now() }; });
}
export async function beginAttempt(owner: string, id: string, prompt: string, parentId?: string, priorCode?: string, retryFrom?: string, retryFromRevisionId?: string) {
  if (!isUuid(id)) throw new AttemptError("Stable attempt UUID required.", 400);
  const fingerprint=createHash("sha256").update(JSON.stringify([prompt,parentId,priorCode,retryFrom,retryFromRevisionId])).digest("hex");
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 71092822))`);
    const prior=await getArtifact(tx,id,owner);
    if(prior) { const existing=decode(prior); if(existing.value.fingerprint!==fingerprint) throw new AttemptError("Attempt ID already identifies different work."); return {cursor:existing,created:false}; }
    const now=new Date(); const value:Attempt={version:1,state:"running",prompt,fingerprint,parentId,retryFrom,retryFromRevisionId,priorCodeSha256:priorCode?createHash("sha256").update(priorCode).digest("hex"):undefined,updatedAt:now.toISOString(),leaseExpiresAt:new Date(now.getTime()+240000).toISOString()};
    const row=await insertArtifact(tx,{id,ownerId:owner,sourceId:id,sourceType:"arcade-generation",kind:"archive",title:`Arcade attempt — ${prompt.slice(0,100)}`,body:JSON.stringify(value)});
    return {cursor:decode(row),created:true};
  });
}
export async function checkpointAttempt(cursor: AttemptCursor, patch: Partial<Pick<Attempt,"state"|"error"|"gameId">>, draft?: ForgeDraft) {
  if (["completed","cancelled"].includes(cursor.value.state)) throw new AttemptError("Attempt is terminal; start a new attempt to retry.");
  const object=draft ? await writeArtifactObject(cursor.owner,draft.code,"text/plain; charset=utf-8") : undefined;
  const now=new Date(); const value:Attempt={...cursor.value,...patch,...(draft ? {draftObject:object,runtime:draft.runtime,validation:validateGameCode(draft.code)}:{}),updatedAt:now.toISOString(),leaseExpiresAt:new Date(now.getTime()+240000).toISOString()};
  const changed=await updateArtifact(db,cursor.id,cursor.owner,{body:JSON.stringify(value)},cursor.revision);
  if(changed.outcome!=="ok"||!changed.row) throw new AttemptError("Attempt changed/cancelled; no generated game was committed. Inspect its history."); return decode(changed.row);
}
export async function attemptCode(cursor: AttemptCursor) { return cursor.value.draftObject ? (await readArtifactObject(cursor.owner,cursor.value.draftObject)).toString("utf8") : ""; }
export async function cancelAttempt(owner:string,id:string) {
  const cursor=await getAttempt(owner,id); if(cursor.value.state==="cancelled") return cursor;
  if(cursor.value.state==="completed") throw new AttemptError("Attempt already completed. Its saved game remains available; cancellation was not applied.");
  return checkpointAttempt(cursor,{state:"cancelled",error:"Owner cancelled/abandoned this attempt. Existing partial bytes and immutable history are retained; late results are fenced."});
}
export async function completedAttemptGame(cursor:AttemptCursor, database:Pick<typeof db,"select">=db) {
  if(cursor.value.state!=="completed"||!cursor.value.gameId||!cursor.value.draftObject)throw new AttemptError("Saved-result identity is incomplete; inspect immutable attempt history.");
  const [game]=await database.select().from(arcadeGames).where(and(eq(arcadeGames.id,cursor.value.gameId),eq(arcadeGames.ownerId,cursor.owner))).limit(1);
  if(!game||createHash("sha256").update(game.code).digest("hex")!==cursor.value.draftObject.sha256)throw new AttemptError("Saved game differs from the verified attempt; no replacement was acknowledged.");return game;
}
export async function finishAttempt(cursor:AttemptCursor, code:string, gameType:string, engine="retained-code") {
  if(!validateGameCode(code).ok || cursor.value.state!=="validated" || !cursor.value.draftObject || createHash("sha256").update(code).digest("hex")!==cursor.value.draftObject.sha256) throw new AttemptError("Only the exact verified validated attempt can become a saved game.");
  return db.transaction(async tx=>{
    const [row]=await tx.select().from(artifacts).where(and(eq(artifacts.id,cursor.id),eq(artifacts.ownerId,cursor.owner))).for("update");
    if(row && !row.deletedAt && decode(row).value.state==="completed") { const game=await completedAttemptGame(decode(row),tx); if(game.code!==code)throw new AttemptError("Attempt completion identity changed."); return game; }
    if(!row || row.deletedAt || row.revision!==cursor.revision || decode(row).value.state!=="validated") throw new AttemptError("Attempt changed/cancelled; late completion was not committed.");
    const game=await insertArcadeGame(tx,{ownerId:cursor.owner,prompt:cursor.value.prompt,parentId:cursor.value.parentId,code,gameType,engine});
    const changed=await updateArtifact(tx,cursor.id,cursor.owner,{body:JSON.stringify({...cursor.value,state:"completed",gameId:game.id,updatedAt:new Date().toISOString()})},cursor.revision);
    if(changed.outcome!=="ok") throw new AttemptError("Completion conflicted; game insertion was rolled back.");
    return game;
  });
}
