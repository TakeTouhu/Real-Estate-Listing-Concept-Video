import { AppError } from "@app/shared";
import type { MediaAssetRepository, ObjectStorage, SignedUrl } from "../property/ports";
import type { MediaAsset } from "../property/types";
import { frozenExecutionPromptFrom } from "./execution-input";
import {
  isSelectableModel,
  type ResolutionNormalization,
  type TargetOutputResolution,
  type TargetResolutionDelivery,
  type VerifiedModelEntry,
  type VideoModelCatalog,
} from "./model-catalog";
import type { SystemGenerationCandidate } from "./execution-ports";
import { PreflightRefusalError } from "./execution-preflight-errors";
import {
  classifyExecutionSource,
  sameSourceIdentity,
  type ExecutionSourceRefusalReason,
  type PreparedSourceIdentity,
} from "./execution-source";
import { computeGenerationRequestHash, generationRequestFactsFrom } from "./request-identity";

/**
 * Everything an admitted generation needs in order to be submitted — and
 * nothing durable.
 *
 * **Deliberately not `ProviderGenerationInput`.** That type lives in
 * `@app/video-providers`, which depends on `@app/domain`; importing it here
 * would invert the dependency and create a cycle. The overlap is not
 * duplication of logic, only of shape: the adapter boundary is where a
 * provider-shaped request is built, and this is the domain's description of
 * what such a request must be made of.
 *
 * **Every field is either frozen or freshly derived, never current.** The
 * prompt and the four request settings come from the immutable snapshot
 * (ADR-0018, ADR-0023), so recomposition or a project settings change after
 * admission cannot alter what gets submitted. The source URL is the opposite:
 * derived at preparation time and never persisted, because a stored credential
 * outlives the reason it was issued (ADR-0018 §6).
 */
export interface PreparedGeneration {
  readonly generationId: string;
  /** Resolved by the execution port through `VideoProject`, never supplied. */
  readonly organizationId: string;

  readonly providerName: string;
  readonly providerModelId: string;

  /**
   * Short-lived signed URL for the normalized source image.
   *
   * A credential. Never persisted, never logged, never placed in an error
   * message or an audit entry.
   */
  readonly sourceImageUrl: string;
  /**
   * When {@link sourceImageUrl} stops working, exactly as storage reported it.
   *
   * Never computed here, so it cannot drift from what storage actually issued.
   * Returned rather than kept private because the gap between preparing and
   * submitting is the caller's to manage — but preflight does **not** check it
   * against the current time. Freshness belongs immediately before the paid
   * POST, where the answer is still true when it matters (Phase 4C-3).
   */
  readonly sourceUrlExpiresAt: Date;
  /**
   * What {@link sourceImageUrl} points at, as the durable row described it at
   * the moment the URL was signed.
   *
   * A **description**, not a credential — deliberately a separate nested field
   * rather than three loose top-level ones, so it can be handed to a validator
   * without handing over the URL beside it. Phase 4C-3A-2b passes exactly this
   * into the locked claim, which re-reads the asset row under a lock and refuses
   * to spend money unless the locked row still says the same three things.
   *
   * Taken from the **first** of preflight's two observations, because that is
   * the one the URL was minted against. Never persisted, never logged, never in
   * an error or an audit entry.
   */
  readonly sourceIdentity: PreparedSourceIdentity;

  readonly prompt: string;
  readonly durationSeconds: number;
  readonly aspectRatio: string;
  /**
   * The frozen delivery plan, carried whole rather than collapsed back into one
   * string.
   *
   * Only {@link nativeGenerationResolution} is a provider input; the other three
   * are product facts the submission boundary must **not** invent for itself.
   * They travel together because the pair "what was promised" and "what will be
   * generated" is exactly what a single `resolution` field could not express,
   * and re-deriving either from today's catalog at execution time would reopen
   * the drift the snapshot exists to close (ADR-0034).
   */
  readonly targetOutputResolution: TargetOutputResolution;
  readonly nativeGenerationResolution: string;
  readonly resolutionNormalization: ResolutionNormalization;
  readonly nativeMeetsTarget: boolean;
  readonly requestHash: string;
}

/**
 * Exactly the capabilities preparation needs, and not one more.
 *
 * Each dependency is narrowed with `Pick` rather than taken whole. Preflight
 * had no business calling `assets.update` or `storage.deleteObject`, but
 * holding the full interfaces meant only a comment said so — and a comment is
 * not what stops the next person, or the next milestone, from reaching for
 * them. Narrowing moves "preparation changes nothing" from a claim into
 * something the compiler enforces: the methods that could mutate an asset or
 * an object are not on these types at all.
 *
 * This complements the absent generation repository. Between them, nothing in
 * scope can move the row, touch the asset, or write to storage.
 */
export interface ExecutionPreflightDeps {
  /**
   * A single tenant-addressed read, called twice — once before signing and once
   * after (see {@link prepareQueuedGeneration}).
   *
   * Not a system-scoped port, and that is the point: Phase 4C-1b already
   * resolved `organizationId` through the owning `VideoProject`, so preflight
   * can address the ordinary repository with it. Ownership is then *proven* by
   * the scoped read rather than asserted — an asset belonging to another tenant
   * comes back `null`, with no cross-tenant row ever loaded. A second trusted
   * boundary here would repeat exactly what ADR-0025 §1 rejected.
   */
  readonly assets: Pick<MediaAssetRepository, "findById">;
  /**
   * Ask whether the object is there, and mint a short-lived read URL.
   *
   * No `putObject`, no `deleteObject`, and no `createSignedUploadUrl` — an
   * upload URL is a write credential, and preparation has no reason to hold
   * one. `getObject` is absent too: preflight proves the object exists and
   * lets the provider fetch it, rather than pulling image bytes through this
   * process.
   */
  readonly storage: Pick<ObjectStorage, "exists" | "createSignedDownloadUrl">;
  /**
   * The model table, consulted by the attempt's **own frozen key**.
   *
   * It replaces the single-model capability provider this took until ADR-0033.
   * That port could only answer "what is configured now", which was the same
   * question for every row while one model existed and is the wrong question the
   * moment two do: a row admitted on OpenVideo must be checked against
   * OpenVideo's entry, not against whichever model the deployment currently
   * defaults to.
   *
   * `find` only. Preflight has no business calling `default()` — falling back to
   * the default model for an attempt admitted on another one is precisely the
   * substitution this check exists to prevent, and it cannot happen if the
   * method is not on the type.
   */
  readonly models: Pick<VideoModelCatalog, "find">;
}

/**
 * How long a prepared source URL stays valid.
 *
 * Deliberately its own constant rather than `DOWNLOAD_URL_TTL_SECONDS`, which
 * is sized for a human clicking a link. This one has to cover preparation, the
 * claim, the submission POST, and the provider's own fetch of the image — a
 * machine-to-machine window that is shorter in the happy case and much less
 * forgiving when it is not.
 *
 * **Provisional.** 600 seconds is a considered guess about a pipeline nothing
 * has yet run end to end; Phase 4C-3's paid-call review is where it gets
 * measured against a real submission.
 */
export const PREFLIGHT_SOURCE_URL_TTL_SECONDS = 600;

/**
 * Fixed, sanitized text for every reason the canonical classifier can return.
 *
 * A `Record` over that closed subset, so a new source refusal cannot be
 * introduced without a message being written for it. Every string is chosen
 * here rather than composed: none names a storage key, a digest, an asset id, an
 * organization id or a signed URL, and the `ASSET_SOURCE_UNIDENTIFIABLE` one is
 * deliberately vague about *what* was wrong with the digest — the value being
 * refused describes customer content.
 */
const SOURCE_REFUSAL_MESSAGES: Record<ExecutionSourceRefusalReason, string> = {
  ASSET_NOT_READY: "The source asset for this generation is still being prepared",
  ASSET_UPLOAD_FAILED:
    "The source asset for this generation failed to upload and has not been retried",
  ASSET_UNRECOVERABLE:
    "The source asset for this generation cannot become usable under its current identity",
  ASSET_FORMAT_UNSUPPORTED:
    "The source asset for this generation is not a usable normalized JPEG source",
  ASSET_SOURCE_UNIDENTIFIABLE:
    "The source asset for this generation cannot be identified from its recorded content digest",
};

/**
 * Classify one observation, or refuse with its canonical reason.
 *
 * The classifier is pure and returns a union; preflight's control flow is
 * exceptions, so this is the single place the two meet. Both observations go
 * through it, which is what keeps them agreeing.
 */
function identityOrRefuse(asset: MediaAsset): PreparedSourceIdentity {
  const classified = classifyExecutionSource(asset);
  if (classified.kind === "USABLE") return classified.identity;
  const { reason } = classified;
  throw new PreflightRefusalError(reason, SOURCE_REFUSAL_MESSAGES[reason]);
}

/**
 * Prepare one `QUEUED` generation for a later submission, and change nothing.
 *
 * The row is still `QUEUED` when this returns. There is no claim here, no state
 * write, and no repository on {@link ExecutionPreflightDeps} that could perform
 * one — preparation is separated from claiming so the `SUBMITTING` window
 * covers the provider call alone rather than asset lookup, storage checks and
 * URL signing as well (ADR-0025 §3). `SUBMITTING` is the state whose only
 * honest recovery parks work for a human, so it is worth keeping small.
 *
 * The order is load-bearing, and reads:
 *
 * 1. the row is `QUEUED`;
 * 2. reconstruct the immutable request facts;
 * 3. read the frozen rendered prompt;
 * 4. recompute and verify `requestHash`;
 * 5. resolve the catalog entry by the attempt's **own frozen model key**, and
 *    refuse if it is absent or no longer selectable;
 * 6. verify provider and model identity against that entry, then verify that
 *    the entry's **current** delivery plan for the frozen target still agrees
 *    with the frozen one;
 * 7. first tenant-scoped asset read;
 * 8. classify it — status, deletion intent, JPEG, non-blank key and a canonical
 *    content digest — and keep the resulting source identity;
 * 9. ask storage whether that exact object exists;
 * 10. sign that exact key;
 * 11. validate the signed URL and its expiry;
 * 12. **second** tenant-scoped asset read, classified the same way;
 * 13. require its identity to equal the first in all three fields;
 * 14. return, carrying the **first** identity.
 *
 * Nothing is signed for an asset already known to be unusable — including one
 * whose digest cannot identify it — and nothing is returned for an asset that
 * stopped being usable, or stopped being the same source, while it was being
 * signed.
 *
 * Two workers may prepare the same row concurrently. That is safe and expected:
 * only one wins the later compare-and-swap, and the loser has spent a signed
 * URL and some assembly, neither of which is billable.
 *
 * @throws PreflightRefusalError when the generation cannot be prepared.
 * @throws AppError INTERNAL_ERROR when handed a generation that is not `QUEUED`.
 */
export async function prepareQueuedGeneration(
  deps: ExecutionPreflightDeps,
  candidate: SystemGenerationCandidate,
): Promise<PreparedGeneration> {
  const { organizationId, generation } = candidate;

  // A caller bug rather than a refusal: preparation is defined on queued work,
  // and a row in any other state has an owner who is not this caller. It gets
  // no refusal reason because there is no durable disposition that would make
  // sense — Phase 4C-2B maps refusals out of `QUEUED`, and this row has already
  // left it.
  if (generation.state !== "QUEUED") {
    throw new AppError("INTERNAL_ERROR", "Only a QUEUED generation can be prepared for submission");
  }

  // The immutable request, reconstructed from the row's own snapshot. Both
  // helpers already fail closed for rows admitted before their contract
  // existed; preflight only has to classify that refusal rather than re-decide
  // it. Reconstructing either from the current storyboard or the project's
  // present settings would forge a request the customer never approved.
  const facts = refuseOnDomainRefusal("LEGACY_SNAPSHOT_MISSING", () =>
    generationRequestFactsFrom(generation),
  );
  const prompt = refuseOnDomainRefusal("LEGACY_PROMPT_MISSING", () =>
    frozenExecutionPromptFrom(generation),
  );

  // The stored hash is checked against the facts stored beside it rather than
  // trusted. They are written together at admission and nothing may edit them
  // afterwards, so disagreement means the row was altered — and the hash is the
  // idempotency identity that stops a provider being paid twice for the same
  // request. It is verified, never repaired: a row whose identity has already
  // been lost must not have a new one written over it.
  if (computeGenerationRequestHash(facts) !== generation.requestHash) {
    throw new PreflightRefusalError(
      "REQUEST_HASH_MISMATCH",
      "The stored request identity does not match the request facts recorded with it",
    );
  }

  // Resolve the catalog by the attempt's **own** frozen key, never by the
  // deployment's current default. The key is a hash fact, so this is a lookup of
  // the entry the customer was admitted against rather than a question about
  // what the product would choose today.
  //
  // An absent or de-verified entry is refused before anything else is touched:
  // there is no contract left to check the row against, and "not in the catalog"
  // must never degrade into "use the default one".
  const entry = deps.models.find(facts.modelKey);
  if (entry === undefined || !isSelectableModel(entry)) {
    throw new PreflightRefusalError(
      "MODEL_UNAVAILABLE",
      "The model this attempt was admitted under is not currently available for generation",
    );
  }

  // The entry resolves; does it still describe the same executable request? If
  // the catalog has been re-pointed since admission, this attempt was approved
  // against a contract no longer in force — a different model has a different
  // price and a different result, which is why all three of the key, the
  // provider and the model id are inside the request hash.
  //
  // This is NOT a re-validation of the capability table. `assertSettingsSupported`
  // needs a discrete negative prompt the snapshot does not store, and inventing
  // one would silently skip a check admission actually made. A capability edited
  // under an unchanged provider and model therefore passes here; that gap is a
  // hard prerequisite before real provider spending (docs/decisions/TODO.md).
  //
  if (
    entry.providerName !== generation.providerName ||
    entry.providerModelId !== generation.providerModelId
  ) {
    throw new PreflightRefusalError(
      "PROVIDER_IDENTITY_MISMATCH",
      "This attempt was admitted for a provider or model the deployment no longer serves",
    );
  }

  // The delivery plan is checked, and the check is **agreement, not adoption**.
  //
  // Two authorities, deliberately: the frozen snapshot is the truth of what was
  // approved, and the current catalog is the authority on whether that is still
  // safe to execute. When they agree, the snapshot is submitted. When they do
  // not, neither answer is usable — submitting the frozen plan would spend money
  // on delivery semantics the product no longer stands behind, and submitting
  // the current plan would execute something the customer never approved — so
  // the only honest outcome is to refuse and require a new admission (ADR-0034
  // §5, ADR-0033's catalog-drift rule).
  //
  // Nothing is re-planned, rewritten or re-hashed here. `planGenerationResolution`
  // is a lookup on the current entry; its result is compared and then discarded.
  const declared = currentDeliveryPlanFor(entry, facts.targetOutputResolution);
  if (
    declared === null ||
    declared.nativeGenerationResolution.providerValue !== facts.nativeGenerationResolution ||
    declared.normalization !== facts.resolutionNormalization ||
    declared.nativeMeetsTarget !== facts.nativeMeetsTarget ||
    // A capability that has narrowed until it no longer offers the frozen token
    // is the same failure arriving by a different route: the request as admitted
    // is no longer one this model accepts.
    !entry.capability.nativeGenerationResolutions.includes(facts.nativeGenerationResolution)
  ) {
    throw new PreflightRefusalError(
      "MODEL_DELIVERY_PLAN_CHANGED",
      "This model no longer delivers the requested output the way this attempt was admitted for",
    );
  }

  // --- First observation -----------------------------------------------------
  // Tenant-scoped by construction, and addressed by the *frozen* asset id.
  // `assetId` carries no foreign key, so this is also the check that the asset
  // still exists at all.
  const first = await deps.assets.findById(organizationId, facts.assetId);
  if (first === null) {
    throw new PreflightRefusalError(
      "ASSET_NOT_FOUND",
      "The source asset for this generation no longer exists in its organization",
    );
  }

  // Status, deletion intent, format and digest usability, all in one canonical
  // decision — and all of it **before** storage is touched. A `READY` row whose
  // digest is missing or malformed is a durable source-integrity refusal, not a
  // storage problem, so it must not cause an existence check or mint a
  // credential on the way to being refused.
  //
  // The identity this returns belongs to the *first* observation, and is the one
  // that will be returned to the caller: it names the exact source the URL below
  // is signed for.
  const identity = identityOrRefuse(first);

  // Existence is asked of storage rather than inferred from the row. A `READY`
  // asset whose object is gone is exactly the case that would otherwise be
  // found by the provider, after the charge.
  const objectExists = await storageCall(() => deps.storage.exists(first.storageKey));
  if (!objectExists) {
    throw new PreflightRefusalError(
      "ASSET_OBJECT_MISSING",
      "The source asset record points at an object that is not in storage",
    );
  }

  const signed = await storageCall(() =>
    deps.storage.createSignedDownloadUrl(first.storageKey, PREFLIGHT_SOURCE_URL_TTL_SECONDS),
  );
  assertUsableSignedUrl(signed);

  // --- Second observation ----------------------------------------------------
  // Signing takes time, and an asset can change during it. Returning
  // immediately after signing would hand a caller a credential for a source
  // that had already been deleted or replaced — so the last thing preparation
  // does is look again, with the same authoritative organization and the same
  // frozen asset id.
  //
  // This narrows the window; it does not close it. See the residual race in
  // ADR-0026.
  const second = await deps.assets.findById(organizationId, facts.assetId);
  if (second === null) {
    throw new PreflightRefusalError(
      "ASSET_NOT_FOUND",
      "The source asset for this generation no longer exists in its organization",
    );
  }

  // The same canonical classification, so a row that became deletion-pending,
  // went back into processing, or lost its digest during signing is refused with
  // that reason rather than being flattened into "changed". Only a row that is
  // independently usable gets as far as being compared.
  const secondIdentity = identityOrRefuse(second);

  // Still usable, but is it still the *same* source? All three fields, and the
  // third is the one that matters: `buildAssetStorageKey` is deterministic, so a
  // re-processed normalized JPEG for this asset reuses the same key with the
  // same MIME and different bytes. Key and MIME equality alone would pass over
  // exactly that, and the URL just signed points at whatever now sits there.
  //
  // Terminal rather than retryable: the admitted request named a source that no
  // longer exists in the form it was approved in.
  if (!sameSourceIdentity(identity, secondIdentity)) {
    throw new PreflightRefusalError(
      "ASSET_SOURCE_CHANGED",
      "The source asset changed while this generation was being prepared",
    );
  }

  // The signed URL is simply discarded on every refusal above. There is nothing
  // to revoke — it was never persisted, never logged, and expires on its own.

  // Built from the snapshot, field by field. Nothing here reads the asset's
  // current dimensions, the project's current settings, or the storyboard —
  // all three are mutable after admission, and any of them could change what is
  // submitted under a `requestHash` that still validated (ADR-0018 §3).
  return {
    generationId: generation.id,
    organizationId,
    providerName: generation.providerName,
    providerModelId: generation.providerModelId,
    sourceImageUrl: signed.url,
    sourceUrlExpiresAt: signed.expiresAt,
    // The **first** observation's identity, deliberately not rebuilt from the
    // second. The equality check above proved the two agree, so both carry the
    // same values — but the one that belongs here is the one the URL was minted
    // against, and returning the later object would make that a coincidence
    // rather than the contract.
    sourceIdentity: identity,
    prompt,
    durationSeconds: facts.durationSeconds,
    aspectRatio: facts.aspectRatio,
    targetOutputResolution: facts.targetOutputResolution,
    nativeGenerationResolution: facts.nativeGenerationResolution,
    resolutionNormalization: facts.resolutionNormalization,
    nativeMeetsTarget: facts.nativeMeetsTarget,
    requestHash: generation.requestHash,
  };
}

/**
 * What the current catalog says this model does for this target, or `null` when
 * it no longer says anything.
 *
 * Deliberately a lookup returning `null` rather than a call to
 * `planGenerationResolution`, which throws. Throwing is the right shape at
 * admission — a customer asking for a target the model does not serve is a
 * validation refusal they can act on. Here "the target is no longer served" is
 * just one of several ways the catalog can have drifted, and it has to reach
 * the single `MODEL_DELIVERY_PLAN_CHANGED` refusal rather than escape as an
 * `AppError` that `refuseOnDomainRefusal` would misfile as a legacy row.
 *
 * It reads the same `byTarget` map `planGenerationResolution` reads, and the
 * `isSelectableModel` check above is what makes that map reachable at all.
 */
function currentDeliveryPlanFor(
  entry: VerifiedModelEntry,
  target: TargetOutputResolution,
): TargetResolutionDelivery | null {
  return entry.nativeGeneration.byTarget[target] ?? null;
}

/**
 * Refuse a signed result a provider could not actually use.
 *
 * Storage is trusted to sign, not to be correct. A URL the runtime cannot parse,
 * one that is not `https:`, one with no host, or an expiry that is not a real
 * instant would each be found by the provider — after the request was paid for.
 *
 * `RETRYABLE`, because a malformed answer is a property of the call rather than
 * of the generation: the same request signed again may well be fine.
 *
 * **No freshness check here.** Whether the URL is still valid *now* is only
 * meaningful immediately before the paid POST, and that is Phase 4C-3's to ask.
 */
function assertUsableSignedUrl(signed: SignedUrl): void {
  const refuse = (): never => {
    throw new PreflightRefusalError(
      "SIGNED_SOURCE_URL_UNUSABLE",
      "Object storage returned a source URL or expiry that cannot be submitted",
    );
  };

  let parsed: URL;
  try {
    parsed = new URL(signed.url);
  } catch {
    // The message names nothing: the value being refused is a credential.
    return refuse();
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return refuse();

  const { expiresAt } = signed;
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) return refuse();
}

/**
 * Run a reconstruction helper, converting **only its fail-closed refusal** into
 * a classified one.
 *
 * `generationRequestFactsFrom` and `frozenExecutionPromptFrom` refuse legacy
 * rows by throwing `AppError` with `INTERNAL_ERROR`, and that is the single
 * shape worth translating. Anything else — a `TypeError`, a `RangeError`, a
 * programmer bug — escapes unchanged, because relabelling it
 * `LEGACY_SNAPSHOT_MISSING` would tell a future durable mapper to permanently
 * fail customer work over a defect in this code. The original error is not
 * attached: it propagates on its own when it is not ours to classify, and the
 * refusal that replaces it carries fixed text instead.
 *
 * Detection is by type and code, never by matching message text, which would
 * change meaning under a reworded string.
 */
function refuseOnDomainRefusal<T>(
  reason: "LEGACY_SNAPSHOT_MISSING" | "LEGACY_PROMPT_MISSING",
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "INTERNAL_ERROR") throw error;
    throw new PreflightRefusalError(
      reason,
      reason === "LEGACY_PROMPT_MISSING"
        ? "This generation predates the execution prompt freeze and cannot be submitted"
        : "This generation predates the request snapshot and cannot be reconstructed",
    );
  }
}

/**
 * Wrap an object-storage call so a transport failure is classified rather than
 * escaping as an unrecognized error.
 *
 * Storage being unreachable says nothing about the asset, which is why it is a
 * separate reason from a missing object: the world may change, so a later
 * explicit policy could legitimately try this generation again, where a
 * genuinely absent object never becomes present.
 *
 * **The raw error is deliberately dropped.** Infrastructure errors routinely
 * carry request URLs, keys and credentials in their message, and this refusal
 * is meant to be safe to log whole.
 */
async function storageCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new PreflightRefusalError(
      "STORAGE_UNAVAILABLE",
      "Object storage could not be reached while preparing this generation",
    );
  }
}
