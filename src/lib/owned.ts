import { type SQL, and, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Ownership, once. Expenses and receipts are private to their owner, admin included, so the
 * template's `can()` (admin passes everything) is deliberately not used for them. Every select,
 * update and delete of `expense` and `receipt` goes through this fragment; zero rows means 404.
 */
export function ownedBy(table: { ownerId: PgColumn }, actor: { id: string }, ...and_: (SQL | undefined)[]): SQL {
  return and(eq(table.ownerId, actor.id), ...and_) as SQL;
}
