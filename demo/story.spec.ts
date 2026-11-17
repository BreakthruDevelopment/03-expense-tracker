/**
 * Expense Tracker demo story, about 45 seconds headed:
 *   expenses list -> Scan a receipt -> choose a receipt photo -> AI fills the form -> edit one field
 *   -> Save -> back on the list with the new row.
 *
 * Signs in as a seeded demo user (default ada@demo.breakthru.test; see demo/README.md). Reload the
 * demo workspace before each take (`DEMO_SEED=yes pnpm seed:demo`).
 *
 * The receipt is demo/fixtures/bluebird-coffee-receipt.png, a synthetic receipt ("Demo City"), the
 * same image as public/demo-receipts/bluebird-coffee.png. With AI_PROVIDER=demo the extraction is
 * the recorded answer for exactly this receipt, so the photo and the filled form agree on camera
 * (the form shows a "Demo AI" badge). With a Gemini key set locally the model reads the image live.
 */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { beat, finalHold, startDelay, typeSlowly } from "./helpers";

const RECEIPT = path.join(__dirname, "fixtures", "bluebird-coffee-receipt.png");
const NOTE = "Coffee with the Northwind design team";

test("Expense Tracker: scan a receipt into an expense", async ({ page }) => {
  await page.goto("/expenses");
  await expect(page.getByRole("heading", { name: "Your expenses" })).toBeVisible();
  await startDelay(page);

  // 1. This month at a glance: totals, the category chart and the list.
  await beat(page, 2_000);
  await page.mouse.wheel(0, 400);
  await beat(page);
  await page.mouse.wheel(0, -400);

  // 2. Scan a receipt. Playwright answers the file picker with the fixture.
  await page.getByRole("link", { name: /^Scan (a|your first) receipt$/ }).first().click();
  await expect(page.getByRole("heading", { name: "Add a receipt photo" })).toBeVisible();
  await beat(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles(RECEIPT);

  // 3. The photo uploads privately and the AI fills the form next to it. Nothing is saved yet.
  const merchant = page.getByRole("textbox", { name: "Merchant" });
  await expect(merchant).toHaveValue(/\S/, { timeout: 60_000 });
  await beat(page, 2_500);

  // 4. Check the numbers and edit a field: add a note for the report.
  const note = page.getByRole("textbox", { name: "Note (optional)" });
  await note.scrollIntoViewIfNeeded();
  await note.click();
  await typeSlowly(page, NOTE);
  await beat(page);

  // 5. Save, and land on that month's list with the new expense.
  const merchantName = await merchant.inputValue();
  await page.getByRole("button", { name: "Save expense" }).click();
  await page.waitForURL(/\/expenses\?month=/);
  await expect(page.getByRole("heading", { name: "Your expenses" })).toBeVisible();
  await expect(page.getByRole("link", { name: merchantName }).first()).toBeVisible();
  await beat(page);
  await page.getByRole("link", { name: merchantName }).first().scrollIntoViewIfNeeded();
  await finalHold(page);
});
