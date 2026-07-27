import type { ProviderError, ProviderErrorKind } from "./types";

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "NETWORK",
  "RATE_LIMITED",
  "TIMEOUT",
]);

/** Kinds that must NOT be retried automatically (WaveSpeedAIIntegration.md). */
const NON_RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "AUTH",
  "INVALID_INPUT",
  "MODERATION",
  "UNSUPPORTED",
  "UNKNOWN",
]);

export interface ProviderErrorInit {
  readonly kind: ProviderErrorKind;
  readonly code: string;
  readonly messageSanitized: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export function providerError(init: ProviderErrorInit): ProviderError {
  const retryable =
    init.retryable ??
    (RETRYABLE_KINDS.has(init.kind) ? true : NON_RETRYABLE_KINDS.has(init.kind) ? false : false);
  return {
    kind: init.kind,
    code: init.code,
    messageSanitized: init.messageSanitized,
    retryable,
    ...(init.cause === undefined ? {} : { cause: init.cause }),
  };
}

/** Throwable wrapper so provider methods can reject with a normalized error. */
export class ProviderErrorException extends Error {
  readonly error: ProviderError;

  constructor(error: ProviderError) {
    super(error.messageSanitized, error.cause === undefined ? undefined : { cause: error.cause });
    this.name = "ProviderErrorException";
    this.error = error;
  }
}

export function isProviderErrorException(value: unknown): value is ProviderErrorException {
  return value instanceof ProviderErrorException;
}
