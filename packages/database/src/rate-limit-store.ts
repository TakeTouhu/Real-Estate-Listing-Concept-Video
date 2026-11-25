import {
  checkRateLimitPolicy,
  checkRateLimitSubject,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitStore,
} from "@app/domain";
import { AppError } from "@app/shared";
import type { PrismaClient } from "@prisma/client";

/** How many expired rows of other keys each hit deletes (ADR-0169 Decision 6). */
export const RATE_LIMIT_PRUNE_PER_HIT = 2;

interface HitRow {
  readonly windowStartedAt: Date;
  readonly count: number;
  readonly lockedUntil: Date | null;
  readonly allowed: boolean;
}

/**
 * Abuse-limit counters in `rate_limit_counters` (RD-7b, ADR-0169). Each hit
 * is one statement, run alone at READ COMMITTED on the client given, never
 * inside a caller's transaction: it decides from the row as it was, writes
 * the new row and deletes up to two expired rows of other keys. Times are
 * the caller's, written as UTC whatever the session's zone.
 */
export function createPrismaRateLimitStore(prisma: PrismaClient): RateLimitStore {
  return {
    async hit(policy: RateLimitPolicy, subject: string, now: Date): Promise<RateLimitDecision> {
      const { name, limit, windowSeconds, cooldownBaseSeconds, cooldownMaxSeconds, decaySeconds } =
        checkRateLimitPolicy(policy);
      checkRateLimitSubject(subject);
      const rows = await prisma.$queryRaw<HitRow[]>`
WITH pruned AS (
  DELETE FROM "rate_limit_counters"
   WHERE ("policy", "subject") IN (
         SELECT "policy", "subject" FROM "rate_limit_counters"
          WHERE "expiresAt" < (${now}::timestamptz AT TIME ZONE 'UTC')
            AND NOT ("policy" = ${name} AND "subject" = ${subject})
          ORDER BY "expiresAt"
          LIMIT ${RATE_LIMIT_PRUNE_PER_HIT}
            FOR UPDATE SKIP LOCKED)
), p AS (
  SELECT ${name}::text AS policy,
         ${subject}::text AS subject,
         (${now}::timestamptz AT TIME ZONE 'UTC') AS now,
         ${limit}::int AS lim,
         ${windowSeconds}::int * interval '1 second' AS win,
         ${cooldownBaseSeconds}::int AS base,
         ${cooldownMaxSeconds}::int AS cap,
         ${decaySeconds}::int * interval '1 second' AS decay
)
INSERT INTO "rate_limit_counters" AS c
  ("policy", "subject", "windowStartedAt", "count", "lockedUntil", "lockLevel", "expiresAt")
SELECT p.policy, p.subject, p.now, 1, NULL, 0, p.now + p.win FROM p
ON CONFLICT ("policy", "subject") DO UPDATE SET
  ("windowStartedAt", "count", "lockedUntil", "lockLevel", "expiresAt") = (
    SELECT n.ws, n.cnt, n.lu, n.lvl, GREATEST(n.ws + p.win, n.lu + p.decay)
      FROM p,
   LATERAL (SELECT COALESCE(c."lockedUntil" > p.now, false) AS locked,
                   p.now >= c."windowStartedAt" + p.win AS expired) s,
   LATERAL (SELECT NOT s.locked AND NOT s.expired AND c."count" >= p.lim AS over,
                   p.base > 0 AS grows) o,
   LATERAL (SELECT CASE WHEN c."lockedUntil" IS NOT NULL AND p.now < c."lockedUntil" + p.decay
                        THEN c."lockLevel" + 1 ELSE 1 END AS lvl) g,
   -- In seconds before any interval is formed: a year's base times 2^19 would overflow one (ADR-0169 Decision 2).
   LATERAL (SELECT (LEAST(p.base::numeric * power(2::numeric, LEAST(g.lvl - 1, 25)), p.cap)::double precision
                    * interval '1 second') AS cool) k,
   LATERAL (SELECT
     CASE WHEN s.locked THEN c."windowStartedAt"
          WHEN s.expired THEN p.now
          WHEN o.over AND o.grows THEN p.now + k.cool
          ELSE c."windowStartedAt" END AS ws,
     CASE WHEN s.locked THEN c."count"
          WHEN s.expired THEN 1
          WHEN o.over AND o.grows THEN 0
          WHEN o.over THEN p.lim + 1
          ELSE c."count" + 1 END AS cnt,
     CASE WHEN o.over AND o.grows THEN p.now + k.cool ELSE c."lockedUntil" END AS lu,
     CASE WHEN o.over AND o.grows THEN g.lvl ELSE c."lockLevel" END AS lvl) n
  )
RETURNING c."windowStartedAt" AS "windowStartedAt", c."count" AS "count", c."lockedUntil" AS "lockedUntil",
          (c."count" <= (SELECT lim FROM p)
           AND NOT COALESCE(c."lockedUntil" > (SELECT now FROM p), false)) AS "allowed"`;
      const row = rows[0];
      if (row === undefined) throw new AppError("INTERNAL_ERROR", "The rate-limit hit returned no row");
      if (row.allowed) return { allowed: true, windowStartedAt: row.windowStartedAt, count: row.count };
      const locked = row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
      const windowEnd = new Date(row.windowStartedAt.getTime() + windowSeconds * 1000);
      return { allowed: false, retryAt: locked && row.lockedUntil !== null ? row.lockedUntil : windowEnd };
    },

    async giveBack(policy: RateLimitPolicy, subject: string, windowStartedAt: Date): Promise<void> {
      const { name, limit } = checkRateLimitPolicy(policy);
      checkRateLimitSubject(subject);
      await prisma.$executeRaw`
UPDATE "rate_limit_counters" SET "count" = "count" - 1
 WHERE "policy" = ${name} AND "subject" = ${subject}
   AND "windowStartedAt" = (${windowStartedAt}::timestamptz AT TIME ZONE 'UTC')
   AND "count" BETWEEN 1 AND ${limit}`;
    },

    async forget(policy: RateLimitPolicy, subject: string): Promise<void> {
      const { name } = checkRateLimitPolicy(policy);
      checkRateLimitSubject(subject);
      await prisma.$executeRaw`DELETE FROM "rate_limit_counters" WHERE "policy" = ${name} AND "subject" = ${subject}`;
    },
  };
}
