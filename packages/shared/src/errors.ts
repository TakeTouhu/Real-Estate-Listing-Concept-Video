/**
 * Stable internal error codes. These are safe to surface in API error
 * envelopes; they never contain provider payloads or secrets.
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Base application error carrying a stable, client-safe code.
 * `message` is expected to be safe for logging and support; do not embed
 * secrets, signed URLs, or raw provider payloads.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultStatusFor(code);
    this.details = options.details;
  }
}

function defaultStatusFor(code: AppErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 422;
    case "RATE_LIMITED":
      return 429;
    case "CONFIGURATION_ERROR":
    case "PROVIDER_ERROR":
    case "INTERNAL_ERROR":
      return 500;
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: AppErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details: Record<string, unknown>;
  };
}

export function toErrorEnvelope(error: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      details: error.details ?? {},
    },
  };
}
