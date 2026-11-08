import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { log } from "@/lib/log";

// Any constant works; it only has to be the same for every instance of this app.
const LOCK_ID = 7_301_330;

export async function migrateOnStart(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.warn("db.migrate.skipped", { reason: "DATABASE_URL not set" });
    return;
  }
  const folder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  const started = Date.now();
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: folder });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_ID})`;
    }
    log.info("db.migrated", { ms: Date.now() - started });
  } catch (err) {
    // Don't take the whole app down: /api/health will report the database problem.
    log.error("db.migrate.failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
