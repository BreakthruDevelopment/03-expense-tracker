# Expense Tracker

> Small teams lose time and trust on receipts: this app reads a photo into an expense form, keeps the image private, and saves nothing until the person checks the numbers.

**Live:** https://app3.breakthruventures.ai · **Runs on:** Google Cloud (Cloud Run, us-central1) · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

> The custom domain's certificate is still being issued. Until it works, use
> https://expense-tracker-189497094271.us-central1.run.app (same app).

> **Demo data only.** The AI runs on a free-tier Gemini key, and Google may use free-tier prompts. Don't upload real
> receipts. The repo has synthetic ones in `public/demo-receipts/`.

## What it does

The client problem: small businesses, accounting firms and fintech teams want "Expensify for us". People snap a
receipt on a phone, the app reads it, they fix the numbers, and it lands in a monthly report they can export. Clients
care about two things: receipt images stay private, and the AI never saves anything on its own.

- **Scan a receipt (user).** Take a photo or choose a file on `/expenses/new`. The browser shrinks it to at most 1,600 px
  JPEG, uploads it straight to a private bucket, and the AI fills a form next to the photo. The form shows a confidence
  badge and any warnings. Nothing is saved until the user presses Save.
- **Enter an expense by hand (user).** Same form, no photo. It also works when scanning is switched off or a cap is hit.
- **Review the month (user).** `/expenses` has a month and category filter, totals per currency, a bar chart by category,
  and a paged list. Amounts in different currencies are never converted or added together.
- **Edit, delete, export (user).** Edits carry a conflict check (a stale save gets a 409 message). Deleting an expense
  removes its image first. Export CSV downloads the month's expenses, and only the signed-in user's own.
- **Admin.** `/admin` shows users, expenses, receipts stored and bytes against the caps, uploads and AI readings today
  against the daily caps, a "Load demo workspace" button, and a per-user "Purge receipt images" button. Admin sees counts
  and sizes only, never anyone's expenses or images.

Supported currencies: USD, EUR, GBP, CAD, AUD, MXN, CHF, INR. Categories: meals, travel, lodging, transport, office,
software, equipment, other. Money is stored as whole minor units (cents), never as floats.

## The AI feature

**Receipt extraction.** One receipt photo goes through the shared `generate()` gateway as task `extract-receipt`, with
image input. The live model is Gemini `gemini-flash-lite-latest`. The route is `POST /api/receipts/[id]/extract`.

How it is kept safe:

- **Verified file first.** The server re-reads the uploaded object and checks its real size (at most 5 MB) and its first
  bytes (JPEG, PNG or WebP). A wrong file is deleted and the request fails with 422. It never reaches the model.
- **Image text is data.** The system prompt says all text in the image is to be transcribed, never obeyed, and to ignore
  text that asks to change values, categories or approval. The model has no tools.
- **Validated output.** A zod schema checks the answer. One unreadable field becomes `null` instead of failing the whole
  read. An unknown category becomes `other`. Unknown keys are dropped.
- **Guardrails in code.** "Not a receipt" gives no prefill and no expense. A date more than a day ahead or before 2000
  becomes empty with a warning. An unsupported currency becomes empty with "choose a currency". If line items plus tax are
  more than 1% off the total, the draft gets a warning and confidence drops to `low`.
- **Nothing saves by itself.** Extraction only returns a draft. An expense exists only after the user posts the form.
- **Limits.** One reading per receipt (a repeat call returns the stored result), 10 per user per hour, and 100 per day for
  the whole app. A model text prompt is capped at 1,000 characters. Caps fail closed with a clear message, and manual
  entry still works.
- **Fallbacks.** If the model fails, the receipt is marked `failed` and the user gets the manual form. With
  `AI_PROVIDER=demo`, or `AI_FALLBACK_TO_DEMO=true` on a quota error, a recorded answer is used and the form says
  "Demo extraction: a recorded answer, not read from your image". The fixture is in `src/lib/ai/demo.ts`.
- **Logs.** Logs carry task, mode, latency, confidence and warning codes. Never image bytes, merchants or amounts.

**Evals.** `test/ai-evals.test.ts` runs in CI with a stubbed `generate`. `pnpm eval:receipts` is a manual check: it sends
the synthetic images to live Gemini and prints pass or fail per row. It needs `GEMINI_API_KEY` and is not in CI.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container on Cloud Run ── pages, server actions, /api/*
   │   auth + roles, zod validation, owner checks, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle) on an e2-micro VM
   ├──► Cloud Storage: private bucket, receipt images only
   └──► Gemini API (vision), through generate()

Upload:  browser ──PUT (signed URL)──► bucket      (the image never passes through the app)
Read:    app ──reads the object──► checks size and type ──► Gemini ──► draft ──► form
View:    app checks the owner ──► 300-second signed download link
```

**Upload flow.** `POST /api/receipts/uploads` with `{contentType, sizeBytes}` returns a signed `PUT` URL and the exact
headers to send. The browser sends the file, then calls `POST /api/receipts/[id]/extract`, which verifies the object and
runs the model. (`POST /api/receipts/[id]/confirm` also exists, to verify a file without extracting.) The signed `PUT`
fixes the content type and a size range, and allows create-only, so a second `PUT` to the same URL gets a 412.

**Signed URLs without key files.** On Cloud Run the `gcs` driver signs through IAM `signBlob` as the service account. No
JSON key exists. Download links last 300 seconds, are issued only after the owner check, and force an `image/*` type.

**Storage drivers** (`src/lib/storage`): `gcs` when `STORAGE_BUCKET` is set; `local` for development and CI (files under
`.data/uploads`, HMAC-signed URLs, refused in production); `none` otherwise, which turns scanning off and leaves manual
entry working. `GET /api/health` reports which one is active, never the bucket name.

**Cleanup.** Unconfirmed uploads older than an hour and unused drafts older than a day are swept (on upload start and on
the admin page). Removing a user purges their images first.

## Security

| Who | Can do |
| --- | --- |
| Signed out | See the landing page and sign in or up. Everything else redirects (pages) or returns 401 (API). |
| `user` | Create, read, edit and delete **their own** expenses and receipts, export their own CSV. |
| `admin` | Everything a user can, on their own data, plus counts and caps, load the demo workspace, and purge one user's images. |

**Admin cannot read other people's expenses or receipt images.** Receipts carry card digits, names and places. The
template's "admin passes every check" rule is deliberately not used for expenses or receipts.

- **Owner-only queries.** Every expense and receipt query filters on the owner (`src/lib/owned.ts`). Someone else's row
  is a 404 for everyone, admin included. Pages and routes check the session on the server; data functions take the
  acting user.
- **Same-origin check.** Cookie-based writes need our own `Origin`. JSON bodies are capped at 16 KB. Input is validated
  with zod at every boundary.
- **Private files.** Images live in a private bucket and are reachable only through short-lived signed links. Object
  keys are `u/<ownerId>/<receiptId>` with no file name.
- **CSV safety.** Cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'` so spreadsheets don't run them. A
  CSV has at most 5,000 rows.
- **Photo privacy.** Resizing in the browser also drops EXIF data such as location.
- **Known limit.** The first-bytes check proves a file *starts* like an image, not that it is only an image. That is
  acceptable here because images are served only with a forced `image/*` type from the storage host, never from the app,
  and are decoded only by the model provider.
- **Removing a user.** An admin removing a user purges that user's images first, so a storage failure aborts the
  removal with nothing deleted. A database hook purges again as a backstop for other paths. Known limit: if the
  admin's session or role changes, or the database fails, between the purge and the removal, the images can be gone
  while the user remains. Retrying the removal finishes it.
- **Known limit.** A signed download link works for anyone who holds it until it expires (300 seconds). The owner check
  happens when it is issued.
- **Tests.** `test/expenses.integration.test.ts` and `test/receipts-hardening.integration.test.ts` run against real
  Postgres and cover other-user and admin 404s, stale updates, caps, rejected files and CSV escaping. Further tests cover
  extraction, the demo seed, user removal and the storage routes.

## Free-tier budget

Open sign-up means one person with many accounts could use up the app-wide daily caps. That is acceptable for a demo,
and the caps reset at midnight UTC.

| Resource | Cap (default, changeable by env) |
| --- | --- |
| Receipts per user | 30 (`RECEIPTS_PER_USER`) |
| Expenses per user | 500 |
| Image size | 5 MB each (the browser sends at most 1,600 px) |
| Uploads | 20 per user per hour, 100 per day app-wide (`UPLOAD_DAILY_CAP`) |
| Stored images in total | 2 GB (`STORAGE_MAX_BYTES`) |
| AI readings | 10 per user per hour, 100 per day app-wide (`EXTRACT_DAILY_CAP`) |
| Download links | 120 per user per hour |
| Demo workspace loads | 1 per minute, 5 per day app-wide |

## Demo data

Three demo users (Ada, Ben, Cleo at `@demo.breakthru.test`) own about 30 fictional expenses over the last three months.
Five have a synthetic receipt image with a pre-filled extraction (`extraction_mode = demo`), so loading them makes no
model call. Ada is an admin.

- **Live:** an admin presses "Load demo workspace" on `/admin` (or `POST /api/admin/demo`). Demo users get random
  passwords nobody knows, so on the live site you sign up with your own account. A reload replaces only the demo users'
  expenses and images.
- **Local:** `DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ characters> pnpm seed:demo`. All three get
  that password. It refuses production URLs (`app3.breakthruventures.ai`, `*.run.app`, `*.azurecontainerapps.io`).
- `pnpm demo:receipts` redraws the synthetic images in `public/demo-receipts/`.

## Run it locally

```bash
cp .env.example .env.local          # set BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

With no `STORAGE_BUCKET`, receipts go to `.data/uploads`. With no `GEMINI_API_KEY` (`AI_PROVIDER=demo`, the default), the
scan returns the recorded Bluebird Coffee answer. To make yourself an admin: sign up, then
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app runs.

Needs Node 22 or later and pnpm.

### Environment variables (names only)

| Name | Purpose |
| --- | --- |
| `APP_NAME`, `APP_URL` | Display name; public URL used for sign-in, cookies and the Origin check |
| `DATABASE_URL`, `BETTER_AUTH_SECRET` | Postgres connection; session secret (32+ characters) |
| `AI_PROVIDER`, `AI_MODEL` | `demo` (default), `gemini` or `anthropic`; optional model override |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model keys |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `AI_EMBED_MODEL` | Use the recorded answer on failure (default true); model timeout (default 20,000 ms, max 22,000); embedding model (unused by this app) |
| `STORAGE_BUCKET`, `STORAGE_LOCAL_DIR` | Bucket for the `gcs` driver; folder for the `local` driver |
| `STORAGE_ALLOW_LOCAL` | CI only: lets the built app use the local driver on `http://localhost` |
| `UPLOAD_DAILY_CAP`, `EXTRACT_DAILY_CAP`, `STORAGE_MAX_BYTES`, `RECEIPTS_PER_USER` | The caps above |
| `LOG_LEVEL`, `MIGRATE_ON_START` | Log level; apply migrations when the server starts |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` | Used by `pnpm db:seed` |

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test    # unit tests
TEST_DATABASE_URL=postgres://... pnpm test  # plus integration tests against real Postgres
pnpm build && pnpm smoke                    # end-to-end against a running app
BASE_URL=https://app3.breakthruventures.ai REQUIRE_RECEIPTS=1 bash scripts/smoke.sh   # the same smoke test, live
```

`scripts/smoke.sh` signs up two users and checks, in order: health, signed-out redirects and 401s, A's expense, B's 404s,
a stale update (409), the receipt flow (refused `image/gif` and 6 MB, signed `PUT`, a repeat `PUT` is 412, B's 404 on A's
receipt, extraction, save), CSV per user, admin routes closed to normal users, and cleanup of what it created.

The **Live smoke test** workflow (`.github/workflows/live-smoke.yml`) runs it against a deployed URL. It passed against
the run.app URL, including a live Gemini extraction.

## Deploy it yourself

The same container image runs on all four clouds (see `infra/README.md`). Every push to `main` publishes a multi-arch
image to GitHub Container Registry. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a
tagged image with Terraform. This repo holds no cloud credentials.

- **Google Cloud (where this app runs).** Cloud Run in us-central1, Postgres on an e2-micro VM, and a private Cloud
  Storage bucket, set up through this app's entry in `apps.yaml` (`storage: true`, `ai: gemini`). The Cloud Run service
  account signs download and upload links through IAM, so no key file is needed. Set `STORAGE_BUCKET` and
  `AI_PROVIDER=gemini` with a key.
- **AWS, Azure, Oracle Cloud.** The image runs there too (Lambda, Container Apps, a VM with Caddy). Only the `gcs`
  storage driver exists, so without a bucket the app reports `storage: none`: scanning is off and manual entry,
  the monthly report and CSV export still work. Adding a driver for another cloud's object store is the next step.

Set `MIGRATE_ON_START=true` and the server applies pending migrations before taking traffic, under a Postgres advisory
lock so instances starting together don't race. `pnpm db:migrate` does the same by hand.

## 2-minute demo script

Use the live URL. Have `public/demo-receipts/bluebird-coffee.png` on your phone or laptop.

1. **Open the landing page** (0:00). Read the "Demo data only" banner, then click Sign in and create an account.
   *Proves: open sign-up, and the demo-data warning is shown before anyone uploads anything.*
2. **Scan the receipt** (0:20). Go to Scan a receipt. On a phone, tap Take photo; on a laptop, Choose file and pick
   `bluebird-coffee.png`. Watch the upload bar, then "Reading the receipt".
   *Proves: the browser shrinks the photo and uploads straight to a private bucket, then one model call reads it.*
3. **Review the draft** (0:50). The photo sits beside a prefilled form: Bluebird Coffee, 12.40 USD, tax 0.95, meals, with a
   confidence badge. Change the category to something else. Point out "Nothing is saved until you press Save."
   *Proves: the AI fills a form and the person decides.*
4. **Save and read the month** (1:10). Press Save. The list opens on October 2026 with the new row, a total tile, and the
   bar chart by category moved to match.
   *Proves: money handled in cents, totals per currency, a monthly report.*
5. **Export** (1:25). Press Export CSV and open the file.
   *Proves: a clean export of the month.*
6. **Privacy check** (1:35). Open the expense to see the receipt preview (a 300-second signed link). Copy the page URL, open
   a private window, sign up a second user and paste it.
   *Proves: someone else gets a 404, not a "forbidden" page. Admins get the same 404.*
7. **Optional, if time allows** (1:50). Upload `landscape.png`. You get "This doesn't look like a receipt. Nothing was
   saved." Or upload `injection.png`, a receipt that prints instructions to the AI, and check the form still needs your
   Save.
   *Proves: bad input and hostile text don't create expenses.*

If the live model is over its free quota, step 3 shows a "Demo AI" badge and the recorded Bluebird answer instead. That
is the fallback working, and the form says so.
