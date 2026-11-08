/** Browser-only helpers for the receipt upload: shrink the photo, then PUT it with progress. */

export const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/** Refuse anything bigger before decoding it: a huge file can exhaust a phone's memory. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** Above this size the file is probably larger than 1600 px, so ask the decoder to shrink while decoding. */
const HINT_RESIZE_BYTES = 1024 * 1024;

export class ImageDecodeError extends Error {}
export class ImageTooLargeError extends Error {}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    // Applies the photo's EXIF rotation, so a phone portrait isn't sideways after re-encoding.
    // For big files the width hint makes the decoder shrink while decoding (the aspect ratio is kept);
    // the canvas below does the exact fit, and browsers that reject the options get a plain decode.
    const attempts: ImageBitmapOptions[] =
      file.size > HINT_RESIZE_BYTES
        ? [{ imageOrientation: "from-image", resizeWidth: MAX_EDGE, resizeQuality: "high" }, { imageOrientation: "from-image" }]
        : [{ imageOrientation: "from-image" }];
    for (const options of attempts) {
      try {
        const bmp = await createImageBitmap(file, options);
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch {
        // Try the next option set, then the <img> path.
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    // The URL stays alive until the caller has drawn the image and calls close().
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageDecodeError("decode failed");
  }
}

/** Resize to at most 1600 px on the long edge and re-encode as JPEG (which also drops EXIF and GPS data). */
export async function resizeToJpeg(file: Blob): Promise<Blob> {
  if (file.size > MAX_INPUT_BYTES) throw new ImageTooLargeError("file too large");
  const img = await decode(file);
  try {
    if (!img.width || !img.height) throw new ImageDecodeError("empty image");
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageDecodeError("no canvas");
    // JPEG has no transparency: paint white first so a transparent PNG doesn't turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob || blob.size === 0) throw new ImageDecodeError("encode failed");
    return blob;
  } finally {
    img.close();
  }
}

export type UploadTicket = { receiptId: string; url: string; method: string; headers: Record<string, string> };

/** PUT with XHR (fetch can't report upload progress), sending exactly the headers the server signed. */
export function putWithProgress(
  ticket: UploadTicket,
  body: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const xhr = new XMLHttpRequest();
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.ontimeout = () => reject(new Error("upload timed out"));
    xhr.timeout = 60_000;
    xhr.send(body);
  });
}
