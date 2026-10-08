# ADR-0052 — Initial-release product and delivery contract

Status: Accepted (CTO decision, pre-Commercial-Launch)
Scope: product behaviour, delivery semantics, entitlement consumption, disclosure,
authorization, lifecycle, settlement of permanent technical failure, and operator
recovery.

Supersedes, at the **product-contract level only**:

- the mandatory final-video approval workflow described in
  `docs/ProductRequirements.md`, `docs/UXFlow.md`, `docs/AIVideoPipeline.md` and
  `docs/SecurityCompliance.md` v1.0;
- the product-level reading of the word *publication* used by ADR-0051 and the
  Phase 5C records.

Does **not** supersede, rewrite or invalidate: ADR-0001 … ADR-0051 as historical
records, or any `docs/phase-*-completion.md`. Those remain accurate for the time
they describe. Where this ADR disagrees with them, this ADR governs the product
going forward and the historical record stays as evidence of what was decided
then.

Companion ADRs: ADR-0053 (commercial contract), ADR-0054 (production platform and
activation gates).

---

## Context

Phase 5C completed the technical delivery pipeline: a composed deliverable is
proved playable, and Transaction G moves the job to `DELIVERABLE_READY`, sets the
customer's deliverable pointer and consumes the entitlement unit in one commit.

The engineering contract is therefore settled. The **product** contract around it
was not, and several v1.0 documents still describe a product that was never
built and is now explicitly not wanted — most importantly a mandatory
approve/reject gate on the finished video.

This ADR records the approved initial-release product contract so that
implementation work has one authority to build against.

**This ADR is documentation. It implements nothing and activates nothing.**

---

## Decision 1 — Initial release is current-state reproduction only

The initial commercial release generates walkthrough-style video that reproduces
the property **as it currently is**.

Explicitly post-release, and not to be prepared for with initial-release UI
branches or data-model branches:

- virtual staging
- renovation proposal

**Preservation-first remains.** The system must not intentionally invent
nonexistent rooms, windows, doors, fixtures, equipment, views or other material
property facts.

Preservation-first is a *generation* rule, not a satisfaction guarantee.
Customer dissatisfaction with an otherwise technically valid video is **not** a
VTaVision technical failure and carries no free-regeneration entitlement
(Decision 4).

## Decision 2 — There is no final-video approval workflow

**Removed from the product.** There is no `APPROVAL_PENDING`, `APPROVED` or
`REJECTED` customer state for a finished video, no mandatory Approve button, and
no approval record as a precondition of delivery.

The authoritative flow is:

```text
generation request
→ generation / composition
→ technical validation
→ technically valid deliverable
→ Unit consumption where applicable
→ deliverable available in the customer's private VTaVision workspace
→ customer previews it
→ customer downloads / uses it, OR requests a paid regeneration
```

### What "publication" does and does not mean

This is the clarification that supersedes the old product-level reading.

**VTaVision does not externally publish anything.** Delivery makes a deliverable
available **inside the customer's own private workspace**, visible only to
authorized members of that organization. That is not external publication, not
public availability, and not distribution.

External publication happens only by **customer action after download**, or
through a future, explicitly customer-created sharing mechanism (Decision 12).

ADR-0051 and the Phase 5C records use "publication" and
`deliverable.published` for the *internal* act of moving the deliverable pointer
and consuming the unit. That naming is retained in code and in history — renaming
a merged, audited transaction boundary would invalidate evidence for no product
benefit. It means **internal availability**, and current product documentation
must not restate it as external publication.

### What survives, and must not be confused with the above

**Photo-analysis review survives and is unchanged.** The implemented Phase
3B/3D surface where a user reviews, corrects, approves or rejects *individual
source photographs before generation* is a different feature from final-video
approval. It is retained, and its permission is `analysis.review`
(Decision 10). Nothing in this ADR removes it.

## Decision 3 — The AI disclosure obligation is met inside the video, not by a gate

The historical statement "never publish without human approval" existed partly
to carry the AI-transparency obligation. That obligation is now met by the
in-video disclosure of Decision 8, plus the Mode C consent record — not by an
approval gate.

`CLAUDE.md`'s rule that AI output is not published automatically is satisfied
because VTaVision performs no external publication at all: the customer decides,
after preview, whether anything leaves their workspace.

## Decision 4 — Unit consumption and regeneration

A **technically valid completed video delivered to the customer's private
workspace consumes the applicable Unit.**

Whether the customer likes it, downloads it, or ultimately uses it does not
change that.

- **Customer-requested content regeneration consumes additional Unit(s).**
- **A free VTaVision-side retry exists only for technical/system failure** where
  VTaVision failed to deliver a technically valid completed video.
- A playable, technically valid video with aesthetically undesirable, strange or
  unwanted AI expression is **not** a free-retry case.

**System recovery / recomposition and customer-requested paid regeneration stay
conceptually distinct.** The first is VTaVision repairing its own failure to
deliver; the second is the customer buying another attempt. They must not be
merged into one counter, one code path's semantics, or one customer explanation.

## Decision 5 — Internal service-recovery budget

Automatic recovery of VTaVision-side failure is bounded by an **internal-only**
budget.

```text
recovery budget = base-plan included-user slots × 1
```

| Plan | Recovery budget per renewal period |
| --- | --- |
| Standard | 3 |
| Premium | 10 |
| Enterprise | 30 |

Per organization, per billing renewal period, shared organization-wide.

**Purchased additional user seats do not increase this budget.** The denominator
is the *base plan's* included-user slots (ADR-0053 Decision 1), and it does not
vary with:

- active-user count;
- purchased additional user seats;
- purchased additional Units;
- temporary membership changes.

A seat is sold as access, not as an entitlement to more absorbed failure. Letting
purchased seats raise the budget would mean an organization could enlarge
VTaVision's cost exposure by buying the cheapest add-on in the catalog.

**Never exposed to customers** — not the budget, not the remaining amount, not
the fact that it is the reason for an outcome.

While budget remains, a system-failure retry may occur without charging an
additional customer Unit.

When the budget is exhausted:

- do **not** automatically charge another customer Unit;
- stop automatic extra recovery;
- release/return the reserved Unit as appropriate — **the failed generation must
  not consume a Unit**;
- escalate internally for support/operator handling;
- an authorized operator may grant an additional manual free recovery.

Customer-facing message, carrying only the customer-safe meaning:

```text
動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。
```

## Decision 6 — Normal / HQ is the only quality choice

Customers choose exactly one of:

- **Normal** — 720p final output
- **HQ** — 1080p high-quality final output

Customers do **not** choose a Provider or a model, and **Provider/model names must
not appear in customer-facing UX**. VTaVision selects the route internally by
quality, cost, availability and Safety Guard (ADR-0054).

**HQ is a final-output requirement, not a native-resolution promise.** If the
selected route produces below the final target, composition may upscale. Do not
claim "native 1080p" unless it is verified for the selected route — the existing
`nativeMeetsTarget` fact is persisted and audited precisely so that claim is
checkable.

## Decision 7 — Concurrent generation

Organization-level concurrent **customer video Job** limits:

| Plan | Concurrent Jobs |
| --- | --- |
| Standard | 1 |
| Premium | 3 |
| Enterprise | 5 |

This is at the customer Job level, **not** the internal count of parallel
Provider Scene requests. HQ gets no separate or additional concurrency pool.

Requests beyond the limit **queue** rather than fail merely because capacity is
occupied.

An internal Provider Safety Guard may enforce *lower* execution concurrency than
the plan entitlement when safety, cost or provider constraints require it
(ADR-0054).

## Decision 8 — AI disclosure modes

Exact text, in all modes that display it:

```text
本コンテンツは生成AIを使用して作成しています。
```

**Mode A — default**

- shown throughout the entire video
- bottom-right
- no background box
- white
- subtle / low-opacity / semi-transparent
- visual target ≈ 1.25% of video height
- ≈ 3% right and bottom safe margin
- position scales correctly for landscape and portrait

**Mode B**

- same exact text
- first 2 seconds and last 2 seconds only

**Mode C — no in-video disclosure**

Available in the official initial release, gated by all three of:

1. organization OWNER/ADMIN has enabled Mode C at organization level;
2. the requesting user holds an **explicit, individually granted**
   `disclosure.none` — a grant only an `OWNER` can give or take away
   (Decision 10);
3. explicit per-video/per-generation consent.

**Organization-level enablement does not by itself authorize no-disclosure
generation.** It makes Mode C *available* in the organization; each user who
would use it still needs gate 2. An `ADMIN` may enable Mode C for the
organization, but cannot thereby make itself eligible: unless an `OWNER` has
explicitly granted `disclosure.none` to that `ADMIN`, the `ADMIN` cannot select
Mode C.

**No dual control is required.** The approved control is *grant authority*, not
separation of duties: the three gates need not be satisfied by different people,
and an `OWNER` acting alone may enable Mode C, grant `disclosure.none` to
themselves, and give per-video consent.

### Mode C consent

The consent must communicate:

- generative AI is used;
- the resulting video contains **no in-file AI disclosure**;
- the customer is responsible for checking applicable law, real-estate
  advertising rules, industry requirements and destination-platform rules before
  external use;
- VTaVision does not guarantee external-use compliance;
- this responsibility allocation does **not** exempt VTaVision from its own
  intentional misconduct or gross negligence;
- **Mode C is not authorization to perform misleading or illegal advertising.**

Two affirmative checkboxes are required:

1. confirms no AI disclosure will be displayed inside the video;
2. accepts responsibility for external disclosure / legal / industry / platform
   compliance.

CTA meaning: `同意して「動画内表示なし」を選択する`

Minimum consent evidence to retain:

`organizationId`, `userId`, target generation/video, `disclosureMode = NONE`,
`consentTextVersion`, `consentedAt`, and the organization-level Mode C
permission/enabled state.

**Legal wording must pass Japanese IT/SaaS + real-estate advertising counsel
review before Commercial Launch.** The wording above states *meaning*, not final
legal text, and this ADR does not invent final legal text.

## Decision 9 — Changing disclosure mode after generation

Changing A/B/C after generation is a **recomposition**, not a new AI Provider
content-generation call. It recomposes from scene videos while they are retained,
and from the overlay-free **Clean Master** afterwards (Decision 17), so it never
requires a provider call.

Per content video, in blocks of three:

- changes **1–3**: free of additional Unit charge;
- the **4th** completed change consumes 1 Unit and buys changes 4–6;
- the **7th** completed change consumes 1 Unit and buys changes 7–9;
- and so on, in the same block-of-3 model.

Counting rules:

- the initially selected mode is **not** a change;
- the count increments **only when a new completed deliverable is successfully
  produced**;
- technical failures, retries and cancellation before successful completion do
  **not** increment it;
- `A → B → A` counts as **two** changes;
- Mode C authorization and consent apply **every time** Mode C is selected;
- customer content regeneration is separate and consumes its normal Unit;
- a newly generated content video gets a **fresh allowance of 3** free changes;
- a change that alters **both** disclosure mode and logo in one operation is
  **one** disclosure change, charged (or not) by this accounting alone; a
  **logo-only** change is free and is not counted here (Decision 13).

```text
disclosure changes 1–3   free, even if the logo also changes
4th completed change     1 Unit of the original video's quality, logo or not
changes 5–6              covered by that block
7th completed change     1 Unit of the original video's quality
logo-only change         free, not counted
```

### Which Unit a charged disclosure change consumes

**Decision gate CLOSED. A charged disclosure recomposition uses the quality of
the original video.** That it is a recomposition and calls no provider does
**not** make its Unit generic.

- original **Normal** video → consumes a **Normal-eligible** Unit;
- original **HQ** video → consumes an **HQ-eligible** Unit;
- no cross-quality substitution and no conversion in either direction.

It follows ADR-0053's quality-locked, eligibility-first order (Decisions 2–3)
for the original video's quality:

| Original | Draws from, in order | Ineligible |
| --- | --- | --- |
| Normal | eligible remaining Base Unit → oldest unexpired Normal add-on → … newest Normal add-on | HQ add-ons |
| HQ | eligible remaining Base Unit **only while the included HQ ceiling remains** → oldest unexpired HQ add-on → … newest HQ add-on | Normal add-ons |

A Base Unit used for an HQ disclosure recomposition **counts against the plan's
included HQ ceiling** (Standard 1, Premium 5, Enterprise 10) exactly as any other
HQ-quality consumption would.

**No eligible Unit, no charged recomposition.** If a change reaches a charging
boundary (the 4th, 7th, …) and no Unit eligible for the original video's quality
exists, the recomposition is **not performed**: no different-quality Unit is
consumed, no Unit is converted, and the paid change is **not** given away free.
The customer must first obtain an eligible entitlement. For example, a Standard
organization whose HQ video reaches a charged change after its single included
HQ entitlement is spent cannot proceed that period — Standard cannot buy HQ
add-ons, and a Normal add-on is not eligible.

**Failure settlement is unchanged** (Decision 19): if an eligible Unit was
reserved and the recomposition fails technically, the completed-change count does
not increment, the reservation is **released**, the Unit is not consumed, and the
previous valid video is retained.

## Decision 10 — Authorization model

Initial model: **standard role templates + groups + Scope + optional individual
permissions.**

Users may belong to multiple groups. **Group permissions are additive. There is
no DENY model in the initial release.** One permission is excluded from groups
entirely: `disclosure.none` is individual-only (see *`disclosure.none` —
protected and individual-only* below).

Scopes: `ORGANIZATION`, `GROUP`, `OWN`.

### Scope semantics — what `ORGANIZATION`, `GROUP` and `OWN` select

**Decision gate CLOSED.** A **permission** says *what* an actor may do; a
**scope** says *which Property-rooted rows* they may do it to.

**The Property is the authorization root for customer content.** Every child
resource inherits the reachability of its parent Property, including — where they
exist — source and normalized assets, analysis and review records, generation
requests, jobs and scenes as customer-content workflow objects, videos,
deliverables and deliverable versions, and other Property-owned generation or
media records. **There is no separate ownership rule for a child**: who uploaded
an asset, clicked Generate, created an analysis or requested a video neither
grants nor withholds access to it.

```text
authorized = tenant boundary AND permission AND Property-derived scope predicate
```

| Scope | Reaches a Property when… |
| --- | --- |
| `ORGANIZATION` | it belongs to the actor's organization. **Never cross-tenant.** |
| `GROUP` | it is assigned to **any** group the actor is currently a member of |
| `OWN` | the actor is its **explicitly assigned responsible user** |

**`GROUP`.** In the initial release a Property is assigned to **zero or one**
group; multi-group Property assignment is not introduced. A user in several
groups reaches the **union** of the Properties assigned to those groups — e.g. a
`MANAGER` in groups A and B reaches Properties in A and in B, not one in C. An
**ungrouped** Property is **not** reachable through `GROUP` alone; another path,
such as `ORGANIZATION` scope, may still reach it.

**`OWN`.** It does **not** mean created-by, uploaded-by, requested-by or
generated-by. It means the Property is **explicitly assigned** to the user as its
responsible user. Creation initializes that assignment according to the
creator's role (see *Property assignment authority and creation-time
assignments* below), but authorization never rests on the immutable creator
identity.

**Changes take effect through the Property.**

- **Group reassignment** of a Property moves its `GROUP` reach; its children
  follow automatically.
- **Removing a user from a group** immediately ends reach derived solely from
  that membership; other memberships and other paths still apply. Group reach is
  additive and there is still no DENY model. Group deletion follows Decision 11.
- **Responsible-user reassignment** moves `OWN` reach from the old assignee to
  the new one; children follow without any child row being reassigned. Creator,
  uploader and requester history and audit attribution are **not** rewritten —
  assignment is authorization state, authorship is historical evidence.

**Individual grants do not widen scope.** A grant answers *what* a user may do,
not *which* rows they reach. A grant never carries or changes a scope: a
`MANAGER` given another content permission still has `GROUP` scope, a `CREATOR`
still has `OWN`, and an `ADMIN` given `billing.manage` by an `OWNER` is still an
`ORGANIZATION`-scoped `ADMIN`. Neither direct grants, groups nor permission
templates are a route to wider scope.

**Non-Property permissions keep their own semantics.** Organization, member,
group, permission, billing and audit administration are not Property-rooted and
are not given Property row semantics here; their role and grant-ceiling rules
are unchanged.

**Durable relationships this requires** (no names chosen here): Property →
responsible user, for `OWN`; Property → zero-or-one group, for `GROUP`; user →
group memberships.

#### Scope is fixed by role

**Decision gate CLOSED.** In the initial release **scope is not independently
mutable — the role determines it.**

| Role | Scope |
| --- | --- |
| `OWNER` | `ORGANIZATION` |
| `ADMIN` | `ORGANIZATION` |
| `MANAGER` | `GROUP` |
| `CREATOR` | `OWN` |
| `VIEWER` | `OWN` |
| `BILLING` | `ORGANIZATION` |

`BILLING`'s `ORGANIZATION` scope gives it no content permission: scope sets reach
only for permissions and resources to which scope is relevant, and `BILLING` holds
no Property-content permission (see the matrix below).

**There is no standalone scope change.** No one — including an `OWNER` — can change
a member's scope while keeping their role: `MANAGER` cannot become
`ORGANIZATION`-scoped, nor `CREATOR` or `VIEWER` `GROUP`- or
`ORGANIZATION`-scoped. A **role change** is the only way scope changes, and it sets
the fixed scope of the new role (a `MANAGER` made `ADMIN` becomes
`ORGANIZATION`-scoped *because* the role changed). Role changes stay under the
existing role-assignment ceiling: `OWNER` assigns any role, `ADMIN` only
`MANAGER`/`CREATOR`/`VIEWER`, and `OWNER`/`ADMIN`/`BILLING` assignments are
`OWNER`-only — so an `ADMIN` can never widen anyone to `ORGANIZATION` scope.

**Reach is adjusted without changing scope.** For `GROUP`, through group
membership and Property group assignment; for `OWN`, through Property
responsible-user assignment.

**A role change does not rewrite Property assignments.** Existing
responsible-user and group assignments remain as data and audit state, and access
is evaluated against the new role's scope: a `CREATOR` made `MANAGER` is then
judged by `GROUP`; a `MANAGER` made `CREATOR` by the Properties explicitly assigned
to them. Nothing is created or removed automatically to preserve prior
visibility.

#### Property assignment authority and creation-time assignments

**Decision gate CLOSED.** Changing a Property's **responsible user** or **group** is
an **authorization mutation**, not ordinary editing, so `property.edit` alone does
not authorize it. **Only `OWNER` and `ADMIN` may change either assignment on an
existing Property.** `MANAGER`, `CREATOR`, `VIEWER` and `BILLING` may not. Every
selected user or group must belong to the same organization.

Assignments at creation depend on the creator's role. Only the four roles below
can create a Property at all (see *`property.create` capability ceiling*):

| Creator | Responsible user | Group |
| --- | --- | --- |
| `OWNER` / `ADMIN` | an eligible user of the same organization, or left unset | an eligible group of the same organization, or left unset |
| `MANAGER` | **fixed** to the creating `MANAGER` — not a default; no other user may be selected | **required**: exactly one group the creating `MANAGER` currently belongs to — selected automatically if they belong to one, chosen by the `MANAGER` if several. **No ungrouped Property**, and no group they do not belong to. |
| `CREATOR` | **fixed** to the creating `CREATOR`; no other user may be selected | **fixed to unset** — a `CREATOR` may not select any group, including one it belongs to |

**Why a `CREATOR` selects no group.** Assigning a group changes which
`GROUP`-scoped users can reach the Property, so it is an authorization mutation,
and a `CREATOR` does not have that authority. A `MANAGER`'s group
selection is the bounded exception the table states — one of its own groups,
mandatory, so the creating `MANAGER` keeps `GROUP` reach.

These creation-time values exist so that no creator immediately loses reach to
what they just created. After creation, any change to either assignment requires
`OWNER` or `ADMIN`. **The creator identity is still not the `OWN` predicate**:
creation merely initializes the responsible user, and a later `OWNER`/`ADMIN`
reassignment moves `OWN` reach without rewriting creator history. Uploaded-,
requested- and generated-by remain non-authoritative for reachability.

**Group deletion is not a way around this rule.** Deleting a group ungroups its
Properties, and it is a protected `OWNER`/`ADMIN`-only operation even where
another role holds `group.manage` (Decision 11).

#### `property.create` capability ceiling

**Decision gate CLOSED.** In the initial release, the effective ability to create
a Property is limited to **`OWNER`, `ADMIN`, `MANAGER` and `CREATOR`**. This is a
**capability ceiling on the recipient's role**, not merely an omission from the
`VIEWER` and `BILLING` templates:

- **`VIEWER` cannot create Properties**, and cannot hold an effective
  `property.create` through a direct grant or through a group grant.
- **`BILLING` cannot create Properties**, and cannot hold an effective
  `property.create` through a direct grant or through a group grant.

The ceiling applies to the **effective** permission, after every grant source —
role template, direct grant and every group the user belongs to — has been
combined. A `VIEWER` or `BILLING` user with a direct or group-derived
`property.create` is **not a supported configuration**: the permission never
becomes effective for them. A group may still carry `property.create` for its
`MANAGER` and `CREATOR` members without conferring it on a `VIEWER` or `BILLING`
member of the same group.

No creation-time assignment rule exists for `VIEWER` or `BILLING`, because
neither can create. A `VIEWER` who needs to create Properties gets an authorized
**role change** — for example to `CREATOR` — under the existing role-assignment
ceiling.

**Audit.** A Property creation records the organization, the Property, the
creating user, the creator's role, the initial responsible user, the initial
group and the timestamp. A Property assignment change records the organization,
the Property, the acting user, previous and new responsible user, previous and
new group, and the timestamp. A role change records the target user, previous and
new role, the resulting fixed scope, the acting user and the timestamp. There is
no separate "scope changed" event, because no standalone scope mutation exists.

Role templates: `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`.

Permissions:

```text
organization.view     organization.manage
member.view           member.manage
group.view            group.manage
permission.manage
property.view         property.create     property.edit     property.delete
asset.upload          asset.delete
analysis.review
video.view            video.generate      video.regenerate  video.download
disclosure.change     disclosure.none
unit.consume          unit.view
billing.view          billing.manage
audit.view            audit.export
```

- `video.share` is **reserved for future work only** and must not be exposed as
  an initial-release feature.
- `unit.consume` is an independent permission.
- Only users with `video.download` may download.
- Mode C requires organization-level enablement **plus** `disclosure.none`
  **plus** per-video consent.
- All permission changes are audited.
- **There must always be at least one OWNER, and the last OWNER cannot be
  deleted.**

### The approved template-to-permission matrix and Scope

**Decision gate CLOSED.** Scope per template — fixed by role (see *Scope is fixed
by role* above):

| Template | Scope |
| --- | --- |
| `OWNER` | `ORGANIZATION` |
| `ADMIN` | `ORGANIZATION` |
| `MANAGER` | `GROUP` |
| `CREATOR` | `OWN` |
| `VIEWER` | `OWN` |
| `BILLING` | `ORGANIZATION` |

**Each template's grant list below is exhaustive: a permission not marked
granted is not granted by that template by default.** A grant may still be added
to an individual user, or arrive additively through a group — **except
`disclosure.none`, which can only ever be an explicit individual grant by an
`OWNER` and which no group may carry** (see *`disclosure.none` — protected and
individual-only* below). Any other grant is also bounded by the granting actor's
ceiling. **That does not make every permission effective for every role:**
`property.create` is never effective for a `VIEWER` or `BILLING` user, from any
grant source (see *`property.create` capability ceiling* above).

| Permission | OWNER | ADMIN | MANAGER | CREATOR | VIEWER | BILLING |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `organization.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `organization.manage` | ✓ | ✓ | — | — | — | — |
| `member.view` | ✓ | ✓ | ✓ | — | — | ✓ |
| `member.manage` | ✓ | ✓ | — | — | — | — |
| `group.view` | ✓ | ✓ | ✓ | — | — | — |
| `group.manage` | ✓ | ✓ | — | — | — | — |
| `permission.manage` | ✓ | ✓ | — | — | — | — |
| `property.view` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `property.create` | ✓ | ✓ | ✓ | ✓ | — | — |
| `property.edit` | ✓ | ✓ | ✓ | ✓ | — | — |
| `property.delete` | ✓ | ✓ | ✓ | ✓ | — | — |
| `asset.upload` | ✓ | ✓ | ✓ | ✓ | — | — |
| `asset.delete` | ✓ | ✓ | ✓ | ✓ | — | — |
| `analysis.review` | ✓ | ✓ | ✓ | ✓ | — | — |
| `video.view` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `video.generate` | ✓ | ✓ | ✓ | ✓ | — | — |
| `video.regenerate` | ✓ | ✓ | ✓ | ✓ | — | — |
| `video.download` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `disclosure.change` | ✓ | ✓ | ✓ | ✓ | — | — |
| `disclosure.none` | — | — | — | — | — | — |
| `unit.consume` | ✓ | ✓ | ✓ | ✓ | — | — |
| `unit.view` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `billing.view` | ✓ | ✓ | — | — | — | ✓ |
| `billing.manage` | ✓ | — | — | — | — | ✓ |
| `audit.view` | ✓ | ✓ | — | — | — | — |
| `audit.export` | ✓ | ✓ | — | — | — | — |
| `video.share` | — | — | — | — | — | — |

Derived facts, stated so they cannot be re-derived incorrectly:

- `permission.manage` default holders: **`OWNER`, `ADMIN`.**
- `billing.manage` default holders: **`OWNER`, `BILLING`.**
- `unit.consume` default holders: **`OWNER`, `ADMIN`, `MANAGER`, `CREATOR`.**
- **`disclosure.none` is granted by no standard template**, so Mode C always
  requires a deliberate grant on top of a role — plus organization-level
  enablement and per-video consent. That grant is **`OWNER`-only** and
  **individual-only** (see *`disclosure.none` — protected and individual-only*
  below).
- **`video.share` is granted by no standard template**, because it is reserved
  for post-release (Decision 12).

Three separations the matrix enforces:

- **`BILLING` does not generate video or consume Units** merely because it can
  manage billing. Paying for capacity and spending it are different acts.
- **`ADMIN` does not manage billing** by role, and — under the grant ceiling
  below — cannot acquire that power **on its own**: not by self-grant, role
  change, group or Scope. An administrator who can add members and change
  permissions does not thereby change what the organization is charged. What
  remains possible is an **explicit `OWNER` grant** of `billing.manage` to a
  specific `ADMIN`, which is `OWNER`-only protected authority; that `ADMIN` then
  acts as any other holder (ADR-0053 Decision 5A).
- **`MANAGER` does not manage members, groups or permissions**, and is scoped
  `GROUP` rather than `ORGANIZATION` — it manages *work*, not *people*.

### Grant ceilings and protected authority

**Decision gate CLOSED.** `permission.manage` is **not** unlimited authority to
grant any permission or role. It is authority **within an approved ceiling.**

Role-assignment authority:

| Holder | May assign / manage | May **not** assign or promote to |
| --- | --- | --- |
| `OWNER` | `OWNER`, `ADMIN`, `BILLING`, `MANAGER`, `CREATOR`, `VIEWER` | — (subject to the last-`OWNER` invariant) |
| `ADMIN` | `MANAGER`, `CREATOR`, `VIEWER` | **`OWNER`, `ADMIN`, `BILLING`** |
| `BILLING`, `MANAGER`, `CREATOR`, `VIEWER` | nothing | everything — no role-assignment authority by default |

**Protected authority — `OWNER`-only:**

- grant or revoke `permission.manage`;
- grant or revoke `billing.manage`;
- **grant or revoke `disclosure.none`**;
- assign or remove the `OWNER` role;
- assign or remove the `ADMIN` role;
- assign or remove the `BILLING` role;
- organization-ownership-equivalent changes;
- **any operation affecting the last `OWNER`.**

So `ADMIN`'s `permission.manage` means **"manage authorization within `ADMIN`'s
approved grant ceiling"** — the ordinary operational authorization its teams need
day to day, under the approved role and Scope model. It does **not** mean "grant
any permission or role in the organization", and **this ADR must not be read as
giving `ADMIN` unrestricted permission delegation.**

### No self-escalation past the ceiling

**`ADMIN` and every lower role must not be able to elevate themselves beyond
their grant ceiling.** None of these may be used as a route to a protected
authority the actor could not grant directly:

- a direct role change;
- an individual permission grant;
- group membership;
- a group permission;
- Scope manipulation (scope is fixed by role, so there is no scope mutation to
  exploit — only a role change, which the role ceiling governs).

Concretely: **`ADMIN` cannot self-grant `billing.manage`**; cannot self-grant or
re-grant `permission.manage` as a way across the protected boundary; **cannot
acquire `disclosure.none` — for itself or for any other user**; cannot promote
itself to `OWNER`; and cannot promote itself into `BILLING` as an escalation
path. The additive group model is not a loophole — a permission that cannot be
granted directly cannot be acquired by joining or editing a group either.

`OWNER` needs no self-grant path for `permission.manage` or `billing.manage`: it
is already the highest customer-side authority, and the `OWNER` template carries
both. `disclosure.none` is the deliberate exception — the template does **not**
carry it, so even an `OWNER` holds it only by an explicit individual grant, which
an `OWNER` may give to themselves.

**Every role, permission, group and Property-assignment change remains audited**,
including a refused escalation attempt.

Unchanged global rules: group permissions are additive, there is no DENY model,
individual grants remain possible **within the granting actor's ceiling**, the
last `OWNER` cannot be deleted, and every permission change is audited. The one
permission no group may carry at all is `disclosure.none` (next section). The
recipient-role ceiling on `property.create` is not a DENY rule: grants still add
up, but the combined set never makes `property.create` effective for a `VIEWER`
or `BILLING` user (see *`property.create` capability ceiling* above).

### `disclosure.none` — protected and individual-only

**Decision gate CLOSED.** `disclosure.none` is a **protected permission**, and
its grant authority is **`OWNER`-only.**

- only an `OWNER` may **grant** it, and only an `OWNER` may **revoke** it;
- `ADMIN` may **not** grant it, may **not** revoke it, may **not** self-grant it,
  and may **not** obtain it indirectly through its own authorization-management
  actions;
- no lower role may grant or revoke it.

**It is individual-only.** It must be an explicit grant to a specific user, and
it may **not** arrive through:

- a group permission;
- group inheritance;
- a standard role template;
- implicit Scope expansion.

**Group-based authorization is not a route to `disclosure.none`**, for any actor.
This is the one place the additive group model is deliberately closed: a group
cannot carry the permission at all, so joining, editing or inheriting a group can
never confer it.

An `OWNER` may grant it to themselves, to another `OWNER`, to an `ADMIN`, or to
another eligible individual user — at minimum an `active` member of the same
organization, which Decision 11 and tenant scoping already require of every
grant.

**Holding `disclosure.none` is a *use* privilege, not a *delegation* privilege.**
A recipient — including an `ADMIN` who holds `permission.manage` — gains no
authority to grant or revoke it merely by holding it. Nor does holding it confer
any other permission: the holder still needs whatever the underlying action
requires.

#### Audit and revocation

**Every grant and every revocation of `disclosure.none` is audited**, with
durable evidence sufficient to identify the organization, the affected user, the
acting `OWNER`, the action (grant or revoke), and the timestamp. No storage
schema is chosen here.

**Revocation is prospective.** After revocation:

- the user **cannot initiate a new Mode C generation** requiring
  `disclosure.none`;
- a Mode C generation **already admitted** before the revocation completes as
  admitted (see *Mode C conditions are frozen at generation admission* below);
- existing **Mode C consent evidence is retained** — it remains historical
  evidence of what was consented to when, on the legal-retention schedule of
  ADR-0053 Decision 7;
- existing **completed videos are not retroactively modified**, and are not
  invalidated solely because the permission was later revoked;
- existing **audit history is not deleted.**

#### Mode C conditions are frozen at generation admission

**Decision gate CLOSED.** The disclosure mode and Mode C eligibility are
evaluated **once, when a generation is admitted**. If the Mode C requirements are
satisfied at that point, the generation is admitted as Mode C, and it keeps that
frozen condition through completion and delivery:

```text
admission-time contract → freeze → execute → deliver according to that contract
```

Two kinds of state must be kept distinct:

- **Mutable organization and user authorization state.** An `OWNER` may revoke a
  user's `disclosure.none`, and `OWNER`/`ADMIN` may disable organization-level
  Mode C, at any time — including while a job is running. Those changes apply
  **only to generations admitted after the change.**
- **Immutable admitted-job configuration and evidence.** For a job already
  admitted, none of the following may be mutated: its disclosure mode; its
  per-generation Mode C consent; the effective `disclosure.none` eligibility used
  to admit it; the organization-level Mode C eligibility snapshot used to admit
  it; and any other per-generation disclosure or logo setting that would alter
  the admitted output contract.

Consequently:

- **there is no pre-delivery re-check** that turns an admitted Mode C job into
  Mode A because a later organization or permission setting changed;
- **there is no automatic Mode C → Mode A fallback** for an admitted job;
- **no Unit is released** merely because an authorization or configuration
  change happened after a valid admission;
- completed historical videos remain unchanged, as already decided;
- every **new** generation — including a later disclosure-mode recomposition,
  which is its own admission — is evaluated against the organization and user
  state current at **its own** admission time.

No schema field names are chosen here.

#### MFA

The existing capability-based MFA rule already covers this authority without
change: `OWNER` is mandatory-MFA, and grant and revocation of `disclosure.none`
are `OWNER`-only, so **they are always performed by a mandatory-MFA actor.** No
additional step-up or re-authentication mechanism is introduced by this
decision.

**MFA remains capability-based, not template-based** (`docs/SecurityCompliance.md`):
mandatory for `OWNER`, `ADMIN`, and any holder of `permission.manage` or
`billing.manage`. Because `BILLING` holds `billing.manage` by default, **`BILLING`
is MFA-mandatory** — a consequence of the capability rule, not a separate one.

## Decision 11 — User and group deletion

User status is **`active` or `deleted`**. Suspension/deactivation is **not**
introduced as a third lifecycle state. **Deleted users cannot be restored** — if
the person needs access again, invite them as a new user.

On user deletion:

- login/access stops immediately;
- for **30 days**, only administrators may inspect videos generated by that user;
- after 30 days, **physically delete all videos generated by that user**,
  including current and old versions;
- videos generated by *other* users for the same property remain;
- Audit / Billing / Consent evidence is retained per legal retention
  (ADR-0053);
- any unavoidable in-flight result attributable to the deleted user becomes
  admin-only and follows the same 30-day lifecycle.

**Decision gate CLOSED.** **Group deletion is a protected `OWNER`/`ADMIN`-only
operation.**

| Role | May delete a group |
| --- | --- |
| `OWNER` | yes |
| `ADMIN` | yes |
| `MANAGER` | **no — even with `group.manage`** |
| `CREATOR` | **no — even with `group.manage`** |
| `VIEWER` | no |
| `BILLING` | no |

Deleting a group ungroups every Property assigned to it, which is the same
authorization effect as changing those Properties' group — and that is
`OWNER`/`ADMIN`-only (Decision 10). So **`group.manage` does not imply group
deletion**: deletion is a protected sub-operation within group management, with
its own authorization check that `group.manage` held without the `OWNER` or
`ADMIN` role — by direct grant or through a group — cannot satisfy. This
decision changes only *who may delete*. It does not redefine the other
group-management operations, which continue under the approved authorization
model, and it adds no new group-management capability.

On group deletion — the consequences are unchanged:

- users remain in the organization as ungrouped/root users;
- they lose permissions granted **solely** by that group, and the `GROUP` reach
  it provided (scope itself is fixed by role and unchanged);
- other group memberships are unaffected;
- group-assigned properties/videos return to organization root/ungrouped scope,
  and OWNER/ADMIN may reassign them;
- **group deletion does not delete content**, and child resources are not
  deleted merely because their Property's group was;
- historical audit evidence is retained.

**Audit.** A group deletion records the organization, the group, the acting user
and their role, the affected Property count or identifiers as appropriate to the
audit model, and the timestamp.

## Decision 12 — Customer share links are post-release

Customer-facing share links are **not** in the initial release and must not be
implemented or exposed. They remain a formal post-release item.

Recorded future candidate requirements: `video.share` permission; version-fixed
links; expiry 24h / 7d / 30d with 7d default; optional password and possible
organization-required password; view-only default; download only when the link
creator holds `video.download`; manual revoke; invalidate old links where
appropriate on new-version replacement; audit; a VTaVision-hosted share page that
shows the AI disclosure **even when the underlying video is Mode C**; traffic
Safety Guard.

## Decision 13 — Company logo / branding

Included in the initial release:

- one organization-level logo per organization, managed by OWNER/ADMIN;
- PNG/WebP, including transparent background;
- per-video display ON/OFF, **default ON**;
- placed so it does not interfere with the AI disclosure;
- size/placement scale relative to output dimensions.

Rules:

- AI disclosure mode and company logo are **independent** concepts;
- changing the organization logo does **not** silently rewrite historical
  deliverables;
- changing only the logo on a video uses **recomposition**, not an AI Provider
  regeneration — from the Clean Master once scene videos have expired
  (Decision 17);
- **a logo-only recomposition is free** (decision gate CLOSED): it consumes no
  Unit, reserves no customer Unit, and does **not** increment the
  disclosure-change count. It is still recomposition from the Clean Master, still
  passes normal technical validation before it becomes a new deliverable/version,
  and if it fails technically the previous valid deliverable is retained;
- **a change of disclosure mode and logo in the same operation counts as one
  disclosure change** under Decision 9 — no separate logo charge, no separate
  logo counter. Logo participation never adds a Unit;
- **no forced VTaVision watermark** in the initial release;
- available to **all** initial-release plans.

Multi-brand, branch-specific logos and templates are **not** initial release.

## Decision 14 — Near-duplicate images: no customer warning, no customer block

This closes the open "block vs warn" question.

- **Do not** show customer-facing near-duplicate warnings.
- **Do not** block generation because images appear visually similar.
- This is intentionally **customer responsibility**.

Existing perceptual-hash / duplicate-analysis data may remain available
**internally** for engineering and quality analysis, but near-duplicate
similarity must not create customer warnings, generation rejection, or Unit
consequences in the initial release. **No new near-duplicate UX.**

**Implementation delta, stated plainly rather than papered over:** the shipped
Phase 3B analysis-review surface *does* currently cluster near-duplicates and
permit only one member of a group to be approved. That is customer-facing
near-duplicate behaviour, so it contradicts this decision and must be removed or
neutralized as implementation work. It is recorded as an open task in
`docs/decisions/TODO.md`. Documentation alone does not resolve it, and the Phase
3B records stay as historical evidence of what shipped.

## Decision 15 — Content moderation

Use a **conventional generative-video safety policy**, not a bespoke VTaVision
ideology.

Generation is blocked for clear prohibited-content categories commonly prohibited
by mainstream generative AI/video services, including:

- sexually explicit / pornographic content
- sexual exploitation of minors
- extreme violence / gore / encouragement of violence
- self-harm or suicide encouragement
- hate / targeted discriminatory abuse
- terrorism or violent-extremist support or praise
- illegal / criminal facilitation
- non-consensual sexual imagery / severe privacy abuse
- malicious impersonation / abusive deepfakes
- fraud / harmful deception
- anything explicitly prohibited by the active Provider's applicable-use policy

Rules:

- moderation refusal happens **before a paid Provider call** wherever reasonably
  possible;
- **a moderation-blocked request must not consume a Unit**;
- copyright, trademark, portrait rights and source-material authorization
  **cannot** be treated as perfectly machine-detectable — the customer
  contractually warrants they hold the necessary rights to uploaded material;
- content moderation stays **separate** from VTaVision's preservation-first
  real-estate integrity rules. They answer different questions and must not be
  collapsed into one check or one error vocabulary.

## Decision 16 — Video project management

Initial release includes project **rename**, **settings change** and
**deletion**.

When settings change while outputs already exist:

- new settings are **new generation conditions**;
- existing completed outputs remain **historical versions** rather than being
  silently rewritten.

Project/property deletion follows the 30-day trash lifecycle (Decision 17).

## Decision 17 — Retention and storage lifecycle

| Asset | Retention |
| --- | --- |
| Source images | while property/project exists |
| Normalized images | while property/project exists |
| Scene videos | delete 30 days after final completion |
| **Clean Master** (internal, overlay-free) | retained with the associated retained video/property content; follows the same trash/recovery lifecycle; physically deleted when that content is physically deleted, subject to legal hold where applicable |
| Composition temporary files | delete promptly, once no longer required |
| Current final video | until the applicable customer-content lifecycle deletes it |
| Old final-video versions | 30 days |
| Customer-deleted image/video/property | 30-day trash recovery, then physical deletion |
| Audit / Billing / Consent | separate legal-retention lifecycle (ADR-0053) |

Old final versions during their 30 days:

- previewable with `video.view`; downloadable with `video.download`;
- show version, date and disclosure mode;
- **no "restore old version as current"** feature in the initial release;
- downloading an old version **consumes no Unit**.

A property in trash: hidden from normal lists; child content follows the trash
state; no generate/regenerate, no disclosure change, no upload, no edit;
preview/download remain available when authorized; restore restores property and
children; histories and counters are **not** reset; physical delete after 30
days.

Customer storage quota **counts**: retained source images, retained normalized
images, retained current final video.

Customer storage quota **does not count**: internal Scene media, the internal
**Clean Master**, composition temp, 30-day retained old final versions,
Audit/Billing records.

Quota sizes, thresholds, blocking behaviour and additional-storage pricing are in
ADR-0053.

### Clean Master — recomposition after scene videos are deleted

**Decision gate CLOSED.** Decisions 9 and 13 promise disclosure-mode and logo
changes by recomposition with no time limit, and this decision deletes scene
videos after 30 days. The two are reconciled by retaining **one overlay-free
Clean Master** per deliverable.

**Definition.** During or following final composition, one durable Clean Master
is preserved. It contains the finished content needed to recreate the
deliverable — the final edited visual sequence and the other non-brand,
non-disclosure composition elements — and it **must not** contain a burned-in AI
disclosure or a burned-in organization logo. The customer-facing deliverable is
produced *from* the Clean Master by applying the selected disclosure and logo
layer. Codec, container and runtime representation are not specified here.

**Scene videos still delete 30 days after final completion.** They are **not**
retained indefinitely to support later disclosure or logo changes; that is
exactly what the Clean Master replaces.

**Retention.** The Clean Master is retained with the associated retained
video/property content; if the customer deletes that content, it follows the same
approved trash/recovery lifecycle; it is physically deleted when that content
reaches final physical deletion. No orphan Clean Master is kept after its owning
content is physically deleted, absent a separate legal hold.

**Internal only.** It is an internal derived asset: **not counted toward the
customer's storage quota** — an accepted VTaVision infrastructure cost, and not
something the +50 GB storage add-on buys — and **not directly downloadable or
otherwise customer-exposed.** Customers see only customer-facing final versions.

**Later changes.** After scene videos are deleted, a disclosure-mode or logo
change runs:

```text
Clean Master → apply requested disclosure/logo → validate → publish as the new deliverable/version
```

No AI provider generation call is required, so these remain **recomposition, not
regeneration**. All Decision 9 disclosure-change accounting is unchanged, and a
logo-only change does not become a provider regeneration because scene videos have
expired.

**Cost.** Creating and retaining the Clean Master consumes **no customer Unit** and
is **not separately billed**; it is a VTaVision infrastructure cost. No storage-cost
estimate is recorded here as a contractual or product figure.

## Decision 18 — Authentication

Initial release: **email/password, mandatory email verification,
authenticator-app (TOTP) MFA, recovery codes.**

MFA is **mandatory** for OWNER, ADMIN, any user with `permission.manage`, and any
user with `billing.manage`. Other users may enable it optionally. An organization
may require MFA for all members.

Password reset, MFA changes, recovery-related changes and security-sensitive
identity events must be auditable.

**The post-release roadmap must explicitly retain:** Microsoft Entra ID SSO,
Google SSO, organization-level SSO-required mode, and possible password-login
disablement for SSO-enforced organizations. These must not be dropped from the
roadmap.

## Decision 19 — Settlement of permanent technical failure

**Decision gate CLOSED.** This answers the question Phases 5B and 5C each left
open from their own direction.

The global invariant:

> **If VTaVision does not successfully provide the requested new technically
> valid Deliverable, the reservation for that unsuccessful generation or
> recomposition must not remain stuck, and must not become `CONSUMED`.**

Once bounded recovery is exhausted, or the failure is conclusively permanent:

- **terminally settle** the technical failure — a reservation may not sit pending
  indefinitely;
- **RELEASE** the applicable reserved Unit;
- the customer **consumes no Unit** for that failed delivery;
- **VTaVision bears** the provider, cloud and internal technical cost already
  incurred.

The customer-facing message is unchanged:

```text
動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。
```

### The three cases

**Initial generation.** If no technically valid deliverable can be produced after
the approved bounded recovery process, terminally fail the customer generation,
release the reservation, and consume no Unit.

**Customer-requested paid regeneration.** If the newly requested regeneration
cannot produce a technically valid deliverable, release the regeneration
reservation, consume no additional Unit for it, and **retain the previously
delivered valid video as current** where one exists. A failed regeneration never
costs the customer the video they already had.

**Disclosure/logo recomposition.** If a recomposition fails: do **not** increment
the successful disclosure-change count; if the attempt sat at a Unit-charging
boundary — the 4th or 7th completed change under Decision 9 — **release** the
reserved Unit, because no new technically valid Deliverable was delivered; and
preserve the previous valid deliverable.

### Failure class must not change the bill

`BLOCKED`, `INVALID_MEDIA`, `INTEGRITY_MISMATCH` and any equivalent internal
technical-failure vocabulary **must not produce different customer billing
outcomes** merely because the internal failure class differs. A customer is
billed for a delivered valid video, not for which component gave up.

**No new domain state name is invented here.** Whether an existing state already
unambiguously represents this settlement, or a new one is required, is
state-machine design and belongs to the implementation package.

## Decision 20 — Operator recovery from terminal technical failure

**Decision gate CLOSED.** Recovery from an internal terminal technical failure is
an **internal VTaVision operational action**, not a customer action.

**Customers — including `OWNER` and `ADMIN` — cannot unblock an internal
technical `BLOCKED` row or rewrite a terminal media verdict.** This privilege is
separate from the customer role templates of Decision 10 and is not reachable
through any of them; only an explicitly authorized internal operator may initiate
it (ADR-0054 Decision 6 governs that privilege).

**Terminal evidence is immutable.**

- the original `BLOCKED` row and its `blockCode` / `blockedAt` evidence remains
  as written;
- the original `INVALID_MEDIA` / `INTEGRITY_MISMATCH` verdict remains as written;
- **historical terminal evidence is never mutated back into a retryable state;**
- where recovery is appropriate, it creates a **new** recovery/composition cycle.

Audit, at minimum: operator identity; organization; target Job / Deliverable /
row; recovery reason; the original block or verdict cause; timestamp; and the
resulting new recovery-cycle identifier.

Recovery remains subject to every existing invariant: no blind Provider POST
retry; reconciliation first for an ambiguous submission; the Safety Guard;
provider activation rules; bounded recovery; and the tenant boundary.

### Row versus cause

**The authoritative mutation unit is the individual row / work item.**

A future operator tool **may** offer cause-based bulk *selection* — after a known
configuration defect affected many rows, for example. Cause-level handling means
exactly this:

```text
cause filter
→ enumerate candidate rows
→ re-evaluate eligibility for EACH row
→ transactional / CAS-safe action PER row
→ audit EACH row
```

**A global "unblock this cause and automatically revert all rows" operation must
not be introduced.** Bulk selection is a convenience over per-row decisions; it
is never a substitute for them.

---

## Consequences

One product authority now exists for the initial release, and the largest stale
assumption in the repository — a mandatory approve/reject gate on the finished
video — is explicitly removed rather than left to be discovered mid-phase.

**Accepted cost.** Removing the approval gate moves the "is this fit to publish"
judgement entirely to the customer, after preview. That is deliberate: VTaVision
is not the customer's advertising-law approval authority (ADR-0053), and a gate
that implied otherwise was a liability rather than a safeguard.

**Accepted cost.** Unit consumption on technically valid delivery will sometimes
charge a customer for a video they dislike. The alternative — free regeneration
on dissatisfaction — makes generation cost unbounded and uninsurable against
taste. The boundary is drawn at *technical validity*, which is measurable, rather
than at satisfaction, which is not.

**Accepted cost.** The internal recovery budget is invisible to customers, so an
exhausted budget produces a failure message that does not explain itself. Exposing
it would turn an internal cost control into a customer-negotiable quantity.

**Accepted cost.** Decision 19 puts the whole cost of a permanently failed
generation on VTaVision — provider spend, cloud spend and operator time, with no
Unit recovered. That is the price of a billing rule a customer can trust: they
are charged for a delivered valid video, never for an attempt. It also means a
systematic quality regression is expensive quickly, which is the correct
incentive.

**Accepted cost.** Decision 20 keeps recovery away from customers entirely, so an
`OWNER` whose job is stuck must wait for VTaVision rather than retry it
themselves. A customer-visible unblock button would re-enter the automatic retry
loop that terminal states exist to end, and would let a tenant drive paid
provider spend from a failure path.

**Accepted cost.** Refusing a cause-level "revert all rows" operation makes bulk
recovery after a configuration defect slower and more code. Per-row re-evaluation
is the only version that cannot silently act on a row whose eligibility changed
since the filter ran.

**Accepted cost.** The grant ceiling makes `OWNER` a bottleneck: adding an
administrator, adding a billing user, handing out `billing.manage`, and granting
or revoking `disclosure.none` all require an `OWNER`, and an organization whose
only `OWNER` is unavailable cannot do those things at all. For `disclosure.none`
this is the point rather than a side effect: whether a video may omit its AI
disclosure is decided by the organization's highest authority, one user at a
time, never by a group or an administrator acting on its own behalf. That is the intended shape — the alternative is an `ADMIN` who can
manufacture its own billing authority, which makes the separation decorative. It
does mean the authorization model must be implemented as a ceiling check on every
grant path, including group membership and Scope, rather than as a single
`permission.manage` boolean.

**Accepted cost.** Retaining one Clean Master per retained deliverable, outside
the customer quota, is a standing storage cost VTaVision absorbs so that a
disclosure or logo change never becomes a paid regeneration. It is deliberately
one master, not every scene video.

**Accepted cost.** Freezing Mode C at admission means a video admitted as Mode C
before a revocation is still delivered without disclosure. The alternative — a
pre-delivery re-check — would make admission meaningless as a contract and would
need a settlement rule for a withdrawn authorization.

**Open implementation work** — none of this is built by this ADR. The AI
disclosure is unrendered at every layer, the authorization model is not
implemented (the matrix in Decision 10 is now approved but unbuilt),
disclosure-mode change accounting does not exist, the logo pipeline does not
exist, permanent-failure settlement and operator recovery have no code, and the
Phase 3B near-duplicate UX still contradicts Decision 14. Tracked in
`docs/decisions/TODO.md`.
