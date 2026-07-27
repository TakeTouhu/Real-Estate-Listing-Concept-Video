import { NextResponse } from "next/server";
import { verifyStorageToken } from "@app/storage";
import { getServerEnv } from "@/lib/env";
import { getPropertyServices } from "@/lib/property";

export const dynamic = "force-dynamic";

/** Hard cap on a single request body, independent of domain limits. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Signed upload endpoint. Authorization comes solely from the short-lived,
 * single-purpose token, which binds the request to one storage key. No session
 * is required, and no key can be supplied by the caller directly.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }
  const verified = verifyStorageToken(token, getServerEnv().STORAGE_SIGNING_SECRET, "upload");
  if (!verified) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Invalid or expired upload token" } },
      { status: 401 },
    );
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED" } }, { status: 422 });
  }
  if (body.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED" } }, { status: 413 });
  }

  await getPropertyServices().storage.putObject(verified.key, body);
  return NextResponse.json({ ok: true, bytes: body.byteLength });
}
