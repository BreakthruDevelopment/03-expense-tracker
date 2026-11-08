import "server-only";
import { env } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { isValidObjectKey } from "./keys";
import { checkLocalPutHeaders, verifyLocalUrl, type LocalUrlParams } from "./local";

/** Verify the signature, expiry, operation and (for PUT) the signed headers of a local storage request. */
export function checkLocalUrlRequest(key: string, request: Request, op: "put" | "get"): LocalUrlParams {
  // A key that could never have been issued is a 404, not a signature failure.
  if (!isValidObjectKey(key)) throw new NotFoundError();
  const params = verifyLocalUrl(env().BETTER_AUTH_SECRET, key, new URL(request.url).searchParams, op);
  if (op === "put") checkLocalPutHeaders(params, request.headers);
  return params;
}
