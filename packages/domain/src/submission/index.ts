export * from "./diagnostic-code";
// The exact-own-key discipline every closed contract in this repository uses,
// exported so an infrastructure boundary can apply the same rule rather than a
// second definition of it that drifts.
export { hasExactlyOwnKeys, isPlainRecord } from "./untrusted";
export * from "./entitlement-anomaly";
export * from "./observation";
export * from "./reconciliation-window";
export * from "./outcome";
export * from "./ports";
export * from "./service";
