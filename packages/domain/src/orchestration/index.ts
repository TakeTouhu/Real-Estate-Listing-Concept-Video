/**
 * Generation orchestration: the lifecycle of a customer's video, and of every
 * provider attempt made on its behalf.
 *
 * Pure domain. Nothing here reaches a database, a provider or a clock it was
 * not handed. The persistence layer supplies compare-and-set; this module
 * supplies the only definition of which transitions are legal at all, so the
 * two can be checked against each other instead of one silently defining the
 * other.
 */

export * from "./types";
export * from "./state-machines";
export * from "./entitlement";
export * from "./certainty";
export * from "./transition-metadata";
export * from "./ports";
