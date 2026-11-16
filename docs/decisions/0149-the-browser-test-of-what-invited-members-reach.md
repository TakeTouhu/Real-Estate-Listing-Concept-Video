# ADR-0149 — The browser test of what invited members reach

Status: Accepted (AT-12, 2026-11-16). The last milestone of the accounts-and-
team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`: "Playwright test:
invite, sign up, verify, join, see only assigned Properties; password reset;
completion report").

Builds on: ADR-0052 Decision 10 (Scope fixed by role), ADR-0062 (a
Property's responsible user and group), ADR-0064 (Property reach, and out of
reach answered as not found), ADR-0121 (the browser test), ADR-0138
(opening and accepting an invitation), ADR-0143 (a group's members),
ADR-0144 and ADR-0145 (choosing a Property's assignment).

## Context

The browser tests on `main` already show most of what the plan names:

- joining by invitation (AT-7b, ADR-0138): an owner invites, the colleague
  opens the emailed link, creates an account, verifies it and joins; the
  test then changes their role (ADR-0139), gives and takes back a permission
  (ADR-0147) and removes them (ADR-0140);
- resetting a forgotten password (AT-4c, ADR-0133);
- groups (AT-9, AT-11c), a Property's assignment (AT-10) and a member's
  permissions page (AT-11a).

None shows a member reaching only the Properties assigned to them or to
their group, the plan's goal ("the colleague sees only the Properties
assigned to them; the owner assigns a Property, and the colleague works on
it", `docs/accounts-team-gap-analysis.md`). Reach is enforced and tested in
the domain and the database (ADR-0064); no test takes a member through it in
a browser.

## Decision 1 — A test of reach by role, with two invited members

`tests/e2e/members-see-only-their-properties.spec.ts`, with its own owner
and plan (ADR-0121 Decision 2):

- the owner creates two Properties and a group, and invites a `CREATOR` and
  a `MANAGER`; each joins in their own browser from the emailed link, with a
  new account verified from the outbox, and sees no Property yet;
- the owner makes the `CREATOR` responsible for one Property from its page
  (ADR-0144), adds the `MANAGER` to the group (ADR-0143) and creates a third
  Property in that group (ADR-0145);
- the `CREATOR`'s home page then lists only its own Property, the
  `MANAGER`'s only the group's, and the owner's all three;
- the `CREATOR` works on its Property: it uploads the Property's three
  photos, which are processed;
- every Property a member does not reach answers "Property not found" from
  its address too (ADR-0064 Decision 3).

Two roles are taken because each reaches by a different assignment: `OWN`
by the responsible user, `GROUP` by the group. `ORGANIZATION` is the owner's,
shown by the owner's own list.

## Decision 2 — The other parts are proved where they already are

The invitation, sign-up, verification and acceptance run again in this test,
since a member must join to be reached, but without the assertions the
joining test already makes. Password reset is proved by its own test
(ADR-0133) and is not repeated. No browser test is changed.

## Decision 3 — No product change

The test asserts what is built. It adds no route, page, permission,
migration or audit action, and changes no code outside `tests/e2e`.

## Consequences

- CI's `e2e` job runs ten browser tests.
- With this test, every part of the plan's goal is shown in a browser. The
  plan's completion report is `docs/accounts-team-completion.md`.
