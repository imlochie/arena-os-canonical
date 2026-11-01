import { sql, type SQL } from "drizzle-orm";

/**
 * Shared lock used while creating or deleting a source object. Uploads must
 * acquire it before writing the object; cleanup must acquire it before its
 * final reference check and delete.
 */
export function sourceObjectLockQuery(storageKey: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(${storageKey}, 0))`;
}
