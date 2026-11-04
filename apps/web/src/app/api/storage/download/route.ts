import { verifyStorageToken } from "@app/storage";
import { getServerEnv } from "@/lib/env";
import { getPropertyServices } from "@/lib/property";
import { parseRangeHeader, storageContentType } from "@/lib/storage-read";

export const dynamic = "force-dynamic";

/** Every answer is private, never cached by a shared cache, and never run as a page. */
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
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
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401 });

  const verified = verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "download");
  if (!verified) return new Response("Unauthorized", { status: 401 });

  const range = parseRangeHeader(request.headers.get("range"));
  const read = await getPropertyServices().storage.readObject(verified.key, range);
  if (read.kind === "ABSENT") return new Response("Not found", { status: 404 });
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
  if (range === null) return new Response(read.body, { status: 200, headers });
  headers["Content-Range"] = `bytes ${read.start}-${read.start + read.length - 1}/${read.size}`;
  return new Response(read.body, { status: 206, headers });
}
