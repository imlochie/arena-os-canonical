import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type OrderingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Queue edits can touch several sessions. Use one owner lock, including for
 * empty lists, before reading membership/order. Never nest these transactions. */
export async function withOrderingLock<T>(
  ownerId: string,
  work: (tx: OrderingTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waveyard-order:${ownerId}`}, 0))`);
    return work(tx);
  });
}

export class OrderingConflictError extends Error {
  constructor() {
    super("The order changed in another tab. The latest order has been loaded. Try your move again.");
  }
}

export function assertExpectedOrder(actual: string[], expected?: string[]): void {
  if (expected !== undefined && (
    actual.length !== expected.length || actual.some((id, index) => id !== expected[index])
  )) throw new OrderingConflictError();
}
