/**
 * Re-export of the shared deep-freeze utility, kept so existing imports resolve
 * while the implementation lives in `@app/shared`.
 *
 * It moved because it is not this package's: the pricing domain freezes catalogs
 * with exactly the same discipline, and `@app/domain` cannot import
 * `@app/video-providers` — the dependency runs the other way. Two copies of
 * "frozen means frozen all the way down" would eventually disagree.
 */
export { deepFreeze } from "@app/shared";
