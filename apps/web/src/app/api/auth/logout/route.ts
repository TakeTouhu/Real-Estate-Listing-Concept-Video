import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await getIdentityServices().auth.logout(token);
    } catch {
      // Best-effort revocation; always clear the cookie below.
    }
  }
  const response = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
