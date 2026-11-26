import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The seeds `upgrade.sh` applies (ADR-0191 Decision 4, PT-8b1), read offline. Every table of `schema.prisma` is seeded
 * at some level, or waits on the list below, which PT-8b2 empties. A new table needs a row in a seed file at its
 * level, or a place on that list, or this fails.
 */
const REPO = join(__dirname, "..", "..");
const SEEDS = join(__dirname, "seed");
const MIGRATIONS = join(REPO, "packages", "database", "prisma", "migrations");

/** Not yet seeded: the property, media, storyboard, generation and FX tables, Unit reservations and allocations
 * included, come in PT-8b2. */
const NOT_YET_SEEDED_PT_8B2 = [
  "properties",
  "media_assets",
  "asset_analyses",
  "video_projects",
  "storyboard_scenes",
  "scene_generations",
  "generation_jobs",
  "generation_reservations",
  "generation_scenes",
  "scene_generation_requests",
  "generation_pricing_snapshots",
  "fx_rate_snapshots",
  "generation_transition_events",
  "managed_output_media_validations",
  "managed_output_media_failure_resolutions",
  "generation_deliverable_versions",
  "generation_deliverable_inputs",
  "generation_deliverable_compositions",
  "generation_deliverable_validations",
  "generation_deliverable_clean_masters",
  "generation_reservation_allocations",
];

/** Each model's table: its @@map name, or the model's own name. */
function schemaTables(): string[] {
  const schema = readFileSync(join(REPO, "packages", "database", "prisma", "schema.prisma"), "utf8");
  return [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map(
    ([, name, body]) => /@@map\("([^"]+)"\)/.exec(body ?? "")?.[1] ?? name ?? "",
  );
}

/** SQL with its comments and string literals left out, so only statements are judged. */
const statements = (sql: string): string => sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

const seedFiles = (): string[] => readdirSync(SEEDS).filter((file) => /^\d{14}\.sql$/.test(file));
const inserted = (file: string): string[] =>
  [...statements(readFileSync(join(SEEDS, file), "utf8")).matchAll(/\bINSERT\s+INTO\s+"?(\w+)"?/gi)].map(
    ([, table]) => table ?? "",
  );
const seeded = (): Set<string> => new Set(seedFiles().flatMap(inserted));

describe("the upgrade seeds", () => {
  it("holds seed files named by level, and check.sql, only", () => {
    const others = readdirSync(SEEDS).filter((file) => !/^\d{14}\.sql$/.test(file) && file !== "check.sql");
    expect(others).toEqual([]);
    expect(seedFiles().length).toBeGreaterThan(0);
  });

  it("names an existing migration with each seed file's level", () => {
    const names = readdirSync(MIGRATIONS);
    for (const file of seedFiles()) {
      const level = file.slice(0, 14);
      expect([file, names.filter((name) => name.startsWith(`${level}_`)).length]).toEqual([file, 1]);
    }
  });

  it("seeds every table of schema.prisma, or lists it as not yet seeded", () => {
    const tables = schemaTables();
    const missing = tables.filter((table) => !seeded().has(table) && !NOT_YET_SEEDED_PT_8B2.includes(table));
    expect(missing).toEqual([]);
    expect(tables.length).toBeGreaterThanOrEqual(41);
  });

  it("lists no table that a seed already fills, and none that schema.prisma lacks", () => {
    const tables = schemaTables();
    expect(NOT_YET_SEEDED_PT_8B2.filter((table) => seeded().has(table))).toEqual([]);
    expect(NOT_YET_SEEDED_PT_8B2.filter((table) => !tables.includes(table))).toEqual([]);
    expect([...seeded()].filter((table) => !tables.includes(table))).toEqual([]);
  });

  it("checks every seeded table after the upgrade, and only those", () => {
    const check = readFileSync(join(SEEDS, "check.sql"), "utf8");
    const checked = [...check.matchAll(/^ {4}\('(\w+)', '(\w+)', (\d+), '[0-9a-f]{32}',$/gm)].map(([, t]) => t);
    expect([...checked].sort()).toEqual([...seeded()].sort());
  });

  it("holds data only: INSERT statements in a seed, one DO block in the check, and no psql command", () => {
    // A psql command (\set, \c, \!, anywhere on a line) or a transaction, session or COPY statement could undo
    // `psql -1 -v ON_ERROR_STOP=1`, reach another database, or run a program with the job's environment.
    const words = "DROP|TRUNCATE|ALTER|CREATE|COPY|PROGRAM|COMMIT|ROLLBACK|SAVEPOINT|SET|RESET|GRANT|REVOKE|CALL";
    const banned = new RegExp(`\\b(${words})\\b`, "gi");
    for (const file of [...seedFiles(), "check.sql"]) {
      const sql = readFileSync(join(SEEDS, file), "utf8");
      const psql = statements(sql)
        .split("\n")
        .filter((line) => line.includes("\\"));
      expect([file, psql, statements(sql).match(banned) ?? []]).toEqual([file, [], []]);
    }
    for (const file of seedFiles()) {
      const others = statements(readFileSync(join(SEEDS, file), "utf8"))
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== "" && !/^INSERT\s+INTO\s/i.test(statement));
      expect([file, others]).toEqual([file, []]);
    }
    const check = statements(readFileSync(join(SEEDS, "check.sql"), "utf8")).trim();
    expect(check).toMatch(/^DO \$check\$\n[\s\S]*\n\$check\$;$/);
    expect(check.split("$check$").length).toBe(3);
  });
});
