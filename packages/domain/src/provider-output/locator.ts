/**
 * Where a provider says its finished output can be fetched from, held in a way
 * that cannot be written down.
 *
 * A provider's output location is a signed URL, or an opaque download handle, or
 * some other transient vendor-specific token. Three facts about it decide the
 * whole design of this type:
 *
 * - **It is a credential.** A signed URL is bearer authorization in URL form.
 *   Anyone holding it can fetch the customer's video until it expires.
 * - **It expires.** Persisting it produces a column that is wrong within hours
 *   and misleading forever after, which is why ADR-0016 and ADR-0038 both refuse
 *   one.
 * - **It is external text.** It arrives from a vendor's response body, so it is
 *   exactly the kind of value that ends up in a log line, an error message, a
 *   spread into an audit record, or a `JSON.stringify` of a result object.
 *
 * So the raw value is stored in a `#` private field and **there is no way to
 * read it back**. Not a getter, not `toString`, not `toJSON`, not enumeration,
 * not spread. That is deliberately inconvenient: the capability a real transfer
 * adapter will need — actually dereferencing the locator — is a network
 * capability, and it will be added and reviewed *together with* that adapter
 * rather than sitting here unused and available.
 *
 * The consequence worth stating plainly: this phase can carry a locator from a
 * status source to a transfer port, and can prove it never leaks, but cannot
 * itself fetch anything with it. That is the intended shape of a dormant phase.
 */

/** What a redacted locator renders as, everywhere it might be rendered. */
export const REDACTED_LOCATOR = "[redacted provider output locator]";

export class TransientProviderOutputLocator {
  /**
   * The nominal identity, following the `ReconciliationPolicy` idiom.
   *
   * `#validated in value` is true only for objects this class constructed. It
   * cannot be faked by a structural copy — which matters here, because the
   * orchestration boundary must be able to tell a real locator from
   * `{ }` or from a raw string somebody cast into position.
   */
  readonly #validated: true;

  /**
   * The provider's transient location.
   *
   * Written once and never read by anything that could reveal it. The only
   * reader in this module is {@link equals}, which compares two locators
   * without disclosing either.
   */
  readonly #raw: string;

  private constructor(raw: string) {
    this.#validated = true;
    this.#raw = raw;
  }

  /**
   * Build a locator from a value nobody has checked, or refuse.
   *
   * The status source returns `unknown`, so this is a boundary between a
   * vendor's response and the application. A blank string is refused explicitly:
   * it satisfies every "is it present" check while naming nothing, and a
   * transfer against it would fail in a way that looks like a provider problem.
   */
  static fromUnknown(value: unknown): TransientProviderOutputLocatorResult {
    if (typeof value !== "string") return { ok: false, reason: "NOT_A_STRING" };
    if (value.trim().length === 0) return { ok: false, reason: "BLANK" };
    return { ok: true, value: new TransientProviderOutputLocator(value) };
  }

  /** Whether a value is a locator this class actually constructed. */
  static isLocator(value: unknown): value is TransientProviderOutputLocator {
    return typeof value === "object" && value !== null && #validated in value;
  }

  /**
   * Whether two locators name the same location, without revealing either.
   *
   * Exists so a test can assert that the locator handed to the transfer port is
   * the one the status source produced — a claim that would otherwise require
   * exposing the value to check.
   */
  equals(other: TransientProviderOutputLocator): boolean {
    return this.#raw === other.#raw;
  }

  /**
   * Redacted, on every path a value can accidentally become text.
   *
   * A `#` field is already invisible to `JSON.stringify`, spread and
   * `Object.keys`. These three exist for the case that worries me more: someone
   * interpolating the object into a log line or an error message, where the
   * default would be `[object Object]` and a future refactor to a plain object
   * would silently start printing a credential. Overriding them means the
   * redaction is stated rather than inherited.
   */
  toString(): string {
    return REDACTED_LOCATOR;
  }

  toJSON(): string {
    return REDACTED_LOCATOR;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED_LOCATOR;
  }
}

export type TransientProviderOutputLocatorResult =
  | { readonly ok: true; readonly value: TransientProviderOutputLocator }
  | { readonly ok: false; readonly reason: "NOT_A_STRING" | "BLANK" };
