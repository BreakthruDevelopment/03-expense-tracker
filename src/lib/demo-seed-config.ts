import { z } from "zod";

/** Checked before importing the database/auth loader, including for CLI refusals. */
export function demoSeedConfig(values: Record<string, string | undefined> = process.env) {
  if (values.DEMO_SEED !== "yes") throw new Error("Demo seed refused: set DEMO_SEED=yes.");
  const parsedUrl = z.string().url().safeParse(values.APP_URL);
  if (!parsedUrl.success) throw new Error("Demo seed refused: set APP_URL to a valid URL.");
  const appUrl = parsedUrl.data;
  const hostname = new URL(appUrl).hostname.toLowerCase().replace(/\.+$/, "");
  if (hostname === "app3.breakthruventures.ai" || hostname === "azurecontainerapps.io" || hostname === "run.app" || hostname.endsWith(".azurecontainerapps.io") || hostname.endsWith(".run.app")) {
    throw new Error("Demo seed refused: APP_URL is a production host.");
  }
  const dbHost = databaseHost(values.DATABASE_URL);
  if (dbHost && (dbHost === "postgres.database.azure.com" || dbHost.endsWith(".postgres.database.azure.com"))) {
    throw new Error("Demo seed refused: DATABASE_URL is a production database host.");
  }
  // Cloud SQL sockets (`?host=/cloudsql/project:region:instance`) are the Google Cloud production database.
  if (values.DATABASE_URL && /(\/|%2f)cloudsql(\/|%2f)/i.test(values.DATABASE_URL)) {
    throw new Error("Demo seed refused: DATABASE_URL is a production database host.");
  }
  const password = z.string().min(10).max(128).parse(values.DEMO_PASSWORD);
  return { appUrl, password };
}

function databaseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}
