#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and checks the signed-out redirects.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
echo "$health" | grep -Eq '"storage":"(gcs|local|none)"' || fail "health is missing the storage driver: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /expenses /expenses/new /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out expenses, new expense and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

# --- Expenses API ---------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/expenses")
[ "$code" = "401" ] || fail "signed-out GET /api/expenses should be 401, got $code"
pass "signed-out API is 401"

# curl wrapper: req JAR METHOD PATH [BODY]; prints the body, then the status on its own line.
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

out=$(req "$JAR_A" POST /api/expenses '{"merchant":"Smoke Cafe","spentOn":"2026-10-14","amount":"12.40","category":"meals"}')
[ "$(status "$out")" = "201" ] || fail "create expense: $out"
EXPENSE_ID=$(body "$out" | sed -n 's/.*"expense":{"id":"\([^"]*\)".*/\1/p')
UPDATED_AT=$(body "$out" | sed -n 's/.*"updatedAt":"\([^"]*\)".*/\1/p')
[ -n "$EXPENSE_ID" ] && [ -n "$UPDATED_AT" ] || fail "could not read the new expense: $out"
pass "A created an expense"

out=$(req "$JAR_A" GET "/api/expenses?month=2026-10")
[ "$(status "$out")" = "200" ] && body "$out" | grep -q "$EXPENSE_ID" || fail "A's list is missing the expense: $out"
out=$(req "$JAR_B" GET "/api/expenses?month=2026-10")
body "$out" | grep -q "$EXPENSE_ID" && fail "B's list shows A's expense"
for method in GET DELETE; do
  out=$(req "$JAR_B" "$method" "/api/expenses/$EXPENSE_ID")
  [ "$(status "$out")" = "404" ] || fail "B $method on A's expense should be 404: $out"
done
out=$(req "$JAR_B" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"x\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "404" ] || fail "B PATCH on A's expense should be 404: $out"
pass "list is per user; B gets 404 on A's expense"

out=$(req "$JAR_A" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"first\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "200" ] || fail "PATCH expense: $out"
out=$(req "$JAR_A" PATCH "/api/expenses/$EXPENSE_ID" "{\"note\":\"stale\",\"updatedAt\":\"$UPDATED_AT\"}")
[ "$(status "$out")" = "409" ] || fail "stale PATCH should be 409: $out"
pass "stale update is 409"

csv=$(curl -s -b "$JAR_A" "$BASE_URL/api/expenses/export.csv")
echo "$csv" | grep -q "Smoke Cafe" || fail "A's CSV is missing the expense"
csv=$(curl -s -b "$JAR_B" "$BASE_URL/api/expenses/export.csv")
echo "$csv" | grep -q "Smoke Cafe" && fail "B's CSV contains A's expense"
pass "CSV export is per user"

# Receipt upload round trip (init, PUT with the returned headers, confirm), where a storage driver exists.
if echo "$health" | grep -q '"storage":"none"'; then
  echo "skip - receipt upload (storage driver is none)"
else
  out=$(req "$JAR_A" POST /api/receipts/uploads '{"contentType":"image/gif","sizeBytes":100}')
  [ "$(status "$out")" = "400" ] || fail "image/gif upload should be 400: $out"
  out=$(req "$JAR_A" POST /api/receipts/uploads '{"contentType":"image/jpeg","sizeBytes":5242881}')
  [ "$(status "$out")" = "400" ] || fail "5 MB + 1 upload should be 400: $out"
  out=$(req "$JAR_A" POST /api/receipts/uploads '{"contentType":"image/jpeg","sizeBytes":64}')
  [ "$(status "$out")" = "201" ] || fail "upload init: $out"
  RID=$(body "$out" | sed -n 's/.*"receiptId":"\([^"]*\)".*/\1/p')
  PUT_URL=$(body "$out" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
  RANGE=$(body "$out" | sed -n 's/.*"x-goog-content-length-range":"\([^"]*\)".*/\1/p')
  [ -n "$RID" ] && [ -n "$PUT_URL" ] && [ -n "$RANGE" ] || fail "upload ticket is incomplete: $out"
  JPG="$(mktemp)"; trap 'rm -f "$JAR_A" "$JAR_B" "$JPG"' EXIT
  { printf '\xff\xd8\xff\xe0'; head -c 60 /dev/zero; } > "$JPG"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: image/jpeg' -H "x-goog-content-length-range: $RANGE" -H 'x-goog-if-generation-match: 0' --data-binary "@$JPG" "$PUT_URL")
  [ "$code" = "200" ] || fail "PUT to the signed URL should be 200, got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: image/jpeg' -H "x-goog-content-length-range: $RANGE" -H 'x-goog-if-generation-match: 0' --data-binary "@$JPG" "$PUT_URL")
  [ "$code" = "412" ] || fail "a second PUT to the same signed URL should be 412, got $code"
  out=$(req "$JAR_B" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "404" ] || fail "B's signed URL for A's receipt should be 404: $out"
  out=$(req "$JAR_A" POST "/api/receipts/$RID/confirm")
  [ "$(status "$out")" = "200" ] || fail "confirm: $out"
  out=$(req "$JAR_A" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "200" ] || fail "A's signed URL: $out"
  out=$(req "$JAR_A" POST /api/expenses "{\"merchant\":\"With Receipt\",\"spentOn\":\"2026-10-15\",\"amount\":\"3.00\",\"receiptId\":\"$RID\"}")
  [ "$(status "$out")" = "201" ] || fail "create expense with receipt: $out"
  RECEIPT_EXPENSE=$(body "$out" | sed -n 's/.*"expense":{"id":"\([^"]*\)".*/\1/p')
  out=$(req "$JAR_A" DELETE "/api/expenses/$RECEIPT_EXPENSE")
  [ "$(status "$out")" = "204" ] || fail "delete expense with receipt: $out"
  out=$(req "$JAR_A" GET "/api/receipts/$RID/url")
  [ "$(status "$out")" = "404" ] || fail "signed URL after delete should be 404: $out"
  pass "receipt upload, confirm, signed URL and delete"
fi

out=$(req "$JAR_A" DELETE "/api/expenses/$EXPENSE_ID")
[ "$(status "$out")" = "204" ] || fail "delete expense: $out"
out=$(req "$JAR_A" GET "/api/expenses/$EXPENSE_ID")
[ "$(status "$out")" = "404" ] || fail "deleted expense should be 404: $out"
pass "A deleted the expense"

# The demo loader is admin only: signed out is 401, a normal user is 403, and neither changes anything.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "origin: $BASE_URL" "$BASE_URL/api/admin/demo")
[ "$code" = "401" ] || fail "signed-out POST /api/admin/demo should be 401, got $code"
out=$(req "$JAR_B" POST /api/admin/demo)
[ "$(status "$out")" = "403" ] || fail "non-admin POST /api/admin/demo should be 403: $out"
pass "demo loader refuses signed-out and non-admin callers"

# Pages: a signed-in user gets the new-expense page, and a non-admin is sent away from /admin.
page=$(curl -fsS -b "$JAR_B" "$BASE_URL/expenses/new") || fail "signed-in /expenses/new did not render"
echo "$page" | grep -q 'Enter manually' || fail "/expenses/new is missing the Enter manually tab"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL/admin")
[ "$code" = "307" ] || fail "non-admin /admin should redirect (307), got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL/expenses/00000000-0000-4000-8000-000000000000")
[ "$code" = "404" ] || fail "unknown expense page should be 404, got $code"
pass "new-expense page renders, /admin redirects non-admins, unknown expense is 404"

echo "SMOKE PASS"
