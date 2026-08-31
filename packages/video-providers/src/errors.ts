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
 * Throwable wrapper so provider methods can reject with a normalized error.
 *
 * It is also the **only** trust boundary for an already-normalized error. That
 * check is nominal — `instanceof` — and it has to be. An earlier revision of
 * this milestone validated an arbitrary object's field *types* and rebuilt it,
 * which dropped extra properties but still let the object choose `code` and
 * `messageSanitized`: a hostile value with a valid `kind`, a boolean
 * `retryable` and a signed URL in `messageSanitized` satisfied every check.
 * Structural validation proves a shape, never provenance, and every field of a
 * `ProviderError` must be application-owned (ADR-0031 §4).
 *
 * The `Error` half carries **only** the sanitized message. It deliberately does
 * not chain an external cause: `new Error(msg, { cause })` is what makes
 * `console.error(err)` print a fetch failure's host, port and address, and the
 * default rendering of a thrown value is the one place unsafe content escapes
 * without anyone choosing to log it.
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
