import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE } from "@/lib/auth";
import { logRequestFailure } from "@/lib/failure-log";
import { appErrorToResponse } from "@/lib/http";
import { getIdentityServices } from "@/lib/identity";
import { seeOther } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginPost(request, "POST /api/auth/logout")) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A session must be ended from this site"));
  }
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await getIdentityServices().auth.logout(token);
    } catch (error) {
      // Best-effort revocation; always clear the cookie below.
      logRequestFailure(error, "POST /api/auth/logout");
    }
  }
  const response = seeOther("/login");
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
