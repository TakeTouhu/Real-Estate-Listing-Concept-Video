# Phase 4B-1a Completion Report — Generation foundations

Milestone: Phase 4B-1a (fourth milestone of Phase 4)
Scope: capability contract, narrow succeeded lookup, in-memory repository —
**no service, no queue, no provider call, no schema change**

## What this milestone is

The three pieces `GenerationService.startScene` needs before it can be written,
each reviewable on its own. **Nothing calls any of them yet.** There is no
`GenerationService` in this milestone.

## Capability contract

```ts
interface VideoModelCapability {
  providerName: string;
  providerModelId: string;
  durationSeconds: DurationPolicy;          // RANGE | ENUMERATED
  resolutions: readonly string[];
  aspectRatios: AspectRatioSupport;         // SUPPORTED(ratios) | UNSUPPORTED
  negativePrompt: FeatureSupport;           // SUPPORTED | UNSUPPORTED
  cameraMotion: FeatureSupport;
}

interface VideoModelCapabilityProvider { current(): VideoModelCapability; }
```

Provider-neutral: no vendor name, no request-field name, no environment access.
The adapter/config layer will own the *values*; the domain owns the shape and
the rule.

`DurationPolicy` has two forms because real models differ — some document a
continuous integer range, others a fixed set of clip lengths. Collapsing them
would force a lie about whichever model does not fit.

### The aspect-ratio semantics, stated precisely

`AspectRatioSupport` is a statement about **the delivered video**, not about
request fields. That distinction is the reason the type exists:

> "The endpoint documents no `aspect_ratio` parameter" is **not** evidence that
> a requested ratio is satisfied. It is evidence that we do not know how to ask
> for one.

Treating absence as support would ship videos in whatever shape the model
happens to produce while the customer believes they chose. So `UNSUPPORTED`
means *this model cannot be relied on to deliver a requested ratio*, and a
project that asks for one is **refused**. It never means "drop the field".

## Pure validation

`assertSettingsSupported(settings, capability)` — reads its two arguments,
mutates nothing, touches no environment, clock, or network, and reaches the same
verdict for the same inputs. It throws `AppError("VALIDATION_FAILED")`, the code
every other domain refusal uses.

| Checked | Refused when |
| --- | --- |
| duration | outside the range, outside the enumerated set, non-integer, or ≤ 0 |
| resolution | not in the supported list |
| aspect ratio | the model cannot honour a chosen ratio **at all**, or the requested one is not supported |
| negative prompt | one is supplied and the model does not honour it |
| camera motion | one is supplied and the model does not honour it |

The last two refuse **only when actually requested** — a project that never set
one is unaffected by the model lacking it, and refusing then would block work
for no benefit.

**"Requested" follows prompt compilation's own meaning for the negative
prompt.** Blank and whitespace-only text is **absent**: `compileScenePrompt`
normalizes it to `null`, so such a project compiles to `userNegative: null` and
the model never sees it. Refusing there would block work over a field that was
never going to be sent. The stored project value is read, never rewritten — this
is capability *interpretation*, not normalization.

**`cameraMotion` deliberately keeps a plain null check.** `createProject` stores
it as given without trimming, nothing normalizes it downstream, and it reaches
the provider as stored — so a blank camera motion genuinely *is* part of the
request, including in the request hash. Applying the whitespace rule there would
make this validation disagree with what is actually being asked for.

Checks run in a fixed order, so the first refusal a caller sees is stable.

**No real capability values ship in this milestone.** Every test uses a fixture
descriptor explicitly labelled as invented. Populating the real descriptor is
Phase 4B-2, after the provider contract is verified against an authoritative
source.

## Repository API

```ts
findLatestSucceededByRequestIdentity(
  organizationId: string,
  videoProjectId: string,
  requestHash: string,
): Promise<SceneGeneration | null>;
```

One method added. **No** `listByProject`, `listHistory`, pagination, generic
terminal lookup, generic state filter, delete, or retry method.

It exists for one reason: terminal states release the active identity, so
`findActiveByRequestIdentity` provably cannot see a succeeded attempt — and
without this lookup an identical already-succeeded request would automatically
become another attempt, which on a paid provider is a second charge for a result
we already have.

### Query and ordering

```ts
where: { videoProjectId, requestHash, state: "SUCCEEDED", videoProject: { organizationId } }
orderBy: [{ createdAt: "desc" }, { id: "desc" }]
```

Tenant scope is in the query, through the project relation — never an
application-side comparison after an unscoped read.

**Ordering is explicit and total.** `createdAt` alone can tie: two attempts
written in the same millisecond are entirely possible. `id` descending breaks
it, so the caller gets the same row every time rather than whatever the planner
happened to return. A live test creates two rows sharing a timestamp and asserts
the answer is defined.

**No index was added.** The existing `(videoProjectId)` index serves this query,
and adding one would be a schema change this milestone is required not to make.

### This is duplicate-spend prevention, not output reuse

The lookup answers *"has this exact request already succeeded?"* Whether that
attempt's output is actually **usable** depends on `outputStorageKey`, which
nothing populates until Phase 4D. Reuse of managed output must additionally
require a valid key; that policy is **not** built here.

## In-memory repository semantics

`InMemorySceneGenerationRepository` models the repository **contract**, not
Prisma internals — no `P2002`, no `P2003`, no index names, no row locking, all
of which are already proven against real PostgreSQL in 4A-2a and 4A-2b. A
hand-rolled imitation would be a second, unverified source of truth.

- **Ownership before identity.** `create` checks the project fixture first and
  throws `SceneGenerationNotFoundError`, so a foreign caller never reaches the
  identity check and cannot learn that another organization holds an attempt —
  the same ordering the adapter uses, asserted by its own test.
- **Active identity** imports `ACTIVE_SCENE_GENERATION_STATES` rather than
  restating it, so the double cannot drift from the domain and therefore cannot
  drift from the SQL predicate the domain's own test pins. All five active
  states block a duplicate; all three terminal states release.
- **Succeeded lookup** implements the adapter's ordering exactly: `createdAt`
  descending, then **`id` descending**. Not merely "some deterministic order" —
  the *same* one, or a service test could observe a different row than
  production when two attempts share a timestamp and lexical id order runs
  opposite to insertion order. `<` / `>` rather than `localeCompare`, matching
  `orderScenes` and staying closer to PostgreSQL's ordering.
- **Update** enumerates mutable fields, so identity and provenance cannot be
  written; an absent key leaves the field alone, which is what keeps a
  state-only update from clearing `providerPredictionId`.
- Foreign and unknown give the **same** error for both `create` and `update`,
  asserted by message equality.

Ownership is a fixture (`registerProject`) — the minimum needed to reproduce the
real boundary check without a database.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | clean |
| `pnpm test` | **854 / 854**, 50 files (806 → +48) |
| `pnpm build` | clean production build |
| `pnpm test:db` | **118 / 118**, 6 files (104 → +14); generation repository **65 / 65** |

Schema and migrations: **zero diff**.

## Defects found in review

Both were P2s in the reviewed head `1c7d067`, fixed in place:

1. **Blank negative prompts were treated as real capability requirements.**
   `settings.negativePrompt !== null` counted `""`, `"   "` and `"\n\t"` as
   customer-authored requirements, so a project with whitespace-only text would
   have been refused against a model lacking negative-prompt support — even
   though compilation normalizes it away and the model never receives it. Now
   gated on non-whitespace content via a pure `isProvided` helper.
2. **The in-memory succeeded lookup used a different tie-break than Prisma.**
   The double ordered by insertion sequence where the adapter orders by `id`
   descending. Those disagree exactly when insertion order runs opposite to
   lexical order — so a service test could have observed a different row than
   production, defeating the purpose of a shared double. The insertion-sequence
   mechanism is removed; the double now uses `createdAt DESC, id DESC`.

   The regression test is constructed to discriminate: `gen_zzz` is inserted
   **first** and `gen_aaa` **second** with an identical timestamp, so
   insertion-order-descending answers `gen_aaa` while the contract answers
   `gen_zzz`. Verified by temporarily restoring the old comparator — the test
   fails against it and passes against `id DESC`. The live PostgreSQL tie-break
   test was made symmetric for the same reason.

## Defects discovered during implementation

1. **`PROJECT_A2` was not seeded** in the repository integration file — I wrote a
   per-project scoping test against a fixture that did not exist. Caught by the
   test failing rather than passing vacuously; a second project under the same
   organization was added, which also makes "scoped per project" genuinely
   distinguishable from "scoped per tenant".
2. **`.catch(e => e as Error)` widened the type** to `Error | SceneGeneration`,
   failing `typecheck`. Replaced with the `rejectionOf` helper the DB suite
   already uses, which also fails loudly if the operation unexpectedly resolves.

## Scope boundaries

Zero diff: `packages/database/prisma/schema.prisma`,
`packages/database/prisma/migrations/`, `apps/web/`, `apps/worker/`,
`packages/queue/`, `packages/video-providers/`, `packages/storage/`, all Phase 3
behaviour.

**No provider call exists.** `createGeneration`, `getStatus`, and
`cancelGeneration` are not referenced anywhere in this milestone, and no
provider is instantiated.

## What this milestone deliberately does not do

- **No real WaveSpeed/OpenVideo capability values** — Phase 4B-2, after contract
  verification. The current adapter also sends `aspect_ratio`,
  `negative_prompt`, and `camera_motion`, which the documented model may not
  accept; reconciling that is 4B-2's job before any real call.
- **No `GenerationService`** — Phase 4B-1b.
- **No managed output reuse** — needs `outputStorageKey`, which arrives in 4D.
- **No queue** — the enqueue port arrives with the service in 4B-1b.

## Carried forward

Phase 4C has a **hard requirement** recorded in `docs/decisions/TODO.md`: recover
`QUEUED` generations that were persisted but never durably enqueued. Phase 4B-1b
creates rows before enqueueing, so without that sweep an enqueue failure leaves
work nothing will pick up.
