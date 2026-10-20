# ADR-0074 — The Clean Master record and its internal location

Status: Accepted (DS-4, 2026-10-20). Part of the AI-generated disclosure plan
the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: ADR-0052 Decision 17 (the Clean Master) for its record and its
location, and the location half of ADR-0071 Decision 7 (*its storage location
is refused by every download path*). ADR-0052 leaves the master's
representation open; this ADR chooses the record and the location, and DS-5
chooses the encode.

## Context

ADR-0052 Decision 17 keeps one overlay-free **Clean Master** per deliverable: no
burned-in disclosure, no burned-in logo. The customer's video is made from it by
applying the disclosure (and later the logo), and once the scene videos are
deleted after 30 days, a disclosure or logo change is recomposed from it with no
provider call. It is internal: never downloadable or otherwise shown to a
customer, not counted in the customer's storage quota, and it consumes no Unit.
It is retained and deleted with its content, through trash and recovery.

ADR-0071 Decision 7 adds how composition will use it (DS-5): encode the master
first, store it privately and first-wins, then lay the disclosure over the
**stored** bytes. Its location is refused by every download path.

Nothing recorded a master, and nothing separated an internal object from a
customer's. Every key is `org/{organizationId}/…`, the one signer
(`signStorageToken`) signs any key it is given, the one verifier accepts any key
it signed, and the download route serves whatever key a valid token names.
Today only customers' own photographs are ever signed, but nothing made that
true by construction.

## Decision 1 — One record per composed version, a receipt and nothing else

Migration 30 creates `generation_deliverable_clean_masters`
(`GenerationDeliverableCleanMaster`):

| Column | Meaning |
| --- | --- |
| `id` | the record's id |
| `deliverableVersionId` | the version whose composition encoded the master; **unique** and RESTRICT |
| `storageKey` | its key in the internal namespace (Decision 2) |
| `sha256`, `sizeBytes` | the stored bytes' digest and length, as the composition receipt records them |
| `verifiedAt` | when the stored bytes were proven |
| `createdAt` | when the row was written |

- **A row exists only for a stored master.** Every column is required, so a row
  is written once, complete, after the bytes are proven stored, and never
  updated. There is no pending row and no status: the composition row already
  carries the lease, retry and block state of the work that makes the master.
- **One per version whose composition encoded it.** A version recomposed later
  from another version's master (a disclosure or logo change, not yet built)
  will name that master rather than own one, so a deliverable keeps one master
  through its disclosure and logo changes. That reference is added when those
  changes are built.
- **RESTRICT to its version**, never Cascade, like every row in the deliverable
  chain: no version is deleted from under its master, so no master record is
  orphaned by a version's deletion.
- **No organization column.** The row reaches its organization through the
  version's job, as the composition and validation rows do. A copy here could
  disagree with that path.
- **Nothing writes it yet.** DS-5's composition is the first writer and decides
  in which transaction. A test holds that no repository, worker or app names
  the table until then.

## Decision 2 — The internal namespace

```text
org/{organizationId}/internal/clean-masters/{deliverableVersionId}
```

- **Internal is the third segment.** Every key keeps its
  `org/{organizationId}/` prefix, so the owning organization is still read from
  the key alone (`organizationIdFromStorageKey`) and a tenant's objects still
  list together for retention and deletion. Anything stored under
  `org/{organizationId}/internal/` is internal-only, and Decision 3's refusal
  covers all of it by position, not by a list of namespaces.
- **Its own brand.** `managedCleanMasterKey` is the one place a string becomes a
  `ManagedCleanMasterKey`, distinct from the scene output's and the customer
  video's brands, so the composer cannot write the customer's video over the
  master, or hand the master to a path expecting the customer's video, without
  an explicit cast.
- **Two application identifiers, each non-blank and free of `/`.** The refusal
  reads segments by position, so an identifier carrying a `/` would move the
  namespace out of the place it looks. The existing key builders do not need
  this; this one does.
- **Extensionless**, like the customer video's key: the receipt proves a digest
  and a byte count, not a container.
- **Every stored row is at such a key.** A CHECK rebuilds the whole key from its
  organization segment and the row's own version id, so a row can name neither
  a customer's object nor another version's master. The organization segment's
  value cannot be checked there, because the row reaches its organization only
  through the version's job; the writer derives the key from it.

## Decision 3 — No signed URL reaches an internal object

- **The signer refuses.** `signStorageToken` calls `assertSignableStorageKey`
  first, which throws an internal error for an internal key, for either
  purpose. Reaching it is a defect in the caller, never something a customer
  chose, since no route accepts a key from a customer; the message names no key.
- **The verifier ignores.** `verifyStorageToken` returns nothing for a token
  naming an internal key, however the token was made. The download and upload
  routes therefore answer such a token exactly as they answer a forged one
  (401): the master is never served, and never written over.
- **The local adapter rejects** both of its signed URLs for an internal key, as
  a rejected promise, which is what the port promises.
- **Server-side access is unchanged.** Composition will read its own master
  directly, as it reads scene outputs today; only signed URLs are refused. No
  provider is ever given a URL to a master either: the preflight's source URLs
  come from the same signed-URL port.
- **Held for every path, not just today's.** A test fails if a second signed-URL
  implementation appears outside tests, if the local adapter stops signing
  through `signStorageToken`, or if any app code other than the download route
  reads object bytes. A production adapter that presigns through its own SDK
  must call `assertSignableStorageKey` itself, and that test is what makes its
  author decide so.

## Decision 4 — Outside the quota, and no Unit

- **Quota.** No storage quota is built yet. When it is, it counts the customer's
  retained images and current final video (ADR-0052 Decision 17); the master is
  its own table and its own namespace, so a quota computed over those never
  meets it. The quota item in `docs/decisions/TODO.md` already lists it as
  excluded.
- **Units.** Nothing here touches the Unit ledger, reservations or settlement:
  making and keeping the master is VTaVision's cost.

## Decision 5 — Retention follows the content

No trash, recovery or physical deletion of videos is built. When it is, the
master is retained while its content is, moves through trash and recovery with
it, and at final physical deletion its object is deleted, then its row, then the
version (RESTRICT enforces that order), subject to any legal hold. This is
recorded in `docs/decisions/TODO.md`.

## Decision 6 — What DS-4 leaves to DS-5 and DS-6

- **DS-5** encodes the master (codec, container and quality, at higher quality
  than the customer's video), stores it first-wins at its key, writes this
  record, and lays the disclosure over the stored bytes. If it needs a column to
  freeze the master's encoding, it adds one.
- **DS-6** refuses to publish a deliverable without its master.
- **Not decided here:** whether other internal objects, such as scene outputs
  (`org/{organizationId}/generations/…`, internal under ADR-0052 Decision 17),
  move under `internal/`. Nothing signs them today. Recorded in
  `docs/decisions/TODO.md`, to settle before any route lets a customer download
  a deliverable.

---

## Consequences

- A master, once DS-5 writes one, has exactly one record, at a key no signed URL
  of either purpose can reach, and its version cannot be deleted from under it.
- Every future internal object gets the same refusal by living under
  `internal/`.
- No route, page, command, environment variable or dependency changes, and no
  customer or operator sees anything new.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
