import { authenticateSessionToken } from "./authorization";
export async function authenticatedRequestIdentity(request:Request){const cookie=request.headers.get("cookie")??"";const token=cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith("arena_session="))?.slice(14);if(!token)throw new Error("AUTHENTICATION_REQUIRED");return authenticateSessionToken(decodeURIComponent(token))}
export function assertSameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Error("CSRF_ORIGIN_DENIED")}
