import { verifyStorageToken } from "@app/storage";
import { getServerEnv } from "@/lib/env";
import { getPropertyServices } from "@/lib/property";

export const dynamic = "force-dynamic";

/**
 * Signed download/preview endpoint. The token authorizes exactly one storage
 * key for download only; upload tokens are rejected. Responses are private and
 * must never be cached by shared caches.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Unauthorized", { status: 401 });

  const verified = verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "download");
  if (!verified) return new Response("Unauthorized", { status: 401 });

  const data = await getPropertyServices().storage.getObject(verified.key);
  if (!data) return new Response("Not found", { status: 404 });

  const contentType = verified.key.endsWith(".webp")
    ? "image/webp"
    : verified.key.endsWith(".jpg")
      ? "image/jpeg"
      : "application/octet-stream";

  return new Response(Buffer.from(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
