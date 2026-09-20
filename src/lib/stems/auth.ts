import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { arenaSessions, arenaUsers } from "@/db/schema";

export const STEM_SESSION_COOKIE = "arena_stem_session";
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 14;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthUser = { id: string; username: string; email: string; displayName: string };

export async function createStemSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await db.insert(arenaSessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  const jar = await cookies();
  jar.set(STEM_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearStemSession() {
  const jar = await cookies();
  jar.set(STEM_SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
}

export async function currentStemUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(STEM_SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await db.select({
    id: arenaUsers.id,
    username: arenaUsers.username,
    email: arenaUsers.email,
    displayName: arenaUsers.displayName,
  }).from(arenaSessions)
    .innerJoin(arenaUsers, eq(arenaSessions.userId, arenaUsers.id))
    .where(and(eq(arenaSessions.tokenHash, hashToken(token)), gt(arenaSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireStemUser() {
  const user = await currentStemUser();
  if (!user) throw Response.json({ error: "Sign in to access private Stem Lab projects." }, { status: 401 });
  return user;
}
