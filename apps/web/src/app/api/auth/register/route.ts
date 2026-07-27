import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { formString, redirectWithError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const email = formString(form, "email");
  const name = formString(form, "name");
  const password = formString(form, "password");
  const services = getIdentityServices();
  try {
    await services.auth.register({ email, name, password });
    const { token } = await services.auth.login(email, password);
    const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return response;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Registration failed";
    return redirectWithError(request.url, "/login", message);
  }
}
