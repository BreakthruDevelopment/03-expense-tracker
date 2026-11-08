import "server-only";
import { env } from "@/lib/env";
import { createGcsDriver } from "./gcs";
import { createLocalDriver } from "./local";
import { localDriverAllowed } from "./local-policy";
import { createNoneDriver } from "./none";
import type { StorageDriver } from "./types";

export * from "./keys";
export * from "./types";

let cached: StorageDriver | undefined;

/**
 * `gcs` when STORAGE_BUCKET is set; otherwise `local` outside production (development, tests, CI
 * with `next dev`) and `none` in production (scanning off, manual entry still works). The built app
 * in CI sets STORAGE_ALLOW_LOCAL=true to get `local`; that is refused unless APP_URL is http on localhost.
 */
export function storage(): StorageDriver {
  if (!cached) {
    const e = env();
    if (e.STORAGE_BUCKET) cached = createGcsDriver({ bucket: e.STORAGE_BUCKET });
    else if (localDriverAllowed({ nodeEnv: e.NODE_ENV, allowLocal: e.STORAGE_ALLOW_LOCAL, appUrl: e.APP_URL })) {
      cached = createLocalDriver({
        allowInProduction: e.STORAGE_ALLOW_LOCAL,
        dir: e.STORAGE_LOCAL_DIR,
        secret: e.BETTER_AUTH_SECRET,
        baseUrl: e.APP_URL,
        nodeEnv: e.NODE_ENV,
      });
    } else if (e.STORAGE_ALLOW_LOCAL) {
      throw new Error("STORAGE_ALLOW_LOCAL is refused: APP_URL must be http on localhost.");
    } else cached = createNoneDriver();
  }
  return cached;
}

/** For tests only: pick the driver again after changing the environment. */
export function resetStorage() {
  cached = undefined;
}
