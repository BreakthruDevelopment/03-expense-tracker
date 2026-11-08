import { pingDb } from "@/lib/db";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness in one: every cloud's health check and the Build Tracker
 * call this. Returns 503 when the database is unreachable.
 */
export async function GET() {
  const dbOk = await pingDb();
  const body = {
    status: dbOk ? "ok" : "degraded",
    app: process.env.APP_NAME ?? "expense-tracker",
    version: process.env.APP_VERSION ?? "dev",
    cloud: process.env.CLOUD ?? "local",
    // Which driver is active; never the bucket name.
    storage: storage().kind,
    checks: { database: dbOk ? "ok" : "unreachable" },
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: dbOk ? 200 : 503 });
}
