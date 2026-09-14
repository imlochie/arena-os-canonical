import { db } from "@/db";
import { toolEffects } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { appendSessionEvent } from "./sessionEvents";
import { applyFileEffect, approveToolEffect, type ToolEffect } from "./toolEffects";
import type { ToolGrant } from "./toolRuntime";
import { authorize, type AuthenticatedIdentity } from "./authorization";

type Database = typeof db;

export async function persistEffect(effect: ToolEffect, database: Database = db) {
  return database.transaction(async (tx) => {
    const [row] = await tx.insert(toolEffects).values(toInsert(effect)).returning();
    await appendSessionEvent(tx, effect.sessionId, "tool_effect_proposed", preview(row));
    return preview(row);
  });
}

export async function approveEffectWithIdentity(input:{effectId:string;sessionId:string;expectedDigest:string;grant:ToolGrant;identity:AuthenticatedIdentity},database:Database=db){
 return database.transaction(async tx=>{const [effect]=await tx.select().from(toolEffects).where(and(eq(toolEffects.id,input.effectId),eq(toolEffects.sessionId,input.sessionId))).limit(1);if(!effect)throw new Error("TOOL_EFFECT_NOT_FOUND");
 const decision=await authorize({identity:input.identity,capability:"tool_effect.approve",resource:effect.resourceId,scope:effect.canonicalScope,effectClass:effect.effectClass,requiresFreshAuthentication:true},tx as never);if(!decision.allowed)throw new Error(decision.code);validateGrant(effect,input.grant);if(effect.operationDigest!==input.expectedDigest)throw new Error("TOOL_DIGEST_MISMATCH");approveToolEffect(fromRow(effect),input.identity.ownerId);
 const [claimed]=await tx.update(toolEffects).set({status:"approved",approvedBy:input.identity.ownerId,approvedDigest:effect.operationDigest,approvedAt:new Date()}).where(and(eq(toolEffects.id,effect.id),eq(toolEffects.status,"proposed"),eq(toolEffects.operationDigest,input.expectedDigest))).returning();if(!claimed)throw new Error("TOOL_EFFECT_STATE");await appendSessionEvent(tx,effect.sessionId,"tool_effect_approved",{effectId:effect.id,approverId:input.identity.ownerId,deviceId:input.identity.deviceId,authenticatedSessionId:input.identity.sessionId});return preview(claimed)})
}

/** Internal authority boundary. Callers must authenticate the owner before invoking this. */
export async function approvePersistedEffect(input: {
  effectId: string; sessionId: string; approverId: string; expectedDigest: string; grant: ToolGrant;
}, database: Database = db) {
  return database.transaction(async (tx) => {
    const [current] = await tx.select().from(toolEffects).where(and(
      eq(toolEffects.id, input.effectId), eq(toolEffects.sessionId, input.sessionId)
    )).limit(1);
    if (!current) throw new Error("TOOL_EFFECT_NOT_FOUND");
    validateGrant(current, input.grant);
    if (current.operationDigest !== input.expectedDigest) throw new Error("TOOL_DIGEST_MISMATCH");
    const approved = approveToolEffect(fromRow(current), input.approverId);
    const [claimed] = await tx.update(toolEffects).set({
      status: "approved", approvedBy: input.approverId, approvedDigest: approved.operationDigest, approvedAt: new Date(),
    }).where(and(eq(toolEffects.id, current.id), eq(toolEffects.status, "proposed"), eq(toolEffects.operationDigest, input.expectedDigest))).returning();
    if (!claimed) throw new Error("TOOL_EFFECT_STATE");
    await appendSessionEvent(tx, current.sessionId, "tool_effect_approved", { effectId: current.id, approverId: input.approverId });
    return preview(claimed);
  });
}

export async function applyPersistedEffect(input: {
  effectId: string; sessionId: string; expectedDigest: string; grant: ToolGrant;
}, database: Database = db) {
  const claimed = await database.transaction(async (tx) => {
    const [row] = await tx.update(toolEffects).set({ status: "applying" }).where(and(
      eq(toolEffects.id, input.effectId), eq(toolEffects.sessionId, input.sessionId), eq(toolEffects.status, "approved"),
      eq(toolEffects.operationDigest, input.expectedDigest), sql`${toolEffects.approvedDigest} = ${toolEffects.operationDigest}`
    )).returning();
    if (!row) throw new Error("TOOL_EFFECT_NOT_CLAIMABLE");
    validateGrant(row, input.grant);
    return row;
  });

  const outcome = await applyFileEffect({ ...fromRow(claimed), status: "approved" }, input.grant);
  return database.transaction(async (tx) => {
    const eventType = outcome.status === "applied" ? "tool_effect_applied" : outcome.status === "stale" ? "tool_effect_stale" : "tool_effect_failed";
    const [row] = await tx.update(toolEffects).set({
      status: outcome.status, preimage: outcome.preimage, preimageDigest: outcome.preimage === undefined ? null : hashFromEffect(outcome),
      errorCode: outcome.error ?? null, errorMessage: outcome.error ?? null, appliedAt: outcome.status === "applied" ? new Date() : null,
    }).where(and(eq(toolEffects.id, claimed.id), eq(toolEffects.status, "applying"))).returning();
    if (!row) throw new Error("TOOL_EFFECT_FINALIZATION_FAILED");
    await appendSessionEvent(tx, claimed.sessionId, eventType, { effectId: claimed.id, status: outcome.status });
    return preview(row);
  });
}

function validateGrant(row: typeof toolEffects.$inferSelect, grant: ToolGrant) {
  if (row.grantId !== grant.id || row.sessionId !== grant.sessionId || row.resourceId !== grant.resourceId || row.canonicalScope !== grant.root) {
    throw new Error("TOOL_GRANT_INVALID");
  }
}
function toInsert(e: ToolEffect) { return { id:e.id,sessionId:e.sessionId,actorId:e.actorId,grantId:e.grantId,resourceId:e.resourceId,capability:e.capability,canonicalScope:e.canonicalRoot,targetPath:e.path,proposedOperation:JSON.stringify({content:e.content,expectedHash:e.expectedHash}),operationDigest:e.operationDigest,status:e.status }; }
function fromRow(r: typeof toolEffects.$inferSelect): ToolEffect { const op=JSON.parse(r.proposedOperation); return {id:r.id,sessionId:r.sessionId,actorId:r.actorId,grantId:r.grantId,resourceId:r.resourceId,capability:r.capability as ToolEffect["capability"],path:r.targetPath,canonicalRoot:r.canonicalScope,expectedHash:op.expectedHash,content:op.content,operationDigest:r.operationDigest,status:r.status as ToolEffect["status"],approvedBy:r.approvedBy??undefined,approvedDigest:r.approvedDigest??undefined}; }
function preview(r: typeof toolEffects.$inferSelect) { return {id:r.id,sessionId:r.sessionId,actorId:r.actorId,capability:r.capability,resourceId:r.resourceId,targetPath:r.targetPath,effectClass:r.effectClass,operationDigest:r.operationDigest,status:r.status,approvedBy:r.approvedBy,createdAt:r.createdAt,approvedAt:r.approvedAt,appliedAt:r.appliedAt,errorCode:r.errorCode}; }
function hashFromEffect(e: ToolEffect) { return e.expectedHash; }
