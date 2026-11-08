import "server-only";
import { env } from "@/lib/env";
import { checkLocalPutHeaders, verifyLocalUrl, type LocalUrlParams } from "./local";

/** Verify the signature, expiry, operation and (for PUT) the signed headers of a local storage request. */
export function checkLocalUrlRequest(key: string, request: Request, op: "put" | "get"): LocalUrlParams {
  const params = verifyLocalUrl(env().BETTER_AUTH_SECRET, key, new URL(request.url).searchParams, op);
  if (op === "put") checkLocalPutHeaders(params, request.headers);
  return params;
}
