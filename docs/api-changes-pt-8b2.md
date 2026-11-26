# API Changes — PT-8b2

The seed covers every table (ADR-0191 Decision 4, "Built in PT-8b";
PT-8b has no ADR of its own). Production readiness, part 2. **No
route, request, response, stored value, setting, image, CI step or
migration changes.** What changes is the seed at migration 35, its
check and its coverage test.

## The seed

`tests/migrations/seed/00000000000035.sql` gains the 21 tables PT-8b1
left for this milestone, 215 rows: `properties` (5), `media_assets`
(27), `asset_analyses` (19), `video_projects` (4), `storyboard_scenes`
(18), `generation_jobs` (12), `generation_deliverable_versions` (15),
`generation_reservations` (8), `generation_reservation_allocations`
(7), `generation_scenes` (6), `scene_generation_requests` (10),
`scene_generations` (22), `fx_rate_snapshots` (2),
`generation_pricing_snapshots` (3), `managed_output_media_validations`
(13), `managed_output_media_failure_resolutions` (7),
`generation_deliverable_inputs` (4),
`generation_deliverable_compositions` (13),
`generation_deliverable_validations` (10),
`generation_deliverable_clean_masters` (2) and
`generation_transition_events` (8). Every table of `schema.prisma` is
now seeded (41).

What the rows hold, measured with a catalog query against the seeded
database:

- every value of the 38 enum columns of these tables (all 15 room types
  as `roomType`, as `roomTypeOverride` and as a storyboard scene's;
  every job, reservation, scene, request, attempt and validation state;
  every retry, block, invalid-reason, refusal and resolution code);
- `NULL` and a value in each of their 127 nullable columns;
- both values of every two-value text CHECK (`720p`, `1080p`) and all
  three resolution normalizations;
- rows sharing what a later uniqueness rule could refuse: one SHA-256
  and perceptual hash in three assets across two organizations, and one
  duplicate group in three analyses across two organizations; one photo
  in two projects' storyboards; one idempotency key in three projects
  and `NULL` more than once in one; two regenerations of one scene with
  one ordinal, one delivered and one failed; one add-on block drawn by
  two reservations; one attempt in two deliverable versions; one
  recovery attempt admitted by two resolutions; one aggregate and
  sequence under two types; inactive attempts sharing an active one's
  request hash; one composition output, one deliverable validation
  receipt and one Clean Master SHA-256 in two versions;
- the row current code writes before orchestration: a `sha256:v2:`
  request hash with its five fields and no orchestration column;
- the bounds the CHECKs set: durations 1, 30, 31, 60, 61 and 90 with
  their unit counts, the 1- and 200-character idempotency key, sizes 1
  and 9007199254740991, the smallest and largest even raster, a 1 ms
  billing window, counters at 0 and integer and bigint maxima.

Every value is seeded in a combination the CHECKs and partial unique
indexes at level 35 allow, but not every combination they allow is
seeded. The seed's header names the rules that tie these columns
together. The limit is ADR-0191's: a failure that needs data the seed
lacks is not caught.

Rows otherwise reference each other as production's would: an
attempt's storyboard scene, photo, analysis revision and project are
its request's scene's, an event's organization is its job's, and a
reservation's state follows its job's. Two shapes no production path
writes are kept on purpose, and the header says so: media validations
of attempts that are not `OUTPUT_VERIFIED`, and one recovery attempt
admitted by two resolutions of attempts on other requests. Covering
every validation status, invalid reason and resolution with consistent
rows would take about twelve more attempts *(inference, not built)*.

Two pairs of rows reference each other: a job and its current
deliverable version, a scene and its current delivered request. Each
pair is inserted by one statement, `WITH … AS (INSERT …) INSERT …`;
PostgreSQL checks both foreign keys at the statement's end *(measured
on PostgreSQL 16: the pair inserts, and a wrong key is refused)*.

Values are fake: `seed35` in every id and storage key, hex built from
`5eed35`, `seed35-provider` and `seed35-model` for the route, no real
URL, provider job id or signed link.

## The check and the coverage test

`check.sql` checks the 21 tables as it checks the first 20: the seeded
row count and an MD5 of every seeded column. Allowed changes: still
none.

`seed-coverage.test.ts` loses the PT-8b2 list: every table of
`schema.prisma` must be seeded, or it fails. A seed statement may now
be an `INSERT` after one `WITH` holding an `INSERT`, the test matching
the `WITH`'s parentheses to find the outer statement; `UPDATE`,
`DELETE` and `MERGE` join the banned words.

## Rehearsed by hand

On a throwaway PostgreSQL 16, not committed: a temporary migration
`99999999999999_rehearsal_*` applied to the fresh database (exit 0
each), then `upgrade.sh`:

| Temporary migration | `upgrade.sh` |
| --- | --- |
| `scene_generations` gains a `NOT NULL` column without a default | exit 1, 23502 |
| `generation_jobs` gains `CHECK (state <> 'REVISING')` | exit 1, 23514 |
| `UPDATE generation_reservations` on `CONSUMED` rows | exit 3, digest changed |
| a unique index on `sceneGenerationAttemptId` of the inputs | exit 1, 23505 |
| a unique index on `storyboard_scenes."assetId"` | exit 1, 23505 |
| compositions gain `CHECK ("attemptCount" > 0)` | exit 1, 23514 |
| attempts gain a CHECK that a `sha256:v2:` row is orchestrated | exit 1, 23514 |
| a plain index on `generation_jobs."createdAt"` | exit 0 |

## Not applicable

- **OpenAPI:** no route, request or response body changes.
- **ER diagram and migration:** no stored value changes.
- **Sequence diagram:** no request flow changes.
