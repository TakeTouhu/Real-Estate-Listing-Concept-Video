# ADR-0031: Provider diagnostics are safe structured data

- Status: Accepted
- Date: 2026-08-29
- Phase: 4C-3B-1
- Supersedes in part: the `cause` field introduced with `ProviderError` in Phase 0

## Context

`ProviderError` is the value the provider boundary hands to everything inside
it. Its `messageSanitized` is documented as safe for support and logs, and it is
bound for the persisted `normalizedErrorMessage` column. Two paths broke that
promise, and both did so on the money path.

**Raw response bytes reached the message.** `normalizeHttpStatusError` took a
120-byte slice of the provider's response body and interpolated it into
`messageSanitized` for any status outside `{400, 401, 403, 422, 429, 5xx}`. The
request body the adapter sends contains `image` — the short-lived **signed URL**
for the customer's normalized photo — and `prompt`. A provider that echoes the
parameter it rejected (413, 415, 402, 451 are all plausible) would have written
that signed URL into the database and into every log line carrying the error.

**Raw thrown values were retained.** `normalizeWaveSpeedError` attached the
caught value as `cause` on every network failure, and `ProviderErrorException`
passed it to `new Error(message, { cause })`. Node's `fetch` rejection chain
routinely carries hostname, address and port; the `Error` form is worse than the
data form because `console.error(err)` prints it without anyone choosing to.

The fake provider had the same defect in miniature: it copied `error.message`
into `messageSanitized` and kept `cause`. Being offline does not make that safe —
it is the provider every test and local run wires, so it is where the habit forms.

Separately, `normalizeWaveSpeedError` admitted any object carrying `kind` and
`retryable` and cast it to `ProviderError`, unvalidated, whole.

## Decision

### 1. `ProviderError` is safe structured data, structurally

The whole object may be stringified, logged and persisted with no further
filtering. That is enforced by what the type does **not** have: no `cause`, no
`rawBody`, no `response`, no `request`, no `headers`, no free-form details bag.
A field able to hold an arbitrary external value eventually holds a secret.

The one field added is `providerStatus?: number` — the HTTP status actually
received, absent for network, abort and locally-raised errors where no status
exists and inventing one would assert contact that never happened.

### 2. Messages are fixed application text

`messageSanitized` is selected from a closed set of strings the application
owns. The response body is **not an input** to error normalization: it is read
for transport reasons and discarded, on all three operations. The only value
ever interpolated is `providerStatus`, and only after `isHttpStatus` proves it
is an integer in 100–599.

### 3. External diagnostic content is dropped, not filtered

The boundary keeps nothing from the thrown value — not `message`, `stack`,
`errno`, `hostname`, `address`, or a nested fetch cause. Deliberately, no
replacement log was added: preserving the same content through `redact()` would
re-create the leak with an extra step. Richer external telemetry needs its own
closed, redacted schema, decided separately.

### 4. Trust is nominal, never structural

The original defect was `normalizeWaveSpeedError` admitting anything carrying
`kind` and `retryable` and casting it. The first correction attempted here was
**also wrong, and is recorded because the reasoning matters**: it validated every
public field's type and rebuilt a clean object from exactly those five. That
does drop extra properties — but `code` and `messageSanitized` are among the
five, so a hostile value with a real `kind`, a boolean `retryable`, an API token
in `code` and a signed URL in `messageSanitized` satisfied every check and chose
both public diagnostic strings outright.

**Structural validation proves a shape; it can never prove provenance.** The rule
is therefore:

- `ProviderError` fields are **application-owned**, always;
- an arbitrary external object is **never** promoted to a `ProviderError` by its
  shape, however completely it matches;
- the only already-normalized pass-through is **nominal** —
  `WaveSpeedVideoProvider.normalizeError` returns `error.error` for an
  `instanceof ProviderErrorException`, an object this application constructed;
- everything else is dropped and replaced by a fixed classification.

External input may influence only which closed classification the application
picks. It may never supply text. `asProviderError` is deleted rather than
tightened, and the `isProviderErrorKind` guard went with it: a shape predicate
with no caller is the seed of the next shape-trust bypass.

One runtime vocabulary survives, for a different purpose. The two partial `Set`s
(`RETRYABLE_KINDS`, `NON_RETRYABLE_KINDS`) listed eight of nine kinds between
them — `PROVIDER` was in neither and fell through a `? false : false` ternary.
They are replaced by one exhaustive `Record<ProviderErrorKind, boolean>` holding
each kind's default retryability: omitting a key fails `tsc`. Same shape as
ADR-0029's `ASSET_EXECUTABILITY`, for the same reason — two parallel lists drift.

### 5. The fake provider obeys the same contract

One fixed diagnostic: `UNKNOWN` / `FAKE_PROVIDER_ERROR` / `"Fake provider error"`.
No message passthrough, no cause.

### 6. `requestHash` is not a provider idempotency token

Its comment claimed use for "idempotency and provider-charge dedup", which
overstates the provider contract. It is this application's own coordination key.
Current official WaveSpeedAI documentation establishes no idempotency-key support
for the create endpoint, and nothing sends it as a header or in the body. The
comment is corrected; the value, computation, persistence and request body are
unchanged. Duplicate-charge safety therefore comes from **not re-POSTing**, never
from this hash.

## WaveSpeedAI evidence (CTO-verified, 2026-08-29)

From `https://wavespeed.ai/docs/docs-api`: submission is `POST /api/v3/{model_id}`;
**do not blindly retry a task-submission POST** — a disconnected response can
correspond to a prediction that was accepted and billed; the result-query GET is
the retry-safe operation.

From `https://wavespeed.ai/docs/submit-task`: documented submission error
responses are 400 invalid parameters, 401 invalid API key, 403 account issue,
429 rate limit exceeded, 500 server error.

From `https://wavespeed.ai/docs/docs-api/wavespeed-ai/open-video-image-to-video`:
`image` and `prompt` required; `resolution`, `duration`, `seed`, `preset`
optional; pricing is **resolution-dependent**.

None of this is implemented here. Request mapping and pricing are unchanged.

## What this ADR does not decide

Phase 4C-3B-2 remains **required before any paid submission**. It owns:

- the `ACCEPTED` / `DEFINITIVELY_REJECTED` / `SUBMISSION_UNKNOWN` result union
  (a union, not an exception — a caller must not be able to conflate an
  ambiguous failure with a clean one);
- the definitive-rejection HTTP allowlist, approved as **exactly 400, 401, 403**.
  Everything else — 3xx, 402, 404, 405, 406, 408, 409, 411, 413, 414, 415, **422**,
  **429**, **any 5xx**, and any unlisted status — defaults to `SUBMISSION_UNKNOWN`.
  422's current definitive treatment is **not** to be carried forward on the
  grounds that it exists today; generic HTTP semantics are not enough to widen an
  allowlist on the money path;
- malformed-2xx semantics (a 2xx without a usable prediction id, or unparseable
  JSON, is `SUBMISSION_UNKNOWN`);
- manual redirect handling for the paid create submission only, and a
  request-specific 60 s submission timeout — neither changed here;
- exactly-one-POST evidence and fake-provider submission outcomes.

Retry semantics and status→kind mappings are **untouched** by this milestone.
429 and 5xx keep their current `retryable: true`, which is exactly why 3B-2 must
land before anything calls `createGeneration`.

## Consequences

- Diagnostics are less specific. An unexpected status now says only which status,
  and a network failure says only that one occurred. That is the trade: the body
  and the cause were the specific part, and they were the unsafe part.
- `normalizeWaveSpeedError` no longer recognizes an already-normalized error at
  all. Passing a `ProviderError` *value* to it now yields the fixed network
  diagnostic; the pass-through moved to the nominal `instanceof` check one level
  up. Nothing in production relied on the value form.
- `ProviderErrorException` still *has* a `cause` key in its type, inherited from
  the `Error` interface (ES2022). It cannot be removed without ceasing to be an
  `Error`, so it is pinned at runtime — never populated — and the class's own
  added surface is pinned at compile time to exactly one field.
- Production remains dormant: `createGeneration` has zero production callers, and
  no paid gate, submission audit, worker loop or provider POST exists.

## Prerequisite recorded

**The paid gate may not be enabled until the WaveSpeedAI pricing contract is
resolution-aware and verified.** The current `costPerSecondMinor` placeholder is
one-dimensional and cannot represent 480p/720p/1080p at different rates with a
20-second billing cap. No `verified` boolean was added — a flag does not make the
contract correct, and it would let a wrong shape be marked right.
