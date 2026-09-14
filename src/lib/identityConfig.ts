export interface IdentityConfig { rpId:string; rpName:string; origin:string; development:boolean }
export function identityConfig(env:NodeJS.ProcessEnv=process.env):IdentityConfig{
 const development=env.NODE_ENV!=="production";const rpId=env.ARENA_WEBAUTHN_RP_ID||(development?"localhost":"");const origin=env.ARENA_WEBAUTHN_ORIGIN||(development?"http://localhost:3000":"");
 if(!rpId||!origin)throw new Error("Production requires ARENA_WEBAUTHN_RP_ID and ARENA_WEBAUTHN_ORIGIN");
 const url=new URL(origin);if(!development&&url.protocol!=="https:")throw new Error("Production WebAuthn origin must use HTTPS");
 return{rpId,rpName:env.ARENA_WEBAUTHN_RP_NAME||"Arena OS",origin,development};
}
export function assertLocalBootstrapEnabled(env:NodeJS.ProcessEnv=process.env){if(env.NODE_ENV==="production"||env.ARENA_LOCAL_IDENTITY_BOOTSTRAP!=="1")throw new Error("LOCAL_BOOTSTRAP_DISABLED")}
