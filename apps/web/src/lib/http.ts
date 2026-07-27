import { NextResponse } from "next/server";
import { AppError, toErrorEnvelope } from "@app/shared";

/** Map an error to a JSON error envelope response (never leaks internals). */
export function appErrorToResponse(error: unknown): NextResponse {
  const appError =
    error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Unexpected error");
  return NextResponse.json(toErrorEnvelope(appError, crypto.randomUUID()), {
    status: appError.httpStatus,
  });
}

/** Redirect (303) back to a form page with a sanitized error message. */
export function redirectWithError(requestUrl: string, path: string, message: string): NextResponse {
  const url = new URL(path, requestUrl);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url, { status: 303 });
}

export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}
