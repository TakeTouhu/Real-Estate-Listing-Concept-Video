import { verifyStorageToken } from "@app/storage";
import { getServerEnv } from "@/lib/env";
import { getPropertyServices } from "@/lib/property";
import { parseRangeHeader, storageContentType } from "@/lib/storage-read";

export const dynamic = "force-dynamic";

/** No answer is ever kept by a shared cache. */
const NOT_CACHED = { "Cache-Control": "private, no-store" } as const;

/** Every answer about an object is private, and never run as a page. */
const PRIVATE_HEADERS = {
  ...NOT_CACHED,
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Accept-Ranges": "bytes",
} as const;

/**
 * Signed download/preview endpoint. The token authorizes exactly one storage
 * key for download only; upload tokens are rejected. Responses are private and
 * must never be cached by shared caches.
 *
 * The object is streamed as it is sent, never read whole, and one byte range
 * of it is served when asked for, so a video plays and seeks (ADR-0115).
 */
export async function GET(request: Request): Promise<Response> {
  const response = await answer(request);
  cancelWhenAborted(request.signal, response.body);
  return response;
}

/** The same answer without its body, which is let go at once. */
export async function HEAD(request: Request): Promise<Response> {
  const response = await answer(request);
  await response.body?.cancel();
  return new Response(null, { status: response.status, headers: response.headers });
}

async function answer(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401, headers: NOT_CACHED });

  const verified = verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "download");
  if (!verified) return new Response("Unauthorized", { status: 401, headers: NOT_CACHED });

  // No validator is ever sent, so a range made conditional on one is never
  // met, and the whole object is served (RFC 9110, section 13.1.5).
  const range = request.headers.has("if-range") ? null : parseRangeHeader(request.headers.get("range"));
  const read = await getPropertyServices().storage.readObject(verified.key, range);
  if (read.kind === "ABSENT") return new Response("Not found", { status: 404, headers: NOT_CACHED });
  if (read.kind === "UNSATISFIABLE") {
    return new Response(null, {
      status: 416,
      headers: { ...PRIVATE_HEADERS, "Content-Range": `bytes */${read.size}` },
    });
  }

  const headers: Record<string, string> = {
    ...PRIVATE_HEADERS,
    "Content-Type": storageContentType(verified.key),
    "Content-Length": String(read.length),
  };
  // An empty object is served whole: no Content-Range can name none of its bytes.
  if (range === null || read.length === 0) return new Response(read.body, { status: 200, headers });
  headers["Content-Range"] = `bytes ${read.start}-${read.start + read.length - 1}/${read.size}`;
  return new Response(read.body, { status: 206, headers });
}

/**
 * Lets go of what the store holds open for a body that will never be sent: a
 * client gone before the body is piped leaves nothing to read or cancel it.
 * Once piped, the pipe cancels it on an abort itself, so a locked body is left
 * to it.
 */
function cancelWhenAborted(signal: AbortSignal, body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  const cancel = (): void => {
    if (!body.locked) void body.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
}
