import { createHash, randomBytes } from "node:crypto";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { arenaDevices, authenticatedSessions, deviceCapabilityGrants, webauthnCredentials } from "@/db/schema";

export interface AuthenticatedIdentity { ownerId:string; deviceId:string; sessionId:string; credentialId:string; assurance:string; freshVerifiedAt:Date|null }
export interface AuthorizationRequest { identity:AuthenticatedIdentity; capability:string; resource:string; scope:string; effectClass?:string; requiresFreshAuthentication?:boolean; now?:Date }
export interface AuthorizationDecision { allowed:boolean; code:string; reason:string; grantId:string|null; identity:AuthenticatedIdentity }
export const FRESH_AUTH_WINDOW_MS=5*60_000, SESSION_IDLE_WINDOW_MS=30*60_000;
export function issueSessionToken(){return randomBytes(32).toString("base64url")}
export function hashSessionToken(token:string){return createHash("sha256").update(token).digest("hex")}
export async function authenticateSessionToken(token:string,database:typeof db=db):Promise<AuthenticatedIdentity>{
 const now=new Date(),hash=hashSessionToken(token);const [s]=await database.select().from(authenticatedSessions).where(and(eq(authenticatedSessions.tokenHash,hash),isNull(authenticatedSessions.revokedAt))).limit(1);
 if(!s||s.expiresAt<=now||now.getTime()-s.lastActivityAt.getTime()>SESSION_IDLE_WINDOW_MS)throw new Error("AUTH_SESSION_INVALID");
 const [[device],[credential]]=await Promise.all([database.select().from(arenaDevices).where(eq(arenaDevices.id,s.deviceId)).limit(1),database.select().from(webauthnCredentials).where(eq(webauthnCredentials.id,s.credentialId)).limit(1)]);
 if(!device||device.ownerId!==s.ownerId||device.state!=="active"||device.revokedAt||!credential||credential.ownerId!==s.ownerId||credential.deviceId!==s.deviceId||credential.revokedAt)throw new Error("AUTH_IDENTITY_REVOKED");
 return{ownerId:s.ownerId,deviceId:s.deviceId,sessionId:s.id,credentialId:s.credentialId,assurance:s.assurance,freshVerifiedAt:s.freshVerifiedAt};
}
export async function authorize(request:AuthorizationRequest,database:typeof db=db):Promise<AuthorizationDecision>{
 const now=request.now??new Date();const deny=(code:string,reason:string):AuthorizationDecision=>({allowed:false,code,reason,grantId:null,identity:request.identity});
 const [s]=await database.select().from(authenticatedSessions).where(eq(authenticatedSessions.id,request.identity.sessionId)).limit(1);if(!s||s.ownerId!==request.identity.ownerId||s.deviceId!==request.identity.deviceId||s.revokedAt||s.expiresAt<=now)return deny("SESSION_DENIED","authenticated session is invalid");
 const [d]=await database.select().from(arenaDevices).where(eq(arenaDevices.id,s.deviceId)).limit(1);if(!d||d.ownerId!==s.ownerId||d.state!=="active"||d.revokedAt)return deny("DEVICE_DENIED","device is revoked, disabled, or compromised");
 const [c]=await database.select().from(webauthnCredentials).where(eq(webauthnCredentials.id,s.credentialId)).limit(1);if(!c||c.ownerId!==s.ownerId||c.deviceId!==s.deviceId||c.revokedAt)return deny("CREDENTIAL_DENIED","credential is invalid");
 if(request.requiresFreshAuthentication&&(!s.freshVerifiedAt||now.getTime()-s.freshVerifiedAt.getTime()>FRESH_AUTH_WINDOW_MS))return deny("FRESH_AUTH_REQUIRED","fresh authentication is required");
 const [g]=await database.select().from(deviceCapabilityGrants).where(and(eq(deviceCapabilityGrants.ownerId,s.ownerId),eq(deviceCapabilityGrants.deviceId,s.deviceId),eq(deviceCapabilityGrants.capability,request.capability),eq(deviceCapabilityGrants.resource,request.resource),eq(deviceCapabilityGrants.scope,request.scope),isNull(deviceCapabilityGrants.revokedAt))).limit(1);
 if(!g||g.expiresAt&&g.expiresAt<=now||request.effectClass&&g.effectClass!==request.effectClass)return deny("CAPABILITY_DENIED","no active capability grant matches this resource and scope");
 return{allowed:true,code:"AUTHORIZED",reason:"explicit active device capability grant",grantId:g.id,identity:request.identity};
}
