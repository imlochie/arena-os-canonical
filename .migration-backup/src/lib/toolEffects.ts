import { createHash, randomUUID } from "node:crypto";
import { realpath, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { ToolCapability, ToolGrant } from "./toolRuntime";

export type WriteCapability="filesystem.patch"|"filesystem.write";
export type EffectStatus="proposed"|"approved"|"applied"|"failed"|"stale";
export interface ToolEffect {id:string;sessionId:string;actorId:string;grantId:string;resourceId:string;capability:WriteCapability;path:string;canonicalRoot:string;expectedHash:string|null;content:string;operationDigest:string;status:EffectStatus;approvedBy?:string;approvedDigest?:string;preimage?:string;error?:string}
const MAX_WRITE=250_000;
export async function proposeFileEffect(input:{sessionId:string;actorId:string;grant:ToolGrant;capability:WriteCapability;path:string;expectedHash:string|null;content:string}):Promise<ToolEffect>{
 if(input.content.length>MAX_WRITE)throw new Error("TOOL_OUTPUT_LIMIT");
 if(input.sessionId!==input.grant.sessionId)throw new Error("TOOL_SCOPE_DENIED");
 const root=await realpath(input.grant.root);const target=resolve(root,input.path);const rel=relative(root,target);if(rel===".."||rel.startsWith(".."+sep))throw new Error("TOOL_SCOPE_DENIED");
 const base={sessionId:input.sessionId,actorId:input.actorId,grantId:input.grant.id,resourceId:input.grant.resourceId,capability:input.capability,path:rel,canonicalRoot:root,expectedHash:input.expectedHash,content:input.content};
 return{id:randomUUID(),...base,operationDigest:digest(base),status:"proposed"};
}
export function approveToolEffect(effect:ToolEffect,approverId:string):ToolEffect{if(effect.status!=="proposed")throw new Error("TOOL_EFFECT_STATE");if(approverId===effect.actorId)throw new Error("TOOL_SELF_APPROVAL_DENIED");return{...effect,status:"approved",approvedBy:approverId,approvedDigest:effect.operationDigest}}
export async function applyFileEffect(effect:ToolEffect,grant:ToolGrant):Promise<ToolEffect>{
 if(effect.status!=="approved"||effect.approvedDigest!==effect.operationDigest)throw new Error("TOOL_APPROVAL_INVALID");
 if(grant.id!==effect.grantId||grant.sessionId!==effect.sessionId||grant.resourceId!==effect.resourceId)throw new Error("TOOL_SCOPE_DENIED");
 const root=await realpath(grant.root);if(root!==effect.canonicalRoot)throw new Error("TOOL_SCOPE_STALE");const target=resolve(root,effect.path);let before="";try{const canonical=await realpath(target);if(relative(root,canonical).startsWith(".."))throw new Error("TOOL_SCOPE_DENIED");before=await readFile(canonical,"utf8")}catch(e:any){if(e.code!=="ENOENT")throw e}
 if(effect.expectedHash!==null&&hash(before)!==effect.expectedHash)return{...effect,status:"stale",error:"TOOL_PREIMAGE_STALE"};
 const tmp=resolve(dirname(target),`.arena-${effect.id}.tmp`);try{await writeFile(tmp,effect.content,{flag:"wx"});await rename(tmp,target);return{...effect,status:"applied",preimage:before}}catch(e){return{...effect,status:"failed",error:e instanceof Error?e.message:"TOOL_EFFECT_FAILED"}}
}
export function hash(value:string){return createHash("sha256").update(value).digest("hex")}
function digest(value:unknown){return hash(JSON.stringify(value))}
