import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  inspectImageBytes,
  MAX_IMAGE_DIMENSION,
  MAX_UPLOAD_BYTES,
} from "./imageValidation";
import { isWellFormedUploadToken, sha256Hex } from "./uploadToken";

/**
 * POST /uploads/image — the only way bytes enter an image upload intent
 * (AUD-009). The browser calls it cross-origin (app origin -> Convex site
 * origin) with:
 *   X-Upload-Intent: <intentId from createUploadIntent>
 *   X-Upload-Token:  <uploadToken from createUploadIntent>
 *   body:            raw image bytes
 * The token, not a cookie or ctx.auth, is the credential; session access was
 * checked when the intent was created and is re-checked at commit.
 */

export const UPLOAD_INTENT_HEADER = "X-Upload-Intent";
export const UPLOAD_TOKEN_HEADER = "X-Upload-Token";

/** App origins allowed to call the upload endpoint from a browser. */
function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of [process.env.SITE_URL, process.env.PREVIEW_URL]) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Ignore malformed configuration
    }
  }
  return origins;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins().has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      `Content-Type, ${UPLOAD_INTENT_HEADER}, ${UPLOAD_TOKEN_HEADER}`,
    );
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

function json(request: Request, status: number, body: Record<string, unknown>): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Read the request body, aborting as soon as it exceeds `maxBytes` (whether or
 * not a Content-Length was sent). Returns null when the cap is exceeded.
 */
async function readBodyWithCap(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const imageUploadPreflight = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins().has(origin)) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
});

export const imageUpload = httpAction(async (ctx, request) => {
  // Browsers from other sites are refused outright; requests without an
  // Origin (non-browser clients) still need the secret token.
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins().has(origin)) {
    return json(request, 403, { error: "Origin not allowed" });
  }

  const intentId = request.headers.get(UPLOAD_INTENT_HEADER);
  const uploadToken = request.headers.get(UPLOAD_TOKEN_HEADER);
  if (!intentId || intentId.length > 64 || !isWellFormedUploadToken(uploadToken)) {
    return json(request, 403, { error: "Invalid upload token" });
  }
  const uploadTokenHash = sha256Hex(uploadToken);

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_UPLOAD_BYTES) {
    return json(request, 413, { error: "Image must be at most 5MB" });
  }

  // Validate the intent before reading (and paying for) the body
  const precheck = await ctx.runQuery(internal.images.checkUploadIntent, {
    intentId,
    uploadTokenHash,
  });
  if (!precheck.ok) {
    return json(request, precheck.status, { error: precheck.error });
  }

  const bytes = await readBodyWithCap(request, MAX_UPLOAD_BYTES);
  if (bytes === null) {
    return json(request, 413, { error: "Image must be at most 5MB" });
  }
  if (bytes.byteLength === 0) {
    return json(request, 400, { error: "Uploaded file is empty" });
  }

  const decoded = inspectImageBytes(bytes);
  if (!decoded) {
    return json(request, 415, {
      error: "Uploaded file is not a valid PNG, JPEG, GIF, or WebP image",
    });
  }
  if (decoded.width > MAX_IMAGE_DIMENSION || decoded.height > MAX_IMAGE_DIMENSION) {
    return json(request, 422, {
      error: `Image dimensions must not exceed ${MAX_IMAGE_DIMENSION}px`,
    });
  }

  // Serve with the decoded type, never the client's Content-Type
  const storageId = await ctx.storage.store(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: decoded.mimeType }),
  );
  const recordUpload = () =>
    ctx.runMutation(internal.images.attachUploadToIntent, {
      intentId,
      uploadTokenHash,
      storageId,
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
    });
  let result: Awaited<ReturnType<typeof recordUpload>>;
  try {
    result = await recordUpload();
  } catch (error) {
    // The recording mutation failed outright; don't leave an orphan blob
    await ctx.storage.delete(storageId).catch(() => {});
    throw error;
  }
  if (!result.ok) {
    // attachUploadToIntent already deleted the blob in its transaction
    return json(request, result.status, { error: result.error });
  }

  return json(request, 200, {
    ok: true,
    mimeType: decoded.mimeType,
    width: decoded.width,
    height: decoded.height,
  });
});
