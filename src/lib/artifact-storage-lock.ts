import { sql } from "drizzle-orm";
export const ARTIFACT_STORAGE_LOCK = 71092821;
export const storageReadLock = sql`select pg_advisory_xact_lock_shared(${ARTIFACT_STORAGE_LOCK})`;
export const storageWriteLock = sql`select pg_advisory_xact_lock(${ARTIFACT_STORAGE_LOCK})`;
