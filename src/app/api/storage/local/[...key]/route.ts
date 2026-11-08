import { MAX_RECEIPT_BYTES } from "@/lib/domain";
import { BadRequestError, NotFoundError, PayloadTooLargeError } from "@/lib/errors";
import { errorResponse, readBodyCapped } from "@/lib/http";
import { inlineDisposition, storage } from "@/lib/storage";
import { checkLocalUrlRequest } from "@/lib/storage/local-route";

export const dynamic = "force-dynamic";

/**
 * The local driver's stand-in for a Cloud Storage signed URL. The signature is the only
 * credential, exactly as with GCS. Only answers when the local driver is active (never in a deployment).
 */
function guard() {
  if (storage().kind !== "local") throw new NotFoundError();
}

export async function PUT(request: Request, ctx: RouteContext<"/api/storage/local/[...key]">) {
  try {
    guard();
    const { key } = await ctx.params;
    const p = checkLocalUrlRequest(key.join("/"), request, "put");
    if (p.max < 1 || p.max > MAX_RECEIPT_BYTES) throw new BadRequestError("Bad size range.");
    let bytes: Buffer;
    try {
      bytes = await readBodyCapped(request, p.max);
    } catch (err) {
      // GCS answers 400 for a PUT outside the signed range; so do we.
      if (err instanceof PayloadTooLargeError) throw new BadRequestError("Upload is larger than allowed.");
      throw err;
    }
    if (bytes.length < 1) throw new BadRequestError("Upload is empty.");
    // The signed header says create-only, like GCS: a second PUT to the same key is a 412.
    await storage().put(p.key, bytes, p.contentType, { ifAbsent: true });
    return new Response(null, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request, ctx: RouteContext<"/api/storage/local/[...key]">) {
  try {
    guard();
    const { key } = await ctx.params;
    const p = checkLocalUrlRequest(key.join("/"), request, "get");
    const object = await storage().read(p.key, MAX_RECEIPT_BYTES);
    if (!object) throw new NotFoundError();
    return new Response(new Uint8Array(object), {
      headers: {
        // Forced from the signature, never from what was uploaded.
        "content-type": p.contentType,
        "content-disposition": inlineDisposition(p.contentType),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
