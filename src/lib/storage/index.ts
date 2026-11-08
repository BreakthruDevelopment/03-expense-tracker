import "server-only";
import { env } from "@/lib/env";
import { createGcsDriver } from "./gcs";
import { createLocalDriver } from "./local";
import { createNoneDriver } from "./none";
import type { StorageDriver } from "./types";

export * from "./keys";
export * from "./types";

let cached: StorageDriver | undefined;

/**
 * `gcs` when STORAGE_BUCKET is set; otherwise `local` outside production (development, CI,
 * tests) and `none` in production (scanning off, manual entry still works).
 */
export function storage(): StorageDriver {
  if (!cached) {
    const e = env();
    if (e.STORAGE_BUCKET) cached = createGcsDriver({ bucket: e.STORAGE_BUCKET });
    else if (e.NODE_ENV !== "production") {
      cached = createLocalDriver({
        dir: e.STORAGE_LOCAL_DIR,
        secret: e.BETTER_AUTH_SECRET,
        baseUrl: e.APP_URL,
        nodeEnv: e.NODE_ENV,
      });
    } else cached = createNoneDriver();
  }
  return cached;
}

/** For tests only: pick the driver again after changing the environment. */
export function resetStorage() {
  cached = undefined;
}
