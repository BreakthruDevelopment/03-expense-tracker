import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { initUpload } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/**
 * POST /api/receipts/uploads. Body: { contentType: "image/jpeg"|"image/png"|"image/webp", sizeBytes }.
 * Returns { receiptId, url, method: "PUT", headers, expiresAt }. The browser must PUT the file to
 * `url` sending exactly `headers` (Content-Type, x-goog-content-length-range and x-goog-if-generation-match: 0 are signed; a second PUT gets 412), then
 * POST /api/receipts/:id/confirm.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json(await initUpload(user, await readJson(request)), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
