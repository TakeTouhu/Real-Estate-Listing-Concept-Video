import type { ProviderError, ProviderErrorKind } from "./types";

/**
 * The **one** runtime authority for the provider-error vocabulary, and the
 * default retryability of each kind.
 *
 * It replaces the two partial sets this file used to carry. Those listed eight
 * of the nine kinds between them — `PROVIDER` appeared in neither and fell
 * through to a `? false : false` ternary — so neither set could answer "is this
 * string a kind?", and a tenth kind could have been added without either list
 * noticing. A `Record` keyed by the union answers both questions from one
 * declaration: omitting a key fails `tsc`, and the own keys are the membership
 * test (ADR-0031, following ADR-0029's `ASSET_EXECUTABILITY`).
 *
 * The values reproduce the previous behaviour exactly. Retry semantics are
 * **not** this milestone's subject; Phase 4C-3B-2 owns them.
 */
const KIND_DEFAULT_RETRYABLE: Record<ProviderErrorKind, boolean> = {
  NETWORK: true,
  RATE_LIMITED: true,
  TIMEOUT: true,
  AUTH: false,
  INVALID_INPUT: false,
  MODERATION: false,
  UNSUPPORTED: false,
  PROVIDER: false,
  UNKNOWN: false,
};

/**
 * Prototype-safe membership over the map above — `hasOwnProperty` rather than
 * `in`, so `"toString"` and `"__proto__"` are not kinds.
 */
export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(KIND_DEFAULT_RETRYABLE, value)
  );
}

/** Whether a value is an integer HTTP status, and therefore safe to interpolate. */
export function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

export interface ProviderErrorInit {
  readonly kind: ProviderErrorKind;
  readonly code: string;
  readonly messageSanitized: string;
  readonly retryable?: boolean;
  /** Only ever an HTTP status actually received from the provider. */
  readonly providerStatus?: number;
}

export function providerError(init: ProviderErrorInit): ProviderError {
  return {
    kind: init.kind,
    code: init.code,
    messageSanitized: init.messageSanitized,
    retryable: init.retryable ?? KIND_DEFAULT_RETRYABLE[init.kind],
    ...(isHttpStatus(init.providerStatus) ? { providerStatus: init.providerStatus } : {}),
  };
}

/**
 * Validate an arbitrary value as a normalized provider error and return a
 * **fresh, clean** one — or `null`.
 *
 * Rebuilding rather than returning the input is the point. The predicate this
 * replaces asked only `"kind" in error && "retryable" in error` and then cast,
 * so any object carrying those two keys was admitted whole: unvalidated `code`
 * and `messageSanitized`, a non-boolean `retryable`, and — the real hazard —
 * every *other* property it happened to carry, straight into something that
 * gets stringified, logged and persisted. Copying exactly the five public
 * fields means no extra property can ride along, whatever the source.
 */
export function asProviderError(value: unknown): ProviderError | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isProviderErrorKind(candidate.kind)) return null;
  if (typeof candidate.retryable !== "boolean") return null;
  if (typeof candidate.code !== "string") return null;
  if (typeof candidate.messageSanitized !== "string") return null;
  if (candidate.providerStatus !== undefined && !isHttpStatus(candidate.providerStatus)) {
    return null;
  }
  return {
    kind: candidate.kind,
    retryable: candidate.retryable,
    code: candidate.code,
    messageSanitized: candidate.messageSanitized,
    ...(candidate.providerStatus === undefined
      ? {}
      : { providerStatus: candidate.providerStatus as number }),
  };
}

/**
 * Throwable wrapper so provider methods can reject with a normalized error.
 *
 * The `Error` half carries **only** the sanitized message. It deliberately does
 * not chain an external cause: `new Error(msg, { cause })` is what makes
 * `console.error(err)` print a fetch failure's host, port and address, and the
 * default rendering of a thrown value is the one place unsafe content escapes
 * without anyone choosing to log it (ADR-0031).
 */
export class ProviderErrorException extends Error {
  readonly error: ProviderError;

  constructor(error: ProviderError) {
    super(error.messageSanitized);
    this.name = "ProviderErrorException";
    this.error = error;
  }
}

export function isProviderErrorException(value: unknown): value is ProviderErrorException {
  return value instanceof ProviderErrorException;
}
