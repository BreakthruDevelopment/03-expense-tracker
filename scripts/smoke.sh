#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
#   BASE_URL=https://app3.breakthruventures.ai ./scripts/smoke.sh
#
# BASE_URL must be the app's own public URL (APP_URL): mutating routes require that Origin.
# Needs curl and jq. Signs up two throwaway users (smoke-a-*, smoke-b-*; they stay behind, as in
# app 2) and deletes every expense and receipt it creates, even when a check fails.
#
# Receipt scanning needs a storage driver (local or gcs). When the health endpoint reports
# "none" the receipt section is skipped, unless REQUIRE_RECEIPTS=1 (CI and the live run set it).
#   FIXTURE=path/to/image.jpg overrides the receipt image.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
FIXTURE="${FIXTURE:-$(cd "$(dirname "$0")" && pwd)/fixtures/receipt.jpg}"
REQUIRE_RECEIPTS="${REQUIRE_RECEIPTS:-0}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
EXPENSES=(); RECEIPTS=()

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
warn() { echo "warn - $*" >&2; }

command -v jq >/dev/null || fail "jq is required"
[ -r "$FIXTURE" ] || fail "receipt fixture not found: $FIXTURE"

# Best effort: A deletes what the run created. Never changes the exit code.
cleanup() {
  local code=$?
  set +e
  local id
  for id in ${EXPENSES[@]+"${EXPENSES[@]}"}; do
    curl -s -o /dev/null -b "$JAR_A" -X DELETE -H "origin: $BASE_URL" "$BASE_URL/api/expenses/$id"
  done
  for id in ${RECEIPTS[@]+"${RECEIPTS[@]}"}; do
    curl -s -o /dev/null -b "$JAR_A" -X DELETE -H "origin: $BASE_URL" "$BASE_URL/api/receipts/$id"
  done
  rm -f "$JAR_A" "$JAR_B"
  exit $code
}
trap cleanup EXIT

# req JAR METHOD PATH [BODY]: prints the body, then the status code on its own line.
req() {
  local jar=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -b "$jar" -c "$jar" -X "$method" -H "origin: $BASE_URL" -H 'content-type: application/json' -d "$body" -w '\n%{http_code}' "$BASE_URL$path"
  else
    curl -s -b "$jar" -c "$jar" -X "$method" -H "origin: $BASE_URL" -w '\n%{http_code}' "$BASE_URL$path"
  fi
}
status() { printf '%s' "$1" | tail -n1; }
body() { printf '%s' "$1" | sed '$d'; }
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# --- Health: the app (and its database) may still be starting ------------------------------
health=""
for _ in $(seq 1 60); do
  health=$(curl -fsS "$BASE_URL/api/health" 2>/dev/null) && break
  health=""; sleep 1
done
[ -n "$health" ] || fail "health endpoint not ready after 60 s at $BASE_URL"
[ "$(echo "$health" | jq -r .status)" = "ok" ] || fail "health not ok: $health"
STORAGE=$(echo "$health" | jq -r .storage)
case "$STORAGE" in gcs|local|none) ;; *) fail "health is missing the storage driver: $health" ;; esac
pass "health check (storage: $STORAGE)"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

# --- Signed out ---------------------------------------------------------------------------
for path in /expenses /expenses/new /admin; do
  code=$(code_of "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
code=$(code_of "$BASE_URL/api/expenses")
[ "$code" = "401" ] || fail "signed-out GET /api/expenses should be 401, got $code"
pass "signed-out pages redirect (307) and the API is 401"

# --- Sign up A and B (one retry if Better Auth rate-limits) --------------------------------
signup() {
  local jar=$1 email=$2 out
  for attempt in 1 2; do
    out=$(curl -s -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" -w '\n%{http_code}' \
      -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" "$BASE_URL/api/auth/sign-up/email")
    case "$(status "$out")" in
      2??) return 0 ;;
      429) [ "$attempt" = 1 ] && { sleep 11; continue; } ;;
    esac
    fail "sign-up failed for $email: $out"
  done
}
signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

# --- Manual expense, isolation, optimistic locking -----------------------------------------
out=$(req "$JAR_A" POST /api/expenses '{"merchant":"Smoke Cafe","spentOn":"2026-10-14","amount":"12.40","category":"meals"}')
[ "$(status "$out")" = "201" ] || fail "create expense: $out"
EXPENSE_ID=$(body "$out" | jq -r '.expense.id // empty')
UPDATED_AT=$(body "$out" | jq -r '.expense.updatedAt // empty')
[ -n "$EXPENSE_ID" ] && [ -n "$UPDATED_AT" ] || fail "could not read the new expense: $out"
EXPENSES+=("$EXPENSE_ID")
pass "A created a manual expense"

out=$(req "$JAR_A" GET "/api/expenses?month=2026-10")
[ "$(status "$out")" = "200" ] && body "$out" | grep -q "$EXPENSE_ID" || fail "A's list is missing the expense: $out"
out=$(req "$JAR_B" GET "/api/expenses?month=2026-10")
! body "$out" | grep -q "$EXPENSE_ID" || fail "B's list shows A's expense"
for method in GET DELETE; do
  out=$(req "$JAR_B" "$method" "/api/expenses/$EXPENSE_ID")
  [ "$(status "$out")" = "404" ] || fail "B $method on A's expense should be 404: $out"
done
out=$(req "$JAR_B" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"x\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "404" ] || fail "B PATCH on A's expense should be 404: $out"
pass "B gets 404 on A's expense (get, patch, delete) and its list is empty of it"

out=$(req "$JAR_A" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"first\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "200" ] || fail "PATCH expense: $out"
out=$(req "$JAR_A" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"stale\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "409" ] || fail "stale PATCH should be 409: $out"
pass "stale update is 409"

# --- Receipt scan: init, PUT with the returned headers, confirm, extract, save --------------
RECEIPT_EXPENSE=""
if [ "$STORAGE" = "none" ]; then
  [ "$REQUIRE_RECEIPTS" != "1" ] || fail "storage is none but REQUIRE_RECEIPTS=1"
  echo "skip - receipt scan (storage driver is none)"
else
  SIZE=$(wc -c < "$FIXTURE" | tr -d ' ')

  out=$(req "$JAR_A" POST /api/receipts/uploads "{\"contentType\":\"image/gif\",\"sizeBytes\":$SIZE}")
  [ "$(status "$out")" = "400" ] || fail "image/gif init should be 400: $out"
  out=$(req "$JAR_A" POST /api/receipts/uploads '{"contentType":"image/jpeg","sizeBytes":6291456}')
  [ "$(status "$out")" = "400" ] || fail "6 MB init should be 400: $out"
  pass "init refuses image/gif and 6 MB"

  out=$(req "$JAR_A" POST /api/receipts/uploads "{\"contentType\":\"image/jpeg\",\"sizeBytes\":$SIZE}")
  [ "$(status "$out")" = "201" ] || fail "upload init: $out"
  TICKET=$(body "$out")
  RID=$(echo "$TICKET" | jq -r '.receiptId // empty')
  PUT_URL=$(echo "$TICKET" | jq -r '.url // empty')
  METHOD=$(echo "$TICKET" | jq -r '.method // "PUT"')
  [ -n "$RID" ] && [ -n "$PUT_URL" ] || fail "upload ticket is incomplete: $TICKET"
  RECEIPTS+=("$RID")
  # Exactly the headers init returned (Content-Type, x-goog-content-length-range, x-goog-if-generation-match).
  HEADER_ARGS=()
  while IFS= read -r line; do HEADER_ARGS+=(-H "$line"); done < <(echo "$TICKET" | jq -r '.headers | to_entries[] | "\(.key): \(.value)"')
  [ "${#HEADER_ARGS[@]}" -ge 6 ] || fail "upload ticket has no headers: $TICKET"

  code=$(code_of -X "$METHOD" "${HEADER_ARGS[@]}" --data-binary "@$FIXTURE" "$PUT_URL")
  [ "$code" = "200" ] || fail "PUT to the signed URL should be 200, got $code"
  code=$(code_of -X "$METHOD" "${HEADER_ARGS[@]}" --data-binary "@$FIXTURE" "$PUT_URL")
  [ "$code" = "412" ] || fail "a second PUT to the same signed URL should be 412, got $code"
  pass "PUT with the returned headers is 200, a repeat is 412"

  out=$(req "$JAR_A" POST "/api/receipts/$RID/confirm")
  [ "$(status "$out")" = "200" ] || fail "confirm: $out"

  out=$(req "$JAR_B" POST "/api/receipts/$RID/extract")
  [ "$(status "$out")" = "404" ] || fail "B extract on A's receipt should be 404: $out"
  out=$(req "$JAR_A" POST "/api/receipts/$RID/extract")
  [ "$(status "$out")" = "200" ] || fail "extract: $out"
  EXTRACT=$(body "$out")
  MODE=$(echo "$EXTRACT" | jq -r '.mode // empty')
  case "$MODE" in
    live|demo)
      echo "$EXTRACT" | jq -e '
        .receiptId and .extraction.isReceipt == true and (.extraction.draft | type == "object")
        and (.extraction.draft.category | type == "string")
        and (.extraction.draft.lineItems | type == "array")
        and (.extraction.draft.total == null or (.extraction.draft.total | test("^-?[0-9]+\\.[0-9]{2}$")))
        and (.extraction.confidence | IN("high","medium","low"))
        and (.extraction.warnings | type == "array")' >/dev/null || fail "extract ($MODE) has no valid draft: $EXTRACT"
      pass "extract returned a valid draft (mode: $MODE)" ;;
    failed)
      echo "$EXTRACT" | jq -e '.extraction == null and (.message | type == "string")' >/dev/null || fail "extract (failed) has the wrong shape: $EXTRACT"
      if [ "$STORAGE" = "gcs" ]; then
        warn "extract mode is failed (provider flakiness?); the rest of the flow continues with manual values"
      else
        warn "extract mode is failed"
      fi ;;
    *) fail "extract mode should be live, demo or failed: $EXTRACT" ;;
  esac

  out=$(req "$JAR_B" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "404" ] || fail "B's signed URL for A's receipt should be 404: $out"
  out=$(req "$JAR_A" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "200" ] || fail "A's signed URL: $out"
  [ -n "$(body "$out" | jq -r '.url // empty')" ] || fail "A's signed URL response has no url: $out"
  pass "B gets 404 on A's receipt URL; A gets one"

  # A saves it as an expense, using the draft where there is one.
  DRAFT=$(echo "$EXTRACT" | jq -c '.extraction.draft // {}')
  PAYLOAD=$(jq -cn --argjson d "$DRAFT" --arg rid "$RID" --arg note "smoke-$RUN_ID" '{
    merchant: ($d.merchant // "Smoke Receipt"),
    spentOn: ($d.spentOn // "2026-10-15"),
    amount: ($d.total // "3.00"),
    category: ($d.category // "other"),
    currency: ($d.currency // "USD"),
    note: $note, receiptId: $rid}')
  out=$(req "$JAR_A" POST /api/expenses "$PAYLOAD")
  [ "$(status "$out")" = "201" ] || fail "save the scanned receipt as an expense: $out"
  RECEIPT_EXPENSE=$(body "$out" | jq -r '.expense.id // empty')
  [ -n "$RECEIPT_EXPENSE" ] || fail "no id for the receipt expense: $out"
  EXPENSES+=("$RECEIPT_EXPENSE")
  pass "A saved the receipt as an expense"
fi

# --- CSV is per user ------------------------------------------------------------------------
csv=$(curl -s -b "$JAR_A" "$BASE_URL/api/expenses/export.csv")
echo "$csv" | grep -q "Smoke Cafe" || fail "A's CSV is missing the manual expense"
csv_b=$(curl -s -b "$JAR_B" "$BASE_URL/api/expenses/export.csv")
! echo "$csv_b" | grep -q "Smoke Cafe" || fail "B's CSV contains A's expense"
if [ -n "$RECEIPT_EXPENSE" ]; then
  echo "$csv" | grep -q "smoke-$RUN_ID" || fail "A's CSV is missing the receipt expense"
  ! echo "$csv_b" | grep -q "smoke-$RUN_ID" || fail "B's CSV contains A's receipt expense"
fi
pass "CSV export has A's expenses and none of them in B's"

# --- Pages: owner only, new-expense, admin ---------------------------------------------------
code=$(code_of -b "$JAR_B" "$BASE_URL/expenses/$EXPENSE_ID")
[ "$code" = "404" ] || fail "another user's expense page should be 404, got $code"
code=$(code_of -b "$JAR_A" "$BASE_URL/expenses/$EXPENSE_ID")
[ "$code" = "200" ] || fail "owner's expense page should be 200, got $code"
page=$(curl -fsS -b "$JAR_B" "$BASE_URL/expenses/new") || fail "signed-in /expenses/new did not render"
echo "$page" | grep -q 'Enter manually' || fail "/expenses/new is missing the Enter manually tab"
code=$(code_of -b "$JAR_B" "$BASE_URL/admin")
[ "$code" = "307" ] || fail "non-admin /admin should redirect (307), got $code"
code=$(code_of -b "$JAR_B" "$BASE_URL/expenses/00000000-0000-4000-8000-000000000000")
[ "$code" = "404" ] || fail "unknown expense page should be 404, got $code"
pass "expense page is owner-only; new-expense renders; /admin redirects non-admins"

# The demo loader is admin only: signed out is 401, a normal user is 403.
code=$(code_of -X POST -H "origin: $BASE_URL" "$BASE_URL/api/admin/demo")
[ "$code" = "401" ] || fail "signed-out POST /api/admin/demo should be 401, got $code"
out=$(req "$JAR_B" POST /api/admin/demo)
[ "$(status "$out")" = "403" ] || fail "non-admin POST /api/admin/demo should be 403: $out"
pass "demo loader refuses signed-out and non-admin callers"

# --- Delete: the receipt goes with its expense ------------------------------------------------
if [ -n "$RECEIPT_EXPENSE" ]; then
  out=$(req "$JAR_A" DELETE "/api/expenses/$RECEIPT_EXPENSE")
  [ "$(status "$out")" = "204" ] || fail "delete the receipt expense: $out"
  out=$(req "$JAR_A" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "404" ] || fail "signed URL after delete should be 404: $out"
  pass "A deleted the receipt expense and its URL is 404"
fi
out=$(req "$JAR_A" DELETE "/api/expenses/$EXPENSE_ID")
[ "$(status "$out")" = "204" ] || fail "delete expense: $out"
out=$(req "$JAR_A" GET "/api/expenses/$EXPENSE_ID")
[ "$(status "$out")" = "404" ] || fail "deleted expense should be 404: $out"
pass "A deleted the manual expense"

echo "SMOKE PASS"
