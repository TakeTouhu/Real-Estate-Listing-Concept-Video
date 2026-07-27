import { NextResponse } from "next/server";
import { bearerFrom, verifyOperatorToken } from "@/lib/auth";
import { buildReadiness } from "@/lib/health";

// Authenticated readiness probe. Requires a valid operator bearer token.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!verifyOperatorToken(token)) {
    return NextResponse.json(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "Missing or invalid operator bearer token",
          requestId: crypto.randomUUID(),
          details: {},
        },
      },
      { status: 401 },
    );
  }

  const readiness = await buildReadiness();
  return NextResponse.json(readiness, { status: readiness.status === "ready" ? 200 : 503 });
}
