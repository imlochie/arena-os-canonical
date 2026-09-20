import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { getDb, sessions, users } from "@waveyard/database";

export const SESSION_COOKIE = "waveyard_session";
const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

export type AuthenticatedUser = typeof users.$inferSelect;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await getDb().insert(sessions).values({ userId, tokenHash: tokenHash(token), expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function deleteSession(token: string | undefined) {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export function expiredSessionCookie() {
  return { name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", expires: new Date(0) };
}
