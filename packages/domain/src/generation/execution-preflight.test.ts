import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import { DOWNLOAD_URL_TTL_SECONDS } from "../property/asset-service";
import type { MediaAsset, MediaAssetStatus } from "../property/types";
import type { SignedUrl } from "../property/ports";
import type { VideoModelCapability } from "./capability";
import type { VerifiedModelEntry, VideoModelCatalog, VideoModelEntry } from "./model-catalog";
import type { SystemGenerationCandidate } from "./execution-ports";
import {
  PREFLIGHT_SOURCE_URL_TTL_SECONDS,
  prepareQueuedGeneration,
  type ExecutionPreflightDeps,
  type PreparedGeneration,
} from "./execution-preflight";
import {
  PREFLIGHT_REFUSAL_REASONS,
  PreflightRefusalError,
  preflightDispositionFor,
  type PreflightDisposition,
  type PreflightRefusalReason,
} from "./execution-preflight-errors";
import { computeGenerationRequestHash } from "./request-identity";
import { SCENE_GENERATION_STATES, type SceneGeneration, type SceneGenerationState } from "./types";

const ORG = "org_pf";
const OTHER_ORG = "org_pf_other";
const ASSET = "ast_pf";
const KEY = "org_pf/assets/ast_pf/normalized.jpg";
const OTHER_KEY = "org_pf/assets/ast_pf/normalized-v2.jpg";
const SIGNED_URL = `https://storage.example.test/${KEY}?sig=secret-token`;
/**
 * Canonical digests: 64 lowercase hex, the exact shape `sha256Hex` emits.
 *
 * Two of them, because the case this milestone exists for is two *valid*
 * digests that differ — same key, same MIME, different bytes.
 */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = `b${"a".repeat(63)}`;
const EXPIRES_AT = new Date(Date.UTC(2026, 0, 1, 0, 10, 0));

/** The narrowed capabilities preflight actually declares. */
type PreflightStorage = ExecutionPreflightDeps["storage"];
type PreflightAssets = ExecutionPreflightDeps["assets"];

/**
 * Records every call so a test can assert what was asked, and with what.
 *
 * Implements only what `ExecutionPreflightDeps` asks for — an earlier version
 * implemented the whole `ObjectStorage` and threw from the four write methods,
 * a runtime guard against calls the narrowed type now makes impossible.
 */
class FakeStorage implements PreflightStorage {
  readonly signed: { key: string; ttl: number }[] = [];
  readonly existsCalls: string[] = [];
  existing = new Set<string>([KEY, OTHER_KEY]);
  failOn: "none" | "exists" | "sign" = "none";
  /** What a successful signing returns. Overridden by the signed-URL tests. */
  result: SignedUrl = { url: SIGNED_URL, expiresAt: EXPIRES_AT };

  exists(key: string): Promise<boolean> {
    this.existsCalls.push(key);
    if (this.failOn === "exists") return Promise.reject(new Error(SECRET_BEARING_MESSAGE));
    return Promise.resolve(this.existing.has(key));
  }
  createSignedDownloadUrl(key: string, ttlSeconds: number): Promise<SignedUrl> {
    if (this.failOn === "sign") return Promise.reject(new Error(SECRET_BEARING_MESSAGE));
    this.signed.push({ key, ttl: ttlSeconds });
    return Promise.resolve(this.result);
  }
}

/** A storage error of the shape real SDKs throw: it names the key and a token. */
const SECRET_BEARING_MESSAGE = `PUT ${KEY} failed: signature=secret-token host=storage.example.test`;

/**
 * Hands out a different asset observation per read, in order.
 *
 * Implements `findById` alone — the narrowed dependency is the whole contract,
 * so there is nothing else to satisfy and no shared production abstraction to
 * add. It records the arguments of every read so a test can prove both used the
 * authoritative organization and the frozen asset id.
 */
class SequentialAssets implements PreflightAssets {
  readonly reads: { organizationId: string; assetId: string }[] = [];
  private index = 0;

  constructor(private readonly observations: readonly (MediaAsset | null)[]) {}

  findById(organizationId: string, id: string): Promise<MediaAsset | null> {
    this.reads.push({ organizationId, assetId: id });
    const observation = this.observations[Math.min(this.index, this.observations.length - 1)];
    this.index += 1;
    return Promise.resolve(organizationId === ORG ? (observation ?? null) : null);
  }
}

const MODEL_KEY = "fixture-model";

const CAPABILITY: VideoModelCapability = {
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  durationSeconds: { kind: "RANGE", minSeconds: 1, maxSeconds: 10 },
  nativeGenerationResolutions: ["1080p"],
  aspectRatios: { kind: "PROVIDER_HONORED", ratios: ["16:9"] },
  negativePrompt: { kind: "UNSUPPORTED" },
  cameraMotion: { kind: "PROMPT_RENDERED" },
};

const ENTRY: VerifiedModelEntry = {
  key: MODEL_KEY,
  providerName: "fake",
  providerModelId: "fake/image-to-video",
  displayName: "Fixture model",
  tier: "RECOMMENDED",
  recommended: true,
  availability: { kind: "SELECTABLE" },
  capability: CAPABILITY,
  nativeGeneration: {
    byTarget: {
      "1080p": {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "NONE",
        nativeMeetsTarget: true,
      },
    },
  },
  pricing: null,
};

/**
 * A catalog holding exactly one entry, addressed the way preflight addresses
 * it: by key.
 *
 * `find` is the only method, matching the narrowed dependency. A fixture that
 * also offered `default()` would let a future edit reach for it and pass, which
 * is the substitution the narrowing exists to make impossible.
 */
// `null` means "the catalog holds nothing", written as null rather than
// undefined because an explicitly-passed `undefined` silently takes a default
// parameter's value — which would have made the absent-model tests pass against
// the present model.
function catalog(entry: VideoModelEntry | null = ENTRY): Pick<VideoModelCatalog, "find"> {
  return { find: (key: string) => (entry !== null && key === entry.key ? entry : undefined) };
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: ASSET,
    organizationId: ORG,
    propertyId: "prp_pf",
    storageKey: KEY,
    originalFilename: "kitchen.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    width: 1920,
    height: 1080,
    sha256: DIGEST_A,
    perceptualHash: null,
    status: "READY",
    failureReason: null,
    thumbnailKey: "org_pf/assets/ast_pf/thumb.webp",
    createdBy: "usr_pf",
    deletionRequestedAt: null,
    retentionExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A generation whose stored hash genuinely matches its stored facts. */
function generation(overrides: Partial<SceneGeneration> = {}): SceneGeneration {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const base: SceneGeneration = {
    id: "gen_pf",
    videoProjectId: "vpr_pf",
    sourceStoryboardSceneId: "scn_pf",
    assetId: ASSET,
    sourceAnalysisRevision: 1,
    requestHash: "placeholder",
    providerName: "fake",
    providerModelId: "fake/image-to-video",
    requestCompiledPrompt:
      '{"preservation":["keep the window"],"sceneFacts":{},"userCustomization":null}',
    requestDurationSeconds: 5,
    requestCameraMotion: "SLOW_PAN_LEFT",
    requestAspectRatio: "16:9",
    requestResolution: null,
    requestModelKey: MODEL_KEY,
    requestTargetOutputResolution: "1080p",
    requestNativeGenerationResolution: "1080p",
    requestResolutionNormalization: "NONE",
    requestNativeMeetsTarget: true,
    requestRenderedPrompt: "Preservation rules:\n- keep the window",
    state: "QUEUED",
    providerPredictionId: null,
    submittedAt: null,
    lastPolledAt: null,
    normalizedErrorCode: null,
    normalizedErrorMessage: null,
    outputStorageKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  // Recomputed rather than hard-coded so a fixture never silently drifts out of
  // agreement with its own facts and turns every test into a hash-mismatch.
  if (overrides.requestHash !== undefined) return base;
  return {
    ...base,
    requestHash: computeGenerationRequestHash({
      assetId: base.assetId,
      compiledPrompt: base.requestCompiledPrompt!,
      durationSeconds: base.requestDurationSeconds!,
      cameraMotion: base.requestCameraMotion,
      aspectRatio: base.requestAspectRatio!,
      targetOutputResolution: base.requestTargetOutputResolution!,
      nativeGenerationResolution: base.requestNativeGenerationResolution!,
      resolutionNormalization: base.requestResolutionNormalization!,
      nativeMeetsTarget: base.requestNativeMeetsTarget!,
      modelKey: base.requestModelKey!,
      providerName: base.providerName,
      providerModelId: base.providerModelId,
    }),
  };
}

function candidateFor(gen: SceneGeneration, organizationId = ORG): SystemGenerationCandidate {
  return { organizationId, generation: gen };
}

interface Fixture {
  readonly deps: ExecutionPreflightDeps;
  readonly storage: FakeStorage;
  readonly assets: SequentialAssets;
}

/** `observations` is read in order: the first for the pre-sign read, then the post-sign one. */
function fixture(
  observations: readonly (MediaAsset | null)[] = [asset()],
  entry: VideoModelEntry | null = ENTRY,
): Fixture {
  const assets = new SequentialAssets(observations);
  const storage = new FakeStorage();
  return { deps: { assets, storage, models: catalog(entry) }, storage, assets };
}

async function refusalFrom(f: Fixture, candidate: SystemGenerationCandidate) {
  try {
    await prepareQueuedGeneration(f.deps, candidate);
  } catch (error) {
    if (error instanceof PreflightRefusalError) return error;
    throw error;
  }
  throw new Error("expected a PreflightRefusalError, but preparation succeeded");
}

describe("prepareQueuedGeneration — the prepared artifact", () => {
  it("builds every field from the frozen snapshot and a freshly signed URL", async () => {
    const f = fixture();
    const gen = generation();

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(prepared).toEqual({
      generationId: "gen_pf",
      organizationId: ORG,
      providerName: "fake",
      providerModelId: "fake/image-to-video",
      sourceImageUrl: SIGNED_URL,
      sourceUrlExpiresAt: EXPIRES_AT,
      prompt: "Preservation rules:\n- keep the window",
      durationSeconds: 5,
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      nativeGenerationResolution: "1080p",
      resolutionNormalization: "NONE",
      nativeMeetsTarget: true,
      requestHash: gen.requestHash,
      sourceIdentity: { storageKey: KEY, mimeType: "image/jpeg", sha256: DIGEST_A },
    } satisfies PreparedGeneration);
  });

  it("submits the admitted settings, not whatever the row's neighbours now say", async () => {
    // The asset is 4:3 and the catalog entry serves only 16:9, only a 1080p
    // target, and only natively. The snapshot says 9:16, a 720p target reached
    // by downscaling a 768P generation that does NOT meet it — so every other
    // source of these values disagrees with it, and the snapshot must win.
    //
    // The upscale/`nativeMeetsTarget: false` pair is the one that matters: it is
    // a claim about what the customer was promised, and re-deriving it from the
    // entry would quietly upgrade this attempt to "native 1080p".
    //
    // The entry declares that 720p plan, so the drift gate agrees and the test
    // stays about the snapshot beating the row's *neighbours* — the asset and
    // the deployment's aspect-ratio capability — rather than accidentally
    // exercising catalog drift, which has its own tests below.
    const f = fixture([asset({ width: 640, height: 480 })], {
      ...ENTRY,
      capability: { ...CAPABILITY, nativeGenerationResolutions: ["1080p", "768P"] },
      nativeGeneration: {
        byTarget: {
          ...ENTRY.nativeGeneration.byTarget,
          "720p": {
            nativeGenerationResolution: { providerValue: "768P" },
            normalization: "DOWNSCALE",
            nativeMeetsTarget: false,
          },
        },
      },
    });
    const gen = generation({
      requestAspectRatio: "9:16",
      requestTargetOutputResolution: "720p",
      requestNativeGenerationResolution: "768P",
      requestResolutionNormalization: "DOWNSCALE",
      requestNativeMeetsTarget: false,
      requestDurationSeconds: 3,
    });

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(prepared.aspectRatio).toBe("9:16");
    expect(prepared.targetOutputResolution).toBe("720p");
    expect(prepared.nativeGenerationResolution).toBe("768P");
    expect(prepared.resolutionNormalization).toBe("DOWNSCALE");
    expect(prepared.nativeMeetsTarget).toBe(false);
    expect(prepared.durationSeconds).toBe(3);
  });

  it("never re-renders the prompt", async () => {
    const f = fixture();
    const frozen = "text a current renderer would never produce";

    const prepared = await prepareQueuedGeneration(
      f.deps,
      candidateFor(generation({ requestRenderedPrompt: frozen })),
    );

    expect(prepared.prompt).toBe(frozen);
  });

  it("leaves the generation exactly as it found it", async () => {
    const f = fixture();
    const gen = generation();
    const before = { ...gen };

    await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(gen).toEqual(before);
    expect(gen.state).toBe("QUEUED");
  });

  it("reads the asset twice, both scoped and both by the frozen id", async () => {
    const f = fixture([asset(), asset()]);

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.assets.reads).toEqual([
      { organizationId: ORG, assetId: ASSET },
      { organizationId: ORG, assetId: ASSET },
    ]);
  });
});

describe("the source URL", () => {
  it("signs the validated key for exactly the preflight TTL", async () => {
    const f = fixture();

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
  });

  it("declares that TTL as the literal 600", () => {
    expect(PREFLIGHT_SOURCE_URL_TTL_SECONDS).toBe(600);
  });

  it("signs for longer than a human download, which is why the constant is its own", () => {
    // Asserting the literal alone would pass whatever the constant said if both
    // moved together. The property that matters is the relationship: this URL
    // has to survive the claim, the submission POST and the provider's fetch.
    expect(PREFLIGHT_SOURCE_URL_TTL_SECONDS).toBeGreaterThan(DOWNLOAD_URL_TTL_SECONDS);
  });

  it("propagates the signer's expiry exactly, rather than computing one", async () => {
    // A locally computed expiry would drift from what storage actually issued,
    // and the caller would refuse or submit on the wrong answer.
    const f = fixture();
    const storageExpiry = new Date(Date.UTC(2030, 5, 5, 5, 5, 5));
    f.storage.result = { url: SIGNED_URL, expiresAt: storageExpiry };

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(prepared.sourceUrlExpiresAt).toBe(storageExpiry);
  });

  it.each([
    ["a URL the runtime cannot parse", { url: "not a url at all", expiresAt: EXPIRES_AT }],
    ["a plain-HTTP URL", { url: `http://storage.example.test/${KEY}`, expiresAt: EXPIRES_AT }],
    ["an expiry that is not a real instant", { url: SIGNED_URL, expiresAt: new Date(NaN) }],
  ])("refuses %s", async (_label, result) => {
    // Each would be discovered by the provider — after the request was paid for.
    const f = fixture();
    f.storage.result = result as SignedUrl;

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("SIGNED_SOURCE_URL_UNUSABLE");
    expect(refusal.disposition).toBe("RETRYABLE");
  });

  // There is deliberately no "no host" case. Under the WHATWG parser every
  // string that yields protocol `https:` also yields a non-empty hostname, so a
  // constructed example would be testing the parser rather than this code. The
  // guard stays because it is cheap and the invariant is worth stating.
});

describe("the normalized source format", () => {
  it.each<[string, Partial<MediaAsset>]>([
    ["a non-JPEG normalized source", { mimeType: "image/webp" }],
    ["an empty storage key", { storageKey: "" }],
    ["a whitespace-only storage key", { storageKey: "   " }],
  ])("refuses %s, before touching storage", async (_label, overrides) => {
    // The media pipeline normalizes every accepted upload to JPEG, so a READY
    // asset that is not one is not the normalized master. A blank key is not
    // addressable at all.
    const f = fixture([asset(overrides)]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_FORMAT_UNSUPPORTED");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.existsCalls).toHaveLength(0);
    expect(f.storage.signed).toHaveLength(0);
  });

  it("never reaches for the thumbnail", async () => {
    // `thumbnailKey` is a downscaled derivative; paying to animate it would be
    // a silent quality substitution.
    const f = fixture();

    await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(f.storage.signed.map((s) => s.key)).toEqual([KEY]);
    expect(f.storage.existsCalls).toEqual([KEY]);
  });
});

describe("the source content digest", () => {
  it.each<[string, string | null]>([
    ["missing", null],
    ["empty", ""],
    ["one character short", "a".repeat(63)],
    ["one character long", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["prefixed like a requestHash", `sha256:${"a".repeat(64)}`],
    ["not hexadecimal", "z".repeat(64)],
  ])(
    "refuses a READY source whose digest is %s, before touching storage",
    async (_label, sha256) => {
      // A durable source-integrity refusal, not a storage one. The pipeline
      // writes this column in the same statement that sets READY, so a READY
      // row without a canonical digest is one this system should never have
      // produced — and nothing about it becomes clearer by asking storage.
      //
      // Above all, no credential is minted for a source that cannot be
      // identified: the signed URL would name bytes nothing can later prove are
      // the ones preparation saw.
      const f = fixture([asset({ sha256 })]);

      const refusal = await refusalFrom(f, candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_SOURCE_UNIDENTIFIABLE");
      expect(refusal.disposition).toBe("TERMINAL");
      expect(f.storage.existsCalls).toHaveLength(0);
      expect(f.storage.signed).toHaveLength(0);
      // One read, and no second observation: the refusal is decided outright.
      expect(f.assets.reads).toHaveLength(1);
    },
  );

  it("returns the first observation's identity, field for field", async () => {
    const f = fixture();

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(prepared.sourceIdentity).toEqual({
      storageKey: KEY,
      mimeType: "image/jpeg",
      sha256: DIGEST_A,
    });
    // The identity names the key that was actually signed. If those two ever
    // disagreed, the caller would hold a credential for one source and a
    // description of another.
    expect(f.storage.signed).toEqual([{ key: prepared.sourceIdentity.storageKey, ttl: 600 }]);
  });

  it("carries the identity beside the credential, never inside it", async () => {
    const f = fixture();

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(generation()));

    expect(Object.keys(prepared.sourceIdentity).sort()).toEqual([
      "mimeType",
      "sha256",
      "storageKey",
    ]);
    // Still separate fields on the artifact, so a validator can be handed the
    // identity without being handed the URL.
    expect(prepared.sourceImageUrl).toBe(SIGNED_URL);
    expect(prepared.sourceUrlExpiresAt).toBe(EXPIRES_AT);
  });

  it("refuses when the digest changes under an unchanged key and MIME type", async () => {
    // **The case this milestone exists for.** `buildAssetStorageKey` is
    // deterministic in (organization, property, asset, variant, extension), so a
    // re-processed normalized JPEG for this asset lands on the *same* key with
    // the *same* MIME type and different bytes. Key and MIME equality — the
    // whole check before this milestone — passes straight over it, and the URL
    // already signed now points at the replacement.
    const f = fixture([asset({ sha256: DIGEST_A }), asset({ sha256: DIGEST_B })]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_SOURCE_CHANGED");
    expect(refusal.disposition).toBe("TERMINAL");
    // Both observations were valid sources on their own; what differs is which
    // bytes they name.
    expect(f.assets.reads).toHaveLength(2);
    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
  });

  it.each<[string, string | null]>([
    ["loses its digest", null],
    ["acquires a malformed digest", "not-a-digest"],
  ])("refuses when the asset %s after signing", async (_label, sha256) => {
    // Classified on its own terms rather than flattened into "changed": the
    // second row is not a different identifiable source, it is one that cannot
    // be identified at all.
    const f = fixture([asset(), asset({ sha256 })]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_SOURCE_UNIDENTIFIABLE");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
  });
});

describe("refusals before signing", () => {
  it("refuses a row admitted before the request snapshot existed", async () => {
    const f = fixture();
    const legacy = generation({ requestCompiledPrompt: null, requestHash: "sha256:legacy" });

    expect((await refusalFrom(f, candidateFor(legacy))).reason).toBe("LEGACY_SNAPSHOT_MISSING");
  });

  /**
   * The V1 / partial-V2 matrix, each proven to cost nothing.
   *
   * A signed download URL is a credential handed out for work that will never
   * run, so "refuses" is only half the requirement — it has to refuse *before*
   * storage is touched at all. Both counters are asserted, not just the signing
   * one, because an existence check is already a call into infrastructure on
   * behalf of a row that cannot execute.
   */
  it.each([
    [
      "a V1 row carrying only the ambiguous legacy resolution",
      {
        requestHash: "sha256:legacyv1",
        requestResolution: "720p",
        requestModelKey: null,
        requestTargetOutputResolution: null,
        requestNativeGenerationResolution: null,
        requestResolutionNormalization: null,
        requestNativeMeetsTarget: null,
      },
    ],
    [
      "a partially populated V2 snapshot",
      { requestNativeMeetsTarget: null },
    ],
    [
      "a complete V2 snapshot stored under a V1 hash",
      { requestHash: "sha256:notv2" },
    ],
    [
      "a row carrying both request-identity vocabularies",
      { requestResolution: "1080p" },
    ],
  ] as const)("refuses %s without touching storage", async (_label, overrides) => {
    const f = fixture();

    const refusal = await refusalFrom(f, candidateFor(generation(overrides)));

    expect(refusal.reason).toBe("LEGACY_SNAPSHOT_MISSING");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.signed).toHaveLength(0);
    expect(f.storage.existsCalls).toHaveLength(0);
    // And no asset was read either: an unexecutable row is refused from its own
    // contents, without a tenant-scoped query on its behalf.
    expect(f.assets.reads).toHaveLength(0);
  });

  it("refuses a row admitted before the prompt freeze", async () => {
    const f = fixture();

    expect(
      (await refusalFrom(f, candidateFor(generation({ requestRenderedPrompt: null })))).reason,
    ).toBe("LEGACY_PROMPT_MISSING");
  });

  it("refuses when the stored hash disagrees with the stored facts", async () => {
    const f = fixture();

    expect(
      // A V2-versioned hash, so the row is reconstructable and the digest is
      // genuinely compared. A `sha256:` hash would be refused one step earlier,
      // as an unreconstructable V1 row — a different finding.
      (await refusalFrom(f, candidateFor(generation({ requestHash: "sha256:v2:wrong" })))).reason,
    ).toBe("REQUEST_HASH_MISMATCH");
  });

  it.each([
    ["provider", { providerName: "wavespeed" }],
    ["model", { providerModelId: "fake/some-other-model" }],
  ])("refuses when the catalog's %s no longer matches the admitted one", async (_l, moved) => {
    const f = fixture([asset()], { ...ENTRY, ...moved });

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe(
      "PROVIDER_IDENTITY_MISMATCH",
    );
  });

  it("refuses when the admitted model is no longer in the catalog", async () => {
    // Not the same finding as a mismatch: nothing resolves, so there is no
    // contract to disagree with. Falling back to a default model here would
    // spend the customer's money on something they did not approve.
    const f = fixture([asset()], null);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("MODEL_UNAVAILABLE");
  });

  it("refuses when the admitted model has been de-verified", async () => {
    // An entry can lose `SELECTABLE` when its contract is withdrawn for
    // re-verification. It structurally has no provider model id or capability
    // then, so there is nothing to execute against.
    const f = fixture([asset()], {
      key: MODEL_KEY,
      providerName: "fake",
      displayName: "Fixture model",
      tier: "RECOMMENDED",
      recommended: false,
      availability: { kind: "UNVERIFIED", missing: ["a re-verified capability contract"] },
    });

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("MODEL_UNAVAILABLE");
  });

  it.each([
    [
      "a different native token",
      {
        nativeGenerationResolution: { providerValue: "768P" },
        normalization: "NONE" as const,
        nativeMeetsTarget: true,
      },
    ],
    [
      "a different normalization",
      {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "UPSCALE" as const,
        nativeMeetsTarget: true,
      },
    ],
    [
      "a different answer on whether the native generation meets the target",
      {
        nativeGenerationResolution: { providerValue: "1080p" },
        normalization: "NONE" as const,
        // The one that matters commercially: the catalog now says this model
        // does NOT natively reach the target it was admitted as reaching.
        nativeMeetsTarget: false,
      },
    ],
  ])("refuses when the catalog now declares %s", async (_label, delivery) => {
    const f = fixture([asset()], {
      ...ENTRY,
      nativeGeneration: { byTarget: { "1080p": delivery } },
    });

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe(
      "MODEL_DELIVERY_PLAN_CHANGED",
    );
  });

  it("refuses when the catalog no longer serves the admitted target at all", async () => {
    const f = fixture([asset()], {
      ...ENTRY,
      nativeGeneration: {
        byTarget: {
          "720p": {
            nativeGenerationResolution: { providerValue: "720p" },
            normalization: "NONE",
            nativeMeetsTarget: true,
          },
        },
      },
    });

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe(
      "MODEL_DELIVERY_PLAN_CHANGED",
    );
  });

  it("refuses when the capability no longer offers the frozen native token", async () => {
    // The same failure by another route: the plan still says `1080p`, but the
    // model no longer accepts it, so the request as admitted is unexecutable.
    const f = fixture([asset()], {
      ...ENTRY,
      capability: { ...CAPABILITY, nativeGenerationResolutions: ["720p"] },
    });

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe(
      "MODEL_DELIVERY_PLAN_CHANGED",
    );
  });

  it("does not adopt the current plan, or rewrite the row, when they agree", async () => {
    // Agreement means the snapshot is submitted — not that the current catalog
    // was consulted for the value. A drifted plan refuses (above); an agreeing
    // one leaves the prepared artifact byte-identical to the frozen facts.
    const f = fixture();
    const gen = generation();

    const prepared = await prepareQueuedGeneration(f.deps, candidateFor(gen));

    expect(prepared.nativeGenerationResolution).toBe(gen.requestNativeGenerationResolution);
    expect(prepared.resolutionNormalization).toBe(gen.requestResolutionNormalization);
    expect(prepared.nativeMeetsTarget).toBe(gen.requestNativeMeetsTarget);
    expect(prepared.requestHash).toBe(gen.requestHash);
  });

  it("refuses a drifted delivery plan before signing anything", async () => {
    const f = fixture([asset()], {
      ...ENTRY,
      nativeGeneration: {
        byTarget: {
          "1080p": {
            nativeGenerationResolution: { providerValue: "768P" },
            normalization: "UPSCALE",
            nativeMeetsTarget: false,
          },
        },
      },
    });

    await refusalFrom(f, candidateFor(generation()));

    expect(f.storage.signed).toHaveLength(0);
    expect(f.storage.existsCalls).toHaveLength(0);
  });

  it("refuses an unavailable model before signing anything", async () => {
    // Order matters commercially: a refusal that has already minted a download
    // credential has handed out access for work that will never run.
    const f = fixture([asset()], null);

    await refusalFrom(f, candidateFor(generation()));

    expect(f.storage.signed).toHaveLength(0);
    expect(f.storage.existsCalls).toHaveLength(0);
  });

  it("refuses when the asset no longer exists", async () => {
    const f = fixture([null]);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("ASSET_NOT_FOUND");
  });

  it.each<MediaAssetStatus>(["PENDING_UPLOAD", "UPLOADED", "SCANNING", "PROCESSING"])(
    "treats a %s asset as not ready yet",
    async (status) => {
      const refusal = await refusalFrom(fixture([asset({ status })]), candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_NOT_READY");
      expect(refusal.disposition).toBe("RETRYABLE");
    },
  );

  it("treats a FAILED upload as recoverable, because retryUpload accepts it", async () => {
    // `AssetService.retryUpload` resets a FAILED asset to PENDING_UPLOAD on the
    // same id, so its source can still arrive. Grouping it with deleted and
    // quarantined assets would permanently fail an attempt whose photo is one
    // customer action away — found in review of this milestone.
    const refusal = await refusalFrom(
      fixture([asset({ status: "FAILED" })]),
      candidateFor(generation()),
    );

    expect(refusal.reason).toBe("ASSET_UPLOAD_FAILED");
    expect(refusal.disposition).toBe("RETRYABLE");
  });

  it.each<MediaAssetStatus>(["QUARANTINED", "REJECTED", "DELETION_PENDING", "DELETED"])(
    "treats a %s asset as unrecoverable",
    async (status) => {
      const refusal = await refusalFrom(fixture([asset({ status })]), candidateFor(generation()));

      expect(refusal.reason).toBe("ASSET_UNRECOVERABLE");
      expect(refusal.disposition).toBe("TERMINAL");
    },
  );

  it("refuses a READY asset whose deletion the customer has already requested", async () => {
    const f = fixture([asset({ deletionRequestedAt: new Date("2026-01-01T00:00:00Z") })]);

    expect((await refusalFrom(f, candidateFor(generation()))).reason).toBe("ASSET_UNRECOVERABLE");
  });

  it("refuses when the asset row points at an object storage does not have", async () => {
    const f = fixture();
    f.storage.existing.clear();

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe("ASSET_OBJECT_MISSING");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.storage.signed).toHaveLength(0);
  });

  it.each(["exists", "sign"] as const)(
    "classifies a storage failure during %s as unavailable rather than absent",
    async (failOn) => {
      const f = fixture();
      f.storage.failOn = failOn;

      const refusal = await refusalFrom(f, candidateFor(generation()));

      expect(refusal.reason).toBe("STORAGE_UNAVAILABLE");
      expect(refusal.disposition).toBe("RETRYABLE");
    },
  );

  it.each(SCENE_GENERATION_STATES.filter((s) => s !== "QUEUED"))(
    "rejects a %s generation as a caller error, not a refusal",
    async (state: SceneGenerationState) => {
      const f = fixture();
      const candidate = candidateFor(generation({ state }));

      await expect(prepareQueuedGeneration(f.deps, candidate)).rejects.toBeInstanceOf(AppError);
      await expect(prepareQueuedGeneration(f.deps, candidate)).rejects.not.toBeInstanceOf(
        PreflightRefusalError,
      );
    },
  );
});

describe("the asset can change while the URL is being signed", () => {
  // Each case signs successfully, then finds a different world on the second
  // read. None may return a PreparedGeneration: the caller would be holding a
  // credential for a source that is no longer the admitted one.
  it.each<[string, MediaAsset | null, PreflightRefusalReason, PreflightDisposition]>([
    ["disappears", null, "ASSET_NOT_FOUND", "TERMINAL"],
    [
      "is marked for deletion",
      asset({ status: "DELETION_PENDING" }),
      "ASSET_UNRECOVERABLE",
      "TERMINAL",
    ],
    ["goes back to processing", asset({ status: "PROCESSING" }), "ASSET_NOT_READY", "RETRYABLE"],
    ["fails", asset({ status: "FAILED" }), "ASSET_UPLOAD_FAILED", "RETRYABLE"],
    ["is repointed at another key", asset({ storageKey: OTHER_KEY }), "ASSET_SOURCE_CHANGED", "TERMINAL"],
    // Not ASSET_SOURCE_CHANGED any more, and deliberately so (ADR-0029). The
    // second observation is now classified on its own terms first, and a PNG is
    // independently unusable — it is not a different *usable* source, it is not
    // a submittable source at all. Both refusals are TERMINAL, so where the row
    // parks is unchanged; only the durable reason is more precise.
    ["changes format", asset({ mimeType: "image/png" }), "ASSET_FORMAT_UNSUPPORTED", "TERMINAL"],
  ])("refuses when the asset %s after signing", async (_label, second, reason, disposition) => {
    const f = fixture([asset(), second]);

    const refusal = await refusalFrom(f, candidateFor(generation()));

    expect(refusal.reason).toBe(reason);
    expect(refusal.disposition).toBe(disposition);
    // Signing already happened — that is the point of checking again after it.
    expect(f.storage.signed).toEqual([{ key: KEY, ttl: 600 }]);
    // And the signed URL went nowhere: nothing is returned and nothing stored.
    expect(f.assets.reads).toHaveLength(2);
  });

  it("uses the same authoritative organization and frozen asset id for both reads", async () => {
    const f = fixture([asset(), asset({ storageKey: OTHER_KEY })]);

    await refusalFrom(f, candidateFor(generation()));

    expect(f.assets.reads).toEqual([
      { organizationId: ORG, assetId: ASSET },
      { organizationId: ORG, assetId: ASSET },
    ]);
  });
});

describe("tenant isolation", () => {
  it("cannot reach an asset belonging to another organization", async () => {
    // The candidate's organizationId was resolved through VideoProject, so a
    // mismatch means the asset is somebody else's. The scoped read returns null
    // and no cross-tenant row is ever loaded.
    const f = fixture();

    const refusal = await refusalFrom(f, candidateFor(generation(), OTHER_ORG));

    expect(refusal.reason).toBe("ASSET_NOT_FOUND");
    expect(refusal.disposition).toBe("TERMINAL");
    expect(f.assets.reads).toEqual([{ organizationId: OTHER_ORG, assetId: ASSET }]);
    expect(f.storage.existsCalls).toHaveLength(0);
    expect(f.storage.signed).toHaveLength(0);
  });
});

describe("the refusal contract", () => {
  it("maps every reason to a disposition, and nothing else does", () => {
    // One exhaustive Record is the canonical answer. There is no second
    // retryable list and no terminal list — two sources would disagree
    // eventually, and this is the wrong place to find that out.
    const retryable: PreflightRefusalReason[] = [
      "ASSET_NOT_READY",
      "ASSET_UPLOAD_FAILED",
      "STORAGE_UNAVAILABLE",
      "SIGNED_SOURCE_URL_UNUSABLE",
      "MODEL_UNAVAILABLE",
    ];
    const terminal: PreflightRefusalReason[] = [
      "LEGACY_SNAPSHOT_MISSING",
      "LEGACY_PROMPT_MISSING",
      "REQUEST_HASH_MISMATCH",
      "PROVIDER_IDENTITY_MISMATCH",
      "MODEL_DELIVERY_PLAN_CHANGED",
      "ASSET_NOT_FOUND",
      "ASSET_UNRECOVERABLE",
      "ASSET_FORMAT_UNSUPPORTED",
      "ASSET_SOURCE_UNIDENTIFIABLE",
      "ASSET_SOURCE_CHANGED",
      "ASSET_OBJECT_MISSING",
    ];

    for (const reason of retryable) expect(preflightDispositionFor(reason)).toBe("RETRYABLE");
    for (const reason of terminal) expect(preflightDispositionFor(reason)).toBe("TERMINAL");
    expect([...retryable, ...terminal].sort()).toEqual([...PREFLIGHT_REFUSAL_REASONS].sort());
  });

  it("has exactly sixteen reasons", () => {
    expect(PREFLIGHT_REFUSAL_REASONS).toHaveLength(16);
    expect(new Set(PREFLIGHT_REFUSAL_REASONS).size).toBe(16);
  });

  it("derives disposition from the reason rather than accepting one", () => {
    const refusal = new PreflightRefusalError("ASSET_NOT_READY", "fixed text");

    expect(refusal.disposition).toBe(preflightDispositionFor("ASSET_NOT_READY"));
    expect(refusal.code).toBe("INTERNAL_ERROR");
    expect(refusal.details).toEqual({ reason: "ASSET_NOT_READY" });
  });

  it("lets a programmer error escape instead of relabelling it as legacy", async () => {
    // Converting every throw would tell a future durable mapper to permanently
    // fail customer work over a defect in this code. Only the fail-closed
    // INTERNAL_ERROR shape is translated, detected by type and code rather than
    // by matching message text.
    const f = fixture();
    const boom = new TypeError("reading 'x' of undefined");
    const brokenGeneration = new Proxy(generation(), {
      get(target, property, receiver) {
        if (property === "requestCompiledPrompt") throw boom;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      prepareQueuedGeneration(f.deps, candidateFor(brokenGeneration)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("a refusal is safe to log whole", () => {
  const forbidden = [
    "secret-token",
    KEY,
    "storage.example.test",
    "keep the window",
    "Preservation rules",
  ];

  function assertNothingLeaked(refusal: PreflightRefusalError, gen: SceneGeneration): void {
    // Only the public surface — that is what a structured logger serializes.
    const exposed = JSON.stringify({
      message: refusal.message,
      details: refusal.details,
      reason: refusal.reason,
      disposition: refusal.disposition,
    });
    for (const secret of forbidden) expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(ORG);
    expect(exposed).not.toContain(ASSET);
    expect(exposed).not.toContain(gen.requestHash);
  }

  it("drops a storage error that names the key and a credential", async () => {
    // The thrown dependency error deliberately carries both. Before the raw
    // cause was removed, attaching it would have carried them into the refusal.
    const f = fixture();
    f.storage.failOn = "exists";
    const gen = generation();

    const refusal = await refusalFrom(f, candidateFor(gen));

    expect(refusal.reason).toBe("STORAGE_UNAVAILABLE");
    expect(refusal.cause).toBeUndefined();
    assertNothingLeaked(refusal, gen);
  });

  it("names nothing when the signed URL itself is unusable", async () => {
    const f = fixture();
    f.storage.result = { url: `http://storage.example.test/${KEY}?sig=secret-token`, expiresAt: EXPIRES_AT };
    const gen = generation();

    assertNothingLeaked(await refusalFrom(f, candidateFor(gen)), gen);
  });

  it("names nothing when the asset is refused", async () => {
    const f = fixture([asset({ status: "QUARANTINED" })]);
    const gen = generation();

    assertNothingLeaked(await refusalFrom(f, candidateFor(gen)), gen);
  });
});

describe("preflight holds no capability it should not", () => {
  it("declares no way to claim, submit, or write (compile-time)", () => {
    type ForbiddenNames =
      | "generations"
      | "execution"
      | "executionRepository"
      | "provider"
      | "videoProvider"
      | "videoGenerationProvider"
      | "queue"
      | "audit";
    type DeclaredForbidden = Extract<keyof ExecutionPreflightDeps, ForbiddenNames>;

    const noneDeclared: DeclaredForbidden extends never ? true : never = true;
    expect(noneDeclared).toBe(true);
  });

  it("holds no method that could mutate an asset or an object (compile-time)", () => {
    // The dependencies are narrowed with `Pick`, so "preparation changes
    // nothing" is enforced by the compiler rather than asserted in prose. If
    // either were widened back to the full interface, these stop compiling.
    type AssetMethods = keyof ExecutionPreflightDeps["assets"];
    type StorageMethods = keyof ExecutionPreflightDeps["storage"];

    const assetsReadOnly: AssetMethods extends "findById" ? true : never = true;
    const storageReadOnly: StorageMethods extends "exists" | "createSignedDownloadUrl"
      ? true
      : never = true;

    expect(assetsReadOnly && storageReadOnly).toBe(true);
  });
});
