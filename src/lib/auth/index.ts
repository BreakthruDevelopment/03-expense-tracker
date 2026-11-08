import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

const removeUserBody = z.object({ userId: z.coerce.string().min(1) });

/**
 * Runs before POST /admin/remove-user. Better Auth 1.7.15 deletes the target's sessions (the
 * endpoint), then their sessions again and their accounts (`internalAdapter.deleteUser`), and only
 * then runs `databaseHooks.user.delete.before`, so a storage failure there would leave a user who
 * can no longer sign in but still owns files. Purging here, first, means a storage failure aborts the
 * removal with nothing deleted.
 *
 * `hooks.before` runs before the endpoint's own admin check, so this checks the caller itself:
 * only a signed-in admin, removing someone other than themselves, triggers a purge. Any other
 * request falls through and the endpoint answers 401/403/400/404 as usual.
 */
const purgeBeforeRemoveUser = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/admin/remove-user") return;
  const session = await getAuthoritativeSessionFromCtx(ctx);
  const roles = String(session?.user.role ?? "").split(",").map((r) => r.trim());
  if (!session || !roles.includes("admin")) return;
  const body = removeUserBody.safeParse(ctx.body);
  if (!body.success || body.data.userId === session.user.id) return;
  try {
    const { purgeUserReceipts } = await import("@/lib/receipts");
    await purgeUserReceipts(body.data.userId);
  } catch (err) {
    log.error("auth.remove_user_purge_failed", { error: err instanceof Error ? err.message : String(err) });
    throw new APIError("BAD_GATEWAY", { message: "Receipt storage failed, so the user was not removed. Try again shortly." });
  }
});

function createAuth() {
  const e = env();
  return betterAuth({
    appName: e.APP_NAME,
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
    },
    // OIDC providers (Google, Microsoft Entra ID, GitHub, Okta via genericOAuth)
    // plug in here per app; they read their client IDs from env.
    socialProviders: {},
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: e.APP_URL.startsWith("https://"),
    },
    hooks: { before: purgeBeforeRemoveUser },
    // Backstop for any other way a user gets deleted (the self-delete endpoint, a future script):
    // purge the receipt images first so the database cascade can't orphan the files. A storage
    // failure here aborts the user-row deletion, but Better Auth has already deleted that user's
    // sessions and accounts by then, so this alone is not all-or-nothing. The remove-user hook above
    // is what keeps the admin path atomic.
    databaseHooks: {
      user: {
        delete: {
          before: async (u) => {
            const { purgeUserReceipts } = await import("@/lib/receipts");
            await purgeUserReceipts(u.id);
          },
        },
      },
    },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazily built so `next build` doesn't need a database or secrets. */
export function auth(): Auth {
  if (!instance) instance = createAuth();
  return instance;
}
