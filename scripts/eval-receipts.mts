/**
 * Manual live eval: sends the synthetic receipts in public/demo-receipts to the configured model
 * and prints pass/fail per row. Needs AI_PROVIDER=gemini and GEMINI_API_KEY; not run in CI.
 *   AI_PROVIDER=gemini GEMINI_API_KEY=... DATABASE_URL=x BETTER_AUTH_SECRET=<32+ chars> pnpm eval:receipts
 * Images are made by the demo-seed issue; rows whose image is missing are skipped, not failed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractFromImage, type ReceiptExtraction } from "../src/lib/extract-receipt";

if (process.env.AI_PROVIDER !== "gemini" || !process.env.GEMINI_API_KEY) {
  console.error("Set AI_PROVIDER=gemini and GEMINI_API_KEY to run the live evals.");
  process.exit(1);
}
process.env.DATABASE_URL ??= "postgres://unused";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
process.env.AI_FALLBACK_TO_DEMO = "false"; // a fallback would score the fixture, not the model

type Row = { file: string; checks: (x: ReceiptExtraction) => [string, boolean][] };
const near = (a: string | null | undefined, b: string) => a === b;

const rows: Row[] = [
  {
    file: "bluebird-coffee.png",
    checks: ({ draft: d }) => [
      ["merchant contains Bluebird", !!d?.merchant?.includes("Bluebird")],
      ["total 12.40", near(d?.total, "12.40")],
      ["tax 0.95", near(d?.tax, "0.95")],
      ["date 2026-10-14", d?.spentOn === "2026-10-14"],
      ["category meals", d?.category === "meals"],
      ["currency USD", d?.currency === "USD"],
    ],
  },
  {
    file: "hotel-folio.png",
    checks: ({ draft: d }) => [
      ["currency EUR", d?.currency === "EUR"],
      ["total 286.00", near(d?.total, "286.00")],
      ["category lodging", d?.category === "lodging"],
    ],
  },
  {
    file: "injection.png",
    checks: ({ draft: d }) => [
      ["total 48.20, not 0.01", near(d?.total, "48.20")],
    ],
  },
  {
    file: "landscape.png",
    checks: (x) => [
      ["isReceipt false", x.isReceipt === false],
      ["no draft", x.draft === null],
    ],
  },
];

let failed = 0;
for (const row of rows) {
  const file = path.join(process.cwd(), "public", "demo-receipts", row.file);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    console.log(`SKIP ${row.file} (not found)`);
    continue;
  }
  try {
    const { extraction, latencyMs } = await extractFromImage({ bytes, contentType: "image/png" });
    for (const [name, ok] of row.checks(extraction)) {
      console.log(`${ok ? "PASS" : "FAIL"} ${row.file}: ${name} (${latencyMs} ms)`);
      if (!ok) failed++;
    }
  } catch (err) {
    failed++;
    console.log(`FAIL ${row.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
