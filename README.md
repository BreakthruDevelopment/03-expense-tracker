# Expense Tracker

The starting point for every app in Breakthru Ventures' **30 apps in 30 days** portfolio. Each app is a
responsive web app with a Postgres database, sign-in with roles, one AI feature, and a single container
image that deploys to AWS, Azure, Google Cloud or Oracle Cloud.

## What this app does

_Each app replaces this section: the customer problem, who uses it, and what the AI feature does._

Users photograph receipts, review what the AI read from them and keep a monthly expense report. Receipt images are
private files in a Cloud Storage bucket (signed URLs only), and nothing is saved until the user confirms.
_This section is expanded by the docs issue; the data layer and storage module are in place._

Storage: `src/lib/storage` has a `gcs` driver (V4 signed URLs signed through IAM `signBlob`, no key files), a `local`
driver for development and CI (HMAC-signed URLs served by `/api/storage/local/...`) and a `none` driver (scanning off).
`STORAGE_BUCKET` selects `gcs`; unset means `local` outside production.

API (all owner-only: another user's, and admin's, request for an expense or receipt is a 404; cookie mutations need
our own `Origin`; JSON bodies are capped at 16 KB):

| Route | What it does |
| --- | --- |
| `GET/POST /api/expenses` | List own (`month=YYYY-MM`, `category`, `page`, `pageSize`); create. `amount` and `tax` are strings like `"12.40"`, stored as integer minor units. `receiptId` attaches the caller's own `ready` draft |
| `GET/PATCH/DELETE /api/expenses/[id]` | PATCH needs the `updatedAt` you loaded (409 when stale); DELETE removes the image first |
| `GET /api/expenses/summary?month=` | Totals by category, per currency |
| `GET /api/expenses/export.csv?from=&to=` | Own rows only (at most 5,000); cells starting with `= + - @`, tab or CR get a leading `'` |
| `POST /api/receipts/uploads` | `{contentType, sizeBytes}` returns `{receiptId, url, method: "PUT", headers, expiresAt}` |
| `POST /api/receipts/[id]/confirm` | Reads the object back, checks real size and magic bytes (JPEG, PNG, WebP); a wrong file is deleted (422) |
| `GET /api/receipts/[id]/url` | Fresh 300-second signed download URL |
| `DELETE /api/receipts/[id]` | Discard a draft (object, then row) |
| `GET /api/admin/stats`, `POST /api/admin/users/[id]/purge-receipts` | Admin: aggregate counts and caps; delete one user's images |

**Upload flow.** `POST /api/receipts/uploads`, then `PUT` the file to `url`, then `POST /api/receipts/[id]/confirm`.
The browser must send exactly the returned `headers` on the PUT: `Content-Type` and `x-goog-content-length-range`
(`1,<sizeBytes>`) are part of the signature, so any other type, or a body outside that size range, is refused by
storage with a 400. Caps (all fail closed): 30 receipts per user, 20 uploads per user per hour, 100 uploads a day
app-wide, `STORAGE_MAX_BYTES` stored in total (real sizes after confirm). Unconfirmed uploads older than an hour and
unused drafts older than a day are swept. Removing a user through the admin plugin purges their images first (a
before-hook on `/admin/remove-user`), so a storage failure aborts the removal with nothing deleted. A database hook on
user deletion purges again as a backstop for other paths (such as self-delete), but Better Auth has already removed that
user's sessions and accounts by then, so only the hook protects the admin path. That protection covers storage failures only: if the caller's session or role
changes, or the database fails, between the hook and the endpoint, the receipts can be purged while the user remains;
retrying the removal finishes it.

The signed upload also carries `x-goog-if-generation-match: 0` (create only): a second `PUT` to the same URL gets a 412,
so a confirmed image can't be overwritten inside the 5-minute window. Magic-byte checks prove a file *starts* like a
JPEG, PNG or WebP, not that it is only that: a polyglot (valid image, plus script or archive bytes) passes. That is
acceptable because images are only ever served with a forced `image/*` type and `inline` disposition from the storage
host, never the app origin, and are only decoded by the model provider.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle; pgvector available for RAG)
   └──► Model API (Gemini free tier, Claude optional, or recorded demo answers)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access rules | `src/lib/auth/rbac.ts`, enforced in every data function |
| AI gateway | `src/lib/ai/` — input cap, JSON schema validation, demo fallback |
| Health check | `GET /api/health` (503 if the database is down) |

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed`
while the app is running.

### Demo data

Three demo users (Ada, Ben, Cleo at `@demo.breakthru.test`) own 30 fictional expenses over the last three months;
five have a synthetic receipt image (`public/demo-receipts/`, drawn by `pnpm demo:receipts`) and a pre-filled
extraction with `extraction_mode = demo`, so no model call is made.

- Locally: `DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ chars> pnpm seed:demo` (Ada becomes an admin
  and all three get that password). It refuses a production `APP_URL` (`app3.breakthruventures.ai`, `*.run.app`,
  `*.azurecontainerapps.io`) or Azure database host.
- Live: an admin posts to `POST /api/admin/demo` (no body, same-origin; 1 per minute and 5 per day app-wide). Demo users
  get random passwords nobody knows. Either way, a reload replaces only the demo users' expenses and receipt objects.

## Design system

Every app shares the Breakthru look (guide and concept: `ai-dev-os/design/`). Tokens live in `src/app/globals.css`
(light and dark; use `bg-surface`, `text-muted`, `border-border`, `bg-accent` and the status tokens, never raw colors).
Fonts load through `next/font/google` in `src/app/layout.tsx`: Newsreader (`font-display`), Public Sans (`font-sans`),
IBM Plex Mono (`font-mono`). Set the app's name once in `src/lib/app-config.ts` (`APP_TITLE`, or the `APP_NAME` variable).

| Component | Location | Use |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Header (logo, app name, nav, sign in or user and sign out) and footer; wraps every page in the root layout |
| `PageIntro` | `src/components/ui/` | Eyebrow, Newsreader headline, one-line description, actions |
| `StatTile`, `StatGrid` | `src/components/ui/` | A number and a label; tiles stack at 375px |
| `FilterBar` | `src/components/ui/` | Search, select filters, sort and table/cards toggle as a GET form (state in the URL) |
| `StatusBadge` | `src/components/ui/` | Live, building, blocked, not started (neutral), healthy, degraded, down |
| `DataList` | `src/components/ui/` | Table from 640px, cards below |
| `Panel` | `src/components/ui/` | Titled panel; `collapsible` adds a "Show all" toggle (small client component) |
| `DemoBadge` | `src/components/ui/` | "Demo data" label for seeded or demo content |

The header links come from `NAV_LINKS` in `src/lib/app-config.ts`; each app must edit that list (links break if the
app deletes those pages).

Shared button and field classes are in `src/components/ui/styles.ts` (44px minimum height). Don't add `loading.tsx` or
`<Suspense>` above a page that calls `requireRoleOrRedirect()` or `notFound()`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
```

CI runs all of these plus both container builds on every pull request.

## Deploy

Every push to `main` publishes a multi-arch image (x86 and ARM) to GitHub Container Registry as
`ghcr.io/breakthrudevelopment/<repo>:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys those tags to AWS, Azure, Google Cloud and Oracle Cloud with Terraform; this repo holds no cloud credentials.

With `MIGRATE_ON_START=true` the server applies pending migrations before taking traffic, holding a Postgres
advisory lock so instances starting together can't race. `pnpm db:migrate` does the same by hand.

## Using the AI feature

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `demo` (default) | Recorded answers from `src/lib/ai/demo.ts`; no key, no network |
| `gemini` | Google Gemini API (`GEMINI_API_KEY`, free tier) |
| `anthropic` | Claude (`ANTHROPIC_API_KEY`) |

With `AI_FALLBACK_TO_DEMO=true`, a quota error or outage serves the recorded answer and the UI says so.

### Images: `generate({ images })`

`generate()` takes an optional `images: { mimeType, data }[]` (base64 of the raw bytes, no `data:` prefix). Limits
(`input_rejected`, checked before any network call, in every mode): at most 4 images, 5 MB each decoded
(`MAX_IMAGE_BYTES`), 10 MB in total, MIME `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`, valid
base64. Gemini gets one `inlineData` part per image before the text part; Anthropic gets `image` blocks and rejects
HEIC/HEIF. `demo` answers from the task's fixture and ignores the images. Logs carry the image count and total bytes,
never the data. Treat text inside an image as data in your system prompt, exactly like user text.

### Embeddings: `embed()`

`embed({ task, texts, kind: "document" | "query" })` from `src/lib/ai` returns
`{ vectors, provider, model, dims, demo, latencyMs }`: 768-dim, L2-normalized vectors (fits pgvector's 2,000-dim
HNSW limit). Limits: 32 texts per call, 8,000 characters each, 64,000 in total (`input_rejected`).

- `gemini` calls `batchEmbedContents` with `AI_EMBED_MODEL` (default `gemini-embedding-2`, which takes the task in
  the text: `task: search result | query: …` / `title: none | text: …`; set `gemini-embedding-001` to use `taskType`).
  Changing the model changes the vector space: stored vectors must be re-embedded.
- `demo` (and a missing key, or a provider failure while `AI_FALLBACK_TO_DEMO=true`) uses deterministic hashed
  bag-of-words vectors, model `demo-hash-768`: lexical but meaningful, offline.
- `AI_PROVIDER=anthropic` has no embeddings API, so it embeds with Gemini if `GEMINI_API_KEY` is set, else demo.
- Always store `model` with each vector and only compare vectors with the same model; a demo fallback reports
  `demo: true` and the demo model name so vector spaces are never mixed.
- `AI_TIMEOUT_MS` (default 20000, max 22000) bounds every provider call, `generate()` and `embed()` alike.
- Logs carry task, provider, model, count and latency, never the text.
