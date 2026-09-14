// The locator's public surface only. `withTransientProviderOutputLocatorForByteSource`
// is deliberately NOT re-exported here: the raw read-back capability must never
// reach the `@app/domain` root, only the dedicated byte-source-access subpath.
export {
  REDACTED_LOCATOR,
  TransientProviderOutputLocator,
  type TransientProviderOutputLocatorResult,
} from "./locator";
export * from "./observation";
export * from "./transfer";
export * from "./byte-source";
export * from "./ports";
export * from "./runner";
