import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { DEMO_RECEIPTS, type DemoReceiptSpec, modelAnswerFor } from "@/lib/demo-receipt-data";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { MAX_RECEIPT_BYTES } from "@/lib/domain";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { createExpense } from "@/lib/expenses";
import { applyGuardrails, modelOutputSchema } from "@/lib/extract-receipt";
import { matchesMagic } from "@/lib/magic";
import { purgeUserReceipts } from "@/lib/receipts";
import { StorageError, StorageUnavailableError, objectKeyFor, storage } from "@/lib/storage";
import { log } from "@/lib/log";
import { releaseDaily, reserveDaily } from "@/lib/usage";

const PEOPLE = ["Ada", "Ben", "Cleo"] as const;
type Person = (typeof PEOPLE)[number];
const emailFor = (name: Person) => `${name.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`;
const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One admin load per minute and this many per UTC day, for the whole app. */
export const DEMO_LOADS_PER_DAY = 5;

type Fixture = {
  owner: Person;
  /** Days before the load; a receipt-backed expense uses the receipt's printed date instead. */
  daysAgo?: number;
  merchant: string;
  amount: string;
  tax?: string;
  currency?: "USD" | "EUR" | "GBP";
  category: "meals" | "travel" | "lodging" | "transport" | "office" | "software" | "equipment" | "other";
  note?: string;
  receipt?: DemoReceiptSpec["slug"];
};

const MANUAL: Fixture[] = [
  { owner: "Ada", daysAgo: 3, merchant: "Green Fork Cafe", amount: "18.60", category: "meals" },
  { owner: "Ada", daysAgo: 7, merchant: "Metro Transit", amount: "2.90", category: "transport" },
  { owner: "Ada", daysAgo: 12, merchant: "Cloudbase Hosting", amount: "24.00", category: "software", note: "Monthly plan" },
  { owner: "Ada", daysAgo: 19, merchant: "Lakeside Inn", amount: "142.00", tax: "12.90", category: "lodging" },
  { owner: "Ada", daysAgo: 33, merchant: "Skyline Air", amount: "318.40", category: "travel", note: "Client visit flight" },
  { owner: "Ada", daysAgo: 47, merchant: "Pixel Studio License", amount: "99.00", category: "software" },
  { owner: "Ada", daysAgo: 61, merchant: "Desk and Chair Co.", amount: "249.99", tax: "20.62", category: "equipment" },
  { owner: "Ada", daysAgo: 80, merchant: "Postage Plus", amount: "11.35", category: "other" },
  { owner: "Ben", daysAgo: 2, merchant: "Sunrise Bagels", amount: "9.45", category: "meals" },
  { owner: "Ben", daysAgo: 9, merchant: "Rail Express", amount: "64.00", category: "travel" },
  { owner: "Ben", daysAgo: 15, merchant: "Codeforge Pro", amount: "19.00", category: "software" },
  { owner: "Ben", daysAgo: 26, merchant: "Ride Share", amount: "22.10", category: "transport" },
  { owner: "Ben", daysAgo: 38, merchant: "Harbor Parking", amount: "14.00", category: "transport" },
  { owner: "Ben", daysAgo: 52, merchant: "Bistro Nord", amount: "41.80", currency: "EUR", category: "meals" },
  { owner: "Ben", daysAgo: 66, merchant: "Monitor Mart", amount: "329.00", tax: "27.14", category: "equipment" },
  { owner: "Ben", daysAgo: 85, merchant: "Dev Conference Pass", amount: "450.00", category: "other", note: "Fictional conference" },
  { owner: "Cleo", daysAgo: 1, merchant: "Noodle House", amount: "16.75", category: "meals" },
  { owner: "Cleo", daysAgo: 5, merchant: "Brightline Stationery", amount: "23.40", category: "office" },
  { owner: "Cleo", daysAgo: 11, merchant: "Tram Pass", amount: "45.00", currency: "GBP", category: "transport" },
  { owner: "Cleo", daysAgo: 21, merchant: "Hotel Aurora", amount: "189.00", currency: "GBP", category: "lodging" },
  { owner: "Cleo", daysAgo: 29, merchant: "Sky Regional", amount: "212.30", category: "travel" },
  { owner: "Cleo", daysAgo: 40, merchant: "Design Cloud", amount: "54.99", category: "software" },
  { owner: "Cleo", daysAgo: 55, merchant: "Tablet Depot", amount: "479.00", category: "equipment" },
  { owner: "Cleo", daysAgo: 70, merchant: "Team Lunch", amount: "87.20", category: "meals", note: "Team lunch (fictional)" },
  { owner: "Cleo", daysAgo: 88, merchant: "Notary Services", amount: "35.00", category: "other" },
];

const OWNER_OF: Record<DemoReceiptSpec["slug"], Person> = {
  "bluebird-coffee": "Ada",
  "office-supplies": "Ada",
  "hotel-folio": "Ben",
  taxi: "Ben",
  injection: "Cleo",
};

/** Every demo expense, in a fixed order: 25 typed by hand plus one for each of the 5 receipts. */
export const DEMO_EXPENSE_COUNT = MANUAL.length + DEMO_RECEIPTS.length;

/** One constant key serializes every demo load and reservation across processes. */
const LOCK = sql`pg_advisory_xact_lock(hashtextextended(${"demo-load"}, 0))`;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (now: Date, n: number) => isoDay(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
const decimal = (n: number) => n.toFixed(2);

/** Demo receipts need somewhere to store the images; without it, refuse before anything changes. */
export function assertDemoStorage(): void {
  if (storage().kind === "none") throw new StorageUnavailableError();
}

/**
 * Atomic global reservation: one load per minute and `DEMO_LOADS_PER_DAY` per UTC day for the whole
 * app. The lock and one transaction mean concurrent requests cannot both pass, and a refusal on
 * either limit leaves no trace.
 */
export async function reserveDemoLoad(actor: Actor): Promise<void> {
  assertCan(actor, "delete"); // no resource: admin only
  const { rateEvent } = schema;
  await db().transaction(async (tx) => {
    // Never wait here: a waiting request would hold a pool connection while the load needs several.
    const [{ ok }] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${"demo-load"}, 0)) as ok`);
    if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
    const any = eq(rateEvent.kind, "demo_load");
    await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
    const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
    if (n) throw new TooManyRequestsError("Demo workspace can be loaded once per minute. Try again shortly.");
    if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
      throw new TooManyRequestsError("The demo workspace was loaded the maximum number of times today. Try again tomorrow.");
    }
    await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
  });
  log.info("admin.demo_load", { by: actor.id });
}

/** Give back the day's reservation when the load it paid for failed, so failures don't burn the quota. */
export async function releaseDemoLoad(): Promise<void> {
  await db().transaction((tx) => releaseDaily(tx, "demo_load"));
}

/**
 * Default is the safe admin-route mode. CLI mode independently rechecks all guards.
 * `now` is only for tests; no HTTP input reaches it.
 */
export async function loadDemoWorkspace(actor: Actor, options: unknown = { mode: "admin" }, now: Date = new Date()) {
  assertCan(actor, "delete");
  const parsed = optionsSchema.parse(options);
  assertDemoStorage();
  // Hold the lock on a dedicated transaction for the whole load so the CLI and the route cannot
  // interleave. The work itself uses the normal pool.
  return db().transaction(async (tx) => {
    await tx.execute(sql`select ${LOCK}`);
    return loadLocked(actor, parsed.mode, now);
  });
}

async function readBundled(spec: DemoReceiptSpec): Promise<Buffer> {
  const bytes = await readFile(path.join(process.cwd(), "public", "demo-receipts", spec.file));
  if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES || !matchesMagic("image/png", bytes)) {
    throw new StorageError(`Bundled demo receipt ${spec.file} is not a valid PNG.`, 500);
  }
  return bytes;
}

async function loadLocked(actor: Actor, mode: "admin" | "cli", now: Date) {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  const api = auth();
  const ctx = await api.$context;
  const people = new Map<Person, Actor>();

  // Read every bundled image before changing anything, so a missing file can't leave a half-loaded workspace.
  const images = new Map<string, Buffer>();
  for (const spec of DEMO_RECEIPTS) images.set(spec.slug, await readBundled(spec));

  // Preflight all identities before changing anything. An existing unrelated account at a demo
  // address must never be adopted or have its expenses/password replaced.
  for (const name of PEOPLE) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, emailFor(name)));
    if (existing && existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  for (const name of PEOPLE) {
    const email = emailFor(name);
    const role = mode === "cli" && name === "Ada" ? "admin" : "user";
    const secret = password ?? randomBytes(32).toString("base64url");
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, email));
    let id: string;
    if (existing) {
      id = existing.id;
      // Use Better Auth's adapter and hasher, preserving its password format and hooks. Rotate even
      // on reload, so a previous CLI password cannot sign in on live.
      await ctx.internalAdapter.updateUser(id, { role });
      await ctx.internalAdapter.updatePassword(id, await ctx.password.hash(secret));
      await ctx.internalAdapter.deleteUserSessions(id);
    } else {
      const created = await api.api.createUser({ body: { email, name, password: secret, role, data: { image: MARKER } } });
      id = created.user.id;
    }
    people.set(name, { id, role });
  }
  const ids = [...people.values()].map((p) => p.id);

  // The demo users' own rate ledger (downloads, extractions) would otherwise build up across reloads.
  await db().delete(schema.rateEvent).where(and(inArray(schema.rateEvent.userId, ids), sql`${schema.rateEvent.kind} <> 'demo_load'`));

  // Replace only the demo users' data. Objects first (storage delete), then rows; the user ids come
  // from the marker-checked accounts above, never from a title, an email suffix or a SQL predicate.
  for (const id of ids) {
    await purgeUserReceipts(id);
    await db().delete(schema.expense).where(eq(schema.expense.ownerId, id));
  }

  // Everything below goes through the same expense layer as normal requests.
  let expenses = 0;
  for (const f of MANUAL) {
    await createExpense(people.get(f.owner)!, {
      merchant: f.merchant,
      spentOn: daysBefore(now, f.daysAgo ?? 0),
      amount: f.amount,
      ...(f.tax ? { tax: f.tax } : {}),
      currency: f.currency ?? "USD",
      category: f.category,
      note: f.note ?? "",
    });
    expenses += 1;
  }

  let receipts = 0;
  for (const spec of DEMO_RECEIPTS) {
    const owner = people.get(OWNER_OF[spec.slug])!;
    const bytes = images.get(spec.slug)!;
    const id = randomUUID();
    const key = objectKeyFor(owner.id, id);
    // Written server-side from the bundled file: no signed URL, no upload quota, no model call.
    await storage().put(key, bytes, "image/png", { ifAbsent: true });
    try {
      // The same guarded draft shape the extraction endpoint stores. `extraction_mode` must be set,
      // or the extraction code reads a non-null extraction with a null mode as an unfinished claim.
      const extraction = applyGuardrails(modelOutputSchema.parse(modelAnswerFor(spec)), now);
      await db().insert(schema.receipt).values({
        id,
        ownerId: owner.id,
        objectKey: key,
        contentType: "image/png",
        sizeBytes: bytes.length,
        status: "ready",
        extraction,
        extractionMode: "demo",
      });
      await createExpense(owner, {
        merchant: spec.title,
        spentOn: spec.date,
        amount: decimal(spec.total),
        ...(spec.tax !== null ? { tax: decimal(spec.tax) } : {}),
        currency: spec.currency,
        category: spec.category,
        note: spec.injectedText ? "Demo receipt with hostile text printed on it" : "",
        receiptId: id,
      });
    } catch (err) {
      await storage().remove(key).catch((e) => log.error("receipt.object_remove_failed", { error: e instanceof Error ? e.message : String(e) }));
      await db().delete(schema.receipt).where(eq(schema.receipt.id, id));
      throw err;
    }
    expenses += 1;
    receipts += 1;
  }
  return { users: people.size, expenses, receipts };
}

