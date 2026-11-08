import "server-only";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { type Db, db, schema } from "@/lib/db";
import { TooManyRequestsError } from "@/lib/errors";

/** A Drizzle handle: the pool or a transaction. */
export type Executor = Pick<Db, "select" | "insert" | "delete" | "execute">;

type RateKind = (typeof schema.rateEvent.kind.enumValues)[number];
type DailyKind = (typeof schema.dailyUsage.kind.enumValues)[number];

const today = sql`(now() at time zone 'utc')::date`;

/** Serialize work on one named resource for the rest of the transaction. */
export async function advisoryLock(tx: Executor, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

/**
 * Atomically add one to today's (UTC) app-wide counter, only if it stays within `cap`.
 * Returns false, changing nothing, when the cap is reached.
 */
export async function reserveDaily(tx: Executor, kind: DailyKind, cap: number): Promise<boolean> {
  const rows = await tx.execute(sql`
    insert into daily_usage (day, kind, count) values (${today}, ${kind}, 1)
    on conflict (day, kind) do update set count = daily_usage.count + 1
      where daily_usage.count + 1 <= ${cap}::int
    returning count
  `);
  return rows.length > 0;
}

export async function dailyCount(kind: DailyKind): Promise<number> {
  const rows = await db().execute<{ count: number }>(sql`select count from daily_usage where day = ${today} and kind = ${kind}`);
  return rows.length ? Number(rows[0].count) : 0;
}

/**
 * Record one attempt for `userId` unless they already made `limit` in the last hour. Call inside a
 * transaction: the per-user lock keeps two concurrent requests from both slipping under the limit.
 */
export async function consumeRate(tx: Executor, userId: string, kind: RateKind, limit: number, message: string): Promise<void> {
  const { rateEvent } = schema;
  await advisoryLock(tx, `rate:${kind}:${userId}`);
  // Rows past the window can never count again.
  await tx
    .delete(rateEvent)
    .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, kind), sql`${rateEvent.at} <= now() - interval '1 hour'`));
  const [{ n }] = await tx
    .select({ n: count() })
    .from(rateEvent)
    .where(and(eq(rateEvent.userId, userId), eq(rateEvent.kind, kind), gt(rateEvent.at, sql`now() - interval '1 hour'`)));
  if (n >= limit) throw new TooManyRequestsError(message);
  await tx.insert(rateEvent).values({ userId, kind });
}
