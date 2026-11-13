/**
 * The key of `table` that a page's `?notice=` or `?error=` parameter names, or
 * `null` for anything else: a repeated parameter, or a name every object
 * inherits, such as `constructor`.
 */
export function codeOf<T extends object>(table: T, param: string | readonly string[] | undefined): keyof T | null {
  return typeof param === "string" && Object.hasOwn(table, param) ? (param as keyof T) : null;
}
