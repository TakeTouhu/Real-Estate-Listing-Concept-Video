import { NextResponse } from "next/server";
import { AppError, toErrorEnvelope } from "@app/shared";
import { pathWithQuery, seeOther } from "./redirect";

/**
 * Map an error to a JSON error envelope response (never leaks internals). A
 * rate limit's refusal, with its whole seconds to wait, also answers
 * `Retry-After` and `Cache-Control: no-store` (ADR-0173 Decision 7).
 */
export function appErrorToResponse(error: unknown): NextResponse {
  const appError =
    error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Unexpected error");
  const response = NextResponse.json(toErrorEnvelope(appError, crypto.randomUUID()), {
    status: appError.httpStatus,
  });
  const seconds = appError.details?.retryAfterSeconds;
  const waits = typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 1;
  if (appError.code === "RATE_LIMITED" && waits) {
    response.headers.set("Retry-After", String(seconds));
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}

/** Redirect (303) back to a form page's path with a sanitized error message. */
export function redirectWithError(path: string, message: string): NextResponse {
  return seeOther(pathWithQuery(path, { error: message }));
}

/** The request's form, or an empty one when its body is not a form, so a route answers as for missing fields. */
export async function formOf(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

export function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}
