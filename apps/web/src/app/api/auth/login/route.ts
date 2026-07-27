import { NextResponse } from "next/server";
import { SESSION_COOKIE, createSessionToken, verifyOperatorToken } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const token = typeof form.get("token") === "string" ? String(form.get("token")) : undefined;

  if (!verifyOperatorToken(token)) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), { status: 303 });
  }

  const env = getServerEnv();
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.SESSION_TTL_SECONDS,
  });
  return response;
}
