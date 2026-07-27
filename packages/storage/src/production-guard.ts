/**
 * Fail-fast guard preventing development-only adapters from being selected in
 * production. `LocalObjectStorage` and `PassthroughMalwareScanner` implement
 * their ports well enough for local development and tests, but are not
 * production-safe (see ADR-0008): storage is in-process and non-durable, and
 * the scanner only recognises the EICAR test signature.
 *
 * The message names the offending adapter and the required replacement, and
 * deliberately contains no configuration values or secrets.
 */
export class NonProductionAdapterError extends Error {
  readonly adapter: string;

  constructor(adapter: string, reason: string, replacement: string) {
    super(
      `${adapter} is a non-production adapter and must not be used when NODE_ENV=production. ` +
        `Reason: ${reason}. Required action: ${replacement}.`,
    );
    this.name = "NonProductionAdapterError";
    this.adapter = adapter;
  }
}

export interface ProductionGuardOptions {
  /**
   * Escape hatch for deliberately exercising these adapters against a
   * production-like NODE_ENV (for example a staging smoke test). Never set this
   * in a real production deployment.
   */
  readonly allowInProduction?: boolean;
  /** Injectable for tests; defaults to the ambient NODE_ENV. */
  readonly nodeEnv?: string;
}

/**
 * Throw when a non-production adapter is constructed under
 * `NODE_ENV=production`. Any other environment (development, test, unset) is
 * unaffected, so local development and the test suite continue to work.
 */
export function assertNotProduction(
  adapter: string,
  reason: string,
  replacement: string,
  options: ProductionGuardOptions = {},
): void {
  if (options.allowInProduction === true) return;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new NonProductionAdapterError(adapter, reason, replacement);
  }
}
