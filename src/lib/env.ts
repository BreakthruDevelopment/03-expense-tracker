import { z } from "zod";

/**
 * Every setting the app reads, validated in one place.
 * Read lazily so `next build` works without production secrets.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("Expense Tracker"),
  // The public URL, e.g. https://app7.breakthruventures.ai. Sign-in callbacks,
  // cookies and CORS all derive from it, so a domain change never touches code.
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  // "demo" serves recorded answers, so demos never break on a quota.
  AI_PROVIDER: z.enum(["gemini", "anthropic", "demo"]).default("demo"),
  AI_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Fall back to demo answers when the live provider fails (quota, outage).
  AI_FALLBACK_TO_DEMO: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Embedding model for embed(). Confirm the name on the day (see README, "Embeddings").
  AI_EMBED_MODEL: z.string().optional(),
  // Provider call timeout. 20 s keeps AI calls inside Lambda's 29 s limit (route maxDuration is 25 s).
  AI_TIMEOUT_MS: z.coerce.number().int().positive().max(22000).default(20000),
  // Private Cloud Storage bucket for receipt images. Unset: the local driver in development
  // and test, and no uploads (manual entry only) in production.
  STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/, "STORAGE_BUCKET is not a valid bucket name")
    .optional(),
  // Where the local storage driver keeps files (development and CI only). Its signed URLs are HMACed with BETTER_AUTH_SECRET.
  STORAGE_LOCAL_DIR: z.string().default(".data/uploads"),
  // CI only: lets the built (production-mode) app use the local driver so smoke can upload.
  // Ignored (and storage() throws) unless APP_URL is http on localhost; never set in a deployment.
  STORAGE_ALLOW_LOCAL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Free-tier caps (see the spec's budget table).
  UPLOAD_DAILY_CAP: z.coerce.number().int().positive().default(100),
  EXTRACT_DAILY_CAP: z.coerce.number().int().positive().default(100),
  STORAGE_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  RECEIPTS_PER_USER: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    // Cloud consoles and CI often set unused variables to "". Treat those as unset
    // so defaults apply instead of failing validation.
    const present = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
    );
    const parsed = schema.safeParse(present);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
