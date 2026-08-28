import { describe, expect, it } from "vitest";
import type { MediaAssetStatus } from "../property/types";
import type { PreparedGeneration } from "./execution-preflight";
import {
  classifyExecutionSource,
  isUsableSourceDigest,
  sameSourceIdentity,
  type ExecutionSourceObservation,
  type PreparedSourceIdentity,
} from "./execution-source";

/**
 * Every status, enumerated here rather than imported.
 *
 * `MediaAssetStatus` is a type with no runtime list, and adding one to
 * production purely for a test would be production surface this milestone has
 * no other use for. The `Record` is compile-total, so a new status fails to
 * compile here just as it does in the module under test.
 */
const ALL_STATUSES = Object.keys({
  PENDING_UPLOAD: true,
  UPLOADED: true,
  SCANNING: true,
  QUARANTINED: true,
  PROCESSING: true,
  READY: true,
  REJECTED: true,
  FAILED: true,
  DELETION_PENDING: true,
  DELETED: true,
} satisfies Record<MediaAssetStatus, true>) as MediaAssetStatus[];

const KEY = "org_es/assets/ast_es/normalized.jpg";
const DIGEST = "a".repeat(64);

function observation(overrides: Partial<ExecutionSourceObservation> = {}): ExecutionSourceObservation {
  return {
    status: "READY",
    deletionRequestedAt: null,
    storageKey: KEY,
    mimeType: "image/jpeg",
    sha256: DIGEST,
    ...overrides,
  };
}

describe("isUsableSourceDigest", () => {
  // The producer is `sha256Hex(...)` in `AssetService.completeUpload`, which is
  // `createHash("sha256").update(input).digest("hex")` — unprefixed lowercase
  // hex, exactly 64 characters. Pinning that shape is only reasonable because
  // the producer is singular; every rejected case below is a value this
  // pipeline has never written.
  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["63 hex", "a".repeat(63)],
    ["65 hex", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["mixed case", `A${"a".repeat(63)}`],
    ["sha256: prefixed", `sha256:${"a".repeat(64)}`],
    ["64 non-hex characters", "g".repeat(64)],
    ["64 hex with a trailing space", `${"a".repeat(63)} `],
  ])("refuses %s", (_label, value) => {
    expect(isUsableSourceDigest(value)).toBe(false);
  });

  it("accepts the canonical form", () => {
    expect(isUsableSourceDigest(DIGEST)).toBe(true);
    expect(isUsableSourceDigest("0123456789abcdef".repeat(4))).toBe(true);
  });
});

describe("classifyExecutionSource", () => {
  it("refuses a usable-looking READY row once deletion has been requested", () => {
    // The override outranks status, and it is checked first. Retention can be
    // requested while the row still reads READY with every other field intact,
    // and submitting a photo whose deletion a customer has already asked for
    // would be worse than refusing.
    const result = classifyExecutionSource(
      observation({ deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    expect(result).toEqual({ kind: "REFUSED", reason: "ASSET_UNRECOVERABLE" });
  });

  it("applies the deletion override to every status, not only READY", () => {
    for (const status of ALL_STATUSES) {
      const result = classifyExecutionSource(
        observation({ status, deletionRequestedAt: new Date("2026-01-01T00:00:00.000Z") }),
      );
      expect(result).toEqual({ kind: "REFUSED", reason: "ASSET_UNRECOVERABLE" });
    }
  });

  /**
   * The whole status vocabulary, written out independently of the module's own
   * table so the two have to be changed deliberately together.
   */
  const EXPECTED_STATUS_REFUSAL: Record<Exclude<MediaAssetStatus, "READY">, string> = {
    PENDING_UPLOAD: "ASSET_NOT_READY",
    UPLOADED: "ASSET_NOT_READY",
    SCANNING: "ASSET_NOT_READY",
    PROCESSING: "ASSET_NOT_READY",
    FAILED: "ASSET_UPLOAD_FAILED",
    QUARANTINED: "ASSET_UNRECOVERABLE",
    REJECTED: "ASSET_UNRECOVERABLE",
    DELETION_PENDING: "ASSET_UNRECOVERABLE",
    DELETED: "ASSET_UNRECOVERABLE",
  };

  it.each(Object.entries(EXPECTED_STATUS_REFUSAL))(
    "refuses %s with its documented reason",
    (status, reason) => {
      const result = classifyExecutionSource(
        observation({ status: status as MediaAssetStatus }),
      );
      expect(result).toEqual({ kind: "REFUSED", reason });
    },
  );

  it("covers every non-READY status and nothing else", () => {
    expect(Object.keys(EXPECTED_STATUS_REFUSAL).sort()).toEqual(
      ALL_STATUSES.filter((s) => s !== "READY").sort(),
    );
  });

  it.each([
    ["a PNG", "image/png"],
    ["a WebP thumbnail type", "image/webp"],
    ["no MIME type at all", null],
  ])("refuses READY with %s as an unsupported format", (_label, mimeType) => {
    expect(classifyExecutionSource(observation({ mimeType }))).toEqual({
      kind: "REFUSED",
      reason: "ASSET_FORMAT_UNSUPPORTED",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("refuses READY with a %s storage key as an unsupported format", (_label, storageKey) => {
    expect(classifyExecutionSource(observation({ storageKey }))).toEqual({
      kind: "REFUSED",
      reason: "ASSET_FORMAT_UNSUPPORTED",
    });
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["63 hex", "a".repeat(63)],
    ["65 hex", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["sha256: prefixed", `sha256:${"a".repeat(64)}`],
    ["non-hex", "z".repeat(64)],
  ])("refuses a correctly formatted READY row whose digest is %s", (_label, sha256) => {
    // Deliberately *not* ASSET_FORMAT_UNSUPPORTED. The MIME type and key are
    // fine; what is missing is the pipeline's own record of which bytes these
    // are, which is a defect in this system rather than in the customer's file.
    expect(classifyExecutionSource(observation({ sha256 }))).toEqual({
      kind: "REFUSED",
      reason: "ASSET_SOURCE_UNIDENTIFIABLE",
    });
  });

  it("orders format ahead of digest, so a non-JPEG is never called unidentifiable", () => {
    expect(classifyExecutionSource(observation({ mimeType: "image/png", sha256: null }))).toEqual({
      kind: "REFUSED",
      reason: "ASSET_FORMAT_UNSUPPORTED",
    });
  });

  it("returns the identity of a usable source, carrying exactly three fields", () => {
    const result = classifyExecutionSource(observation());
    expect(result.kind).toBe("USABLE");
    if (result.kind !== "USABLE") return;

    expect(result.identity).toEqual({
      storageKey: KEY,
      mimeType: "image/jpeg",
      sha256: DIGEST,
    });
    // No asset id, no organization id, no URL, no expiry, no request hash. The
    // object is a description of a source, and it is held beside a credential
    // rather than being one.
    expect(Object.keys(result.identity).sort()).toEqual(["mimeType", "sha256", "storageKey"]);
  });

  it("preserves the durable storage key exactly, without trimming it", () => {
    // The key that gets signed must be the key the identity names. Normalizing
    // in passing would make those two quietly different strings — and the
    // signature would be minted for one of them.
    const padded = ` ${KEY} `;
    const result = classifyExecutionSource(observation({ storageKey: padded }));
    expect(result.kind).toBe("USABLE");
    if (result.kind !== "USABLE") return;
    expect(result.identity.storageKey).toBe(padded);
  });
});

describe("sameSourceIdentity", () => {
  const base: PreparedSourceIdentity = { storageKey: KEY, mimeType: "image/jpeg", sha256: DIGEST };

  it("accepts two identities describing the same source", () => {
    expect(sameSourceIdentity(base, { ...base })).toBe(true);
  });

  it.each([
    ["storageKey", { storageKey: `${KEY}.other` }],
    ["mimeType", { mimeType: "image/png" }],
    ["sha256", { sha256: `b${"a".repeat(63)}` }],
  ])("rejects a difference in %s", (_field, difference) => {
    expect(sameSourceIdentity(base, { ...base, ...difference })).toBe(false);
  });

  it("rejects a differing digest even when key and MIME agree", () => {
    // The case the other two fields cannot see. `buildAssetStorageKey` is
    // deterministic, so every normalized JPEG for one asset reuses the same key
    // with the same MIME type — two genuinely different images agree on both.
    expect(
      sameSourceIdentity(base, { ...base, sha256: `b${"a".repeat(63)}` }),
    ).toBe(false);
  });
});

describe("the source-identity boundary (compile-time)", () => {
  it("carries exactly three fields and nothing that identifies or authorizes", () => {
    // A structural assertion rather than a runtime one, because the risk is a
    // future field being *added*: `Object.keys` on one instance would not catch
    // an optional member, and a widened identity is how a credential or an
    // admission fact quietly starts travelling with a description.
    type Field = keyof PreparedSourceIdentity;

    const exactlyThreeFields: Field extends "storageKey" | "mimeType" | "sha256" ? true : never =
      true;
    const allThreePresent: "storageKey" | "mimeType" | "sha256" extends Field ? true : never = true;

    // Named individually as well, so a failure says which one appeared.
    const noAssetId: "assetId" extends Field ? never : true = true;
    const noOrganizationId: "organizationId" extends Field ? never : true = true;
    const noGenerationId: "generationId" extends Field ? never : true = true;
    const noSignedUrl: "sourceImageUrl" extends Field ? never : true = true;
    const noExpiry: "sourceUrlExpiresAt" extends Field ? never : true = true;
    const noRequestHash: "requestHash" extends Field ? never : true = true;
    const noPrompt: "prompt" extends Field ? never : true = true;

    expect(
      exactlyThreeFields &&
        allThreePresent &&
        noAssetId &&
        noOrganizationId &&
        noGenerationId &&
        noSignedUrl &&
        noExpiry &&
        noRequestHash &&
        noPrompt,
    ).toBe(true);
  });

  it("keeps the credential beside the identity on PreparedGeneration, not inside it", () => {
    // The artifact still carries the URL and its expiry as their own fields, so
    // Phase 4C-3A-2b can be handed `sourceIdentity` alone. If the identity ever
    // absorbed them, passing it into persistence would pass a credential in.
    const urlIsSeparate: "sourceImageUrl" extends keyof PreparedGeneration ? true : never = true;
    const expiryIsSeparate: "sourceUrlExpiresAt" extends keyof PreparedGeneration ? true : never =
      true;
    const identityIsNested: PreparedGeneration["sourceIdentity"] extends PreparedSourceIdentity
      ? true
      : never = true;

    expect(urlIsSeparate && expiryIsSeparate && identityIsNested).toBe(true);
  });
});
