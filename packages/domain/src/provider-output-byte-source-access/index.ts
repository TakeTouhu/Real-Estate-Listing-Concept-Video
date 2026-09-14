/**
 * The one narrow door to a transient provider-output locator's raw value.
 *
 * This subpath exists so that reading a locator's credential is a *deliberately
 * separate import* from everything else in `@app/domain`. The capability is not
 * on the package root and never will be — ordinary application, orchestration,
 * submission, polling and composition code cannot reach it, and a static
 * access-guard test proves that in production only the authorized fal
 * byte-source adapter imports this module.
 *
 * It re-exports exactly one operation. There is no accessor, no getter and no
 * general secret-unwrapping utility here: the raw location is handed to a
 * callback for the length of one network open and is never returned.
 */
export { withTransientProviderOutputLocatorForByteSource } from "../provider-output/locator";
