# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-07-27
- Phase: 0

## Context

The project is a commercial, multi-tenant SaaS with significant security,
billing, and provider-replacement concerns. Decisions need a durable, reviewable
record so later phases (and new contributors) understand why the system is
shaped the way it is.

## Decision

We record significant architectural and technology decisions as Architecture
Decision Records (ADRs) in `docs/decisions/`, numbered sequentially, using a
short Context / Decision / Consequences format. An ADR is immutable once
accepted; a superseding ADR is written instead of editing history.

## Consequences

- Reviewers can see the rationale behind each decision in the pull request that
  introduces it.
- Unresolved questions and assumptions are tracked separately in
  `docs/decisions/TODO.md` (per CLAUDE.md: "Do not invent missing business
  rules").
