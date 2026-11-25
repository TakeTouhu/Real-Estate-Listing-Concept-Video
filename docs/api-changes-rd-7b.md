# API Changes — RD-7b

The abuse-limit counters in PostgreSQL (ADR-0169). **Migration 35; no
route, no page, no setting and no dependency.** Nothing builds the store
yet; RD-7d does.

## HTTP

No change.

## Database

Migration 35 (`00000000000035_rate_limit_counters`) adds the table
`rate_limit_counters`, one row per `("policy", "subject")`, with an index
on `"expiresAt"` and the CHECK `rate_limit_counters_shape_check`
(`docs/migration-notes.md`).

## Internal API

### New, from `@app/database`

| Export | What it is |
| --- | --- |
| `createPrismaRateLimitStore(prisma)` | a `RateLimitStore` on the client given: each `hit` is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, run alone, which also deletes up to two expired rows of other keys; `giveBack` and `forget` are one statement each |
| `RATE_LIMIT_PRUNE_PER_HIT` | 2, the expired rows each hit deletes (ADR-0169 Decision 6) |

The store checks the policy and the subject before it writes, as the
in-memory store does, and throws `INTERNAL_ERROR` if a hit returns no row.
