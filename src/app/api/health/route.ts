import { pingDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness in one: every cloud's health check and the Build Tracker
 * call this. Returns 503 when the database is unreachable.
 */
export async function GET() {
  const dbOk = await pingDb();
  const body = {
    status: dbOk ? "ok" : "degraded",
    app: process.env.APP_NAME ?? "30-apps-template",
    version: process.env.APP_VERSION ?? "dev",
    cloud: process.env.CLOUD ?? "local",
    checks: { database: dbOk ? "ok" : "unreachable" },
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: dbOk ? 200 : 503 });
}
