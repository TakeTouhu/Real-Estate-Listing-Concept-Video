import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { managedGenerationOutputKey, type ManagedGenerationOutputKey } from "../completion/output";
import {
  managedDeliverableOutputKey,
  type ManagedDeliverableOutputKey,
} from "../deliverable-composition-execution/durable";
import { buildAssetStorageKey, organizationIdFromStorageKey } from "../property/media";
import {
  assertSignableStorageKey,
  isCanonicalStorageKey,
  isInternalStorageKey,
  isSignableStorageKey,
  managedCleanMasterKey,
  type ManagedCleanMasterKey,
} from "./key";

/**
 * The Clean Master's location and the refusal that keeps it internal
 * (ADR-0074).
 *
 * `@ts-expect-error` lines are assertions: each must fail to compile, so a
 * brand widened back to `string` makes `pnpm typecheck` refuse this file.
 */

function acceptMaster(_key: ManagedCleanMasterKey): void {}
function acceptDeliverable(_key: ManagedDeliverableOutputKey): void {}
function acceptGeneration(_key: ManagedGenerationOutputKey): void {}

const MASTER = managedCleanMasterKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" });

describe("the Clean Master key", () => {
  it("is the version's key in the organization's internal namespace", () => {
    expect(MASTER).toBe("org/org_a/internal/clean-masters/gdv_1");
    expect(organizationIdFromStorageKey(MASTER)).toBe("org_a");
  });

  it("refuses a blank identifier, or one that would move the namespace", () => {
    for (const [organizationId, deliverableVersionId] of [
      ["", "gdv_1"],
      [" ", "gdv_1"],
      ["org_a", ""],
      ["org_a", "\t"],
      ["org_a/x", "gdv_1"],
      ["org_a", "gdv/1"],
    ] as const) {
      expect(() => managedCleanMasterKey({ organizationId, deliverableVersionId })).toThrow(AppError);
    }
  });

  it("is a brand of its own, neither the customer's video nor a scene's output", () => {
    acceptMaster(MASTER);
    // @ts-expect-error: a well-shaped string is not a master key.
    acceptMaster("org/org_a/internal/clean-masters/gdv_1");
    // @ts-expect-error: the customer's video is not its master.
    acceptMaster(managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" }));
    // @ts-expect-error: the master is not the customer's video.
    acceptDeliverable(MASTER);
    // @ts-expect-error: nor a scene's output.
    acceptGeneration(MASTER);
    expect(MASTER).not.toBe(
      managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" }),
    );
  });
});

describe("the internal namespace", () => {
  it("holds the master and nothing a customer reaches", () => {
    expect(isInternalStorageKey(MASTER)).toBe(true);
    expect(isInternalStorageKey("org/org_a/internal")).toBe(true);
    expect(isInternalStorageKey("org/org_a/internal/anything/else")).toBe(true);
    for (const key of [
      buildAssetStorageKey({
        organizationId: "org_a",
        propertyId: "prp_1",
        assetId: "ast_1",
        variant: "normalized",
        extension: "jpg",
      }),
      managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_1" }),
      managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" }),
    ]) {
      expect(`${key}: ${isInternalStorageKey(key)}`).toBe(`${key}: false`);
    }
  });

  it("is the exact third segment of an organization's key", () => {
    for (const key of [
      "org/org_a/Internal/clean-masters/gdv_1",
      "org/org_a/internals/clean-masters/gdv_1",
      "org/internal/clean-masters/gdv_1",
      "orgs/org_a/internal/clean-masters/gdv_1",
      "internal/org_a/clean-masters/gdv_1",
      "",
    ]) {
      expect(`${key}: ${isInternalStorageKey(key)}`).toBe(`${key}: false`);
    }
  });

  it("cannot be reached through a key a store might rewrite onto it", () => {
    // Each could land on the master where a store collapses `//` or a URL
    // parser resolves dot-segments; none is canonical, so none is signable.
    for (const key of [
      "org/org_a//internal/clean-masters/gdv_1",
      "/org/org_a/internal/clean-masters/gdv_1",
      "org/org_a/./internal/clean-masters/gdv_1",
      "org/org_a/x/../internal/clean-masters/gdv_1",
      "org/org_a/internal\\clean-masters/gdv_1",
      "org/org_a/properties/prp_1/",
      "",
    ]) {
      expect(`${key}: ${isCanonicalStorageKey(key)} ${isSignableStorageKey(key)}`).toBe(
        `${key}: false false`,
      );
      expect(() => assertSignableStorageKey(key)).toThrow(AppError);
    }
    // Every key the application builds is canonical.
    for (const key of [
      MASTER,
      buildAssetStorageKey({
        organizationId: "org_a",
        propertyId: "prp_1",
        assetId: "ast_1",
        variant: "original",
        extension: "jpg",
      }),
      managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_1" }),
      managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" }),
    ]) {
      expect(`${key}: ${isCanonicalStorageKey(key)}`).toBe(`${key}: true`);
    }
    expect(isSignableStorageKey(MASTER)).toBe(false);
  });

  it("is refused by the signers' guard, and nothing else is", () => {
    expect(() => assertSignableStorageKey(MASTER)).toThrow(
      expect.objectContaining({ code: "INTERNAL_ERROR", httpStatus: 500 }),
    );
    // The message names no key.
    expect(() => assertSignableStorageKey(MASTER)).toThrow(/^[^/]*$/);
    expect(() =>
      assertSignableStorageKey(
        managedDeliverableOutputKey({ organizationId: "org_a", deliverableVersionId: "gdv_1" }),
      ),
    ).not.toThrow();
  });
});
