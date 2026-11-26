import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `database` job runs the migration checks of ADR-0191, read as text. A line that may hold a credential or an
 * address is never compared or printed: a failure shows only line numbers, booleans and step names.
 */
const REPO = join(__dirname, "..", "..");
const LINES = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8").split(/\r?\n/);
const SCRIPTS = ["tests/migrations/append-only.sh", "tests/migrations/checksums.sh", "tests/migrations/upgrade.sh"];
const SECRET = /password|database_url|postgres(ql)?:\/\//i;
/** What would skip Prisma's lock, reset or push a schema, drop data, or put an address on a command line. */
const BANNED = new RegExp(
  [
    "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK|migrate\\s+dev\\b|migrate\\s+reset\\b|db\\s+push\\b",
    "--accept-data-loss|--force-reset|--from-url|--to-url",
  ].join("|"),
);

/** The `database` job's lines, from its key to the next job's. */
function databaseJob(): string[] {
  const first = LINES.indexOf("  database:");
  const next = LINES.findIndex((line, i) => i > first && /^ {2}[a-z][\w-]*:$/.test(line));
  expect([first > 0, next > first]).toEqual([true, true]);
  return LINES.slice(first, next);
}

/** Each step as its trimmed lines, comments left out, the first without its leading "- ". */
function steps(job: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const line of job) {
    if (line.trimStart().startsWith("#") || line.trim() === "") continue;
    if (/^ {6}- /.test(line)) out.push([line.trim().slice(2)]);
    else if (out.length > 0 && /^ {8}/.test(line)) out.at(-1)?.push(line.trim());
  }
  return out;
}

const nameOf = (step: readonly string[]): string => /^name: (.+)$/.exec(step[0] ?? "")?.[1] ?? "";
const named = (name: string): string[] => steps(databaseJob()).find((s) => nameOf(s) === name) ?? [];
/** A step's lines with every line that may hold a credential or address left out. */
const safe = (step: readonly string[]): string[] => step.filter((line) => !SECRET.test(line));

describe("the database job's migration checks", () => {
  it("checks out the first parent too, with no Git credentials kept", () => {
    const checkout = steps(databaseJob()).find((s) => s[0] === "uses: actions/checkout@v4") ?? [];
    expect(safe(checkout)).toEqual([
      "uses: actions/checkout@v4",
      "with:",
      "fetch-depth: 2",
      "persist-credentials: false",
    ]);
  });

  it("checks the checksums after the fresh apply, append-only after the drift check, then the seeded upgrade", () => {
    const names = steps(databaseJob()).map(nameOf);
    const at = (name: string): number => names.indexOf(name);
    const apply = at("Apply migrations to an empty database");
    const sums = at("Check the applied migrations' checksums");
    const drift = at("Verify committed migrations match the schema");
    const append = at("Check that no applied migration changed");
    const upgrade = at("Upgrade a seeded database to the head's migrations");
    const tests = at("Database integration tests");
    expect([apply > 0, sums === apply + 1, drift > sums, append === drift + 1, upgrade === append + 1]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(tests === upgrade + 1).toBe(true);
  });

  it("runs checksums.sh on the committed migrations through libpq's environment, bounded", () => {
    const step = named("Check the applied migrations' checksums");
    expect(safe(step).slice(1, 3)).toEqual(["timeout-minutes: 2", "run: >-"]);
    const run = step.slice(3);
    expect(run.length).toBe(2);
    expect(/^PGPASSWORD=\S+ PGHOST=localhost PGUSER=revt PGDATABASE=revt$/.test(run[0] ?? "")).toBe(true);
    // A boolean, so a failure never prints the line: a later edit could put the password's line here.
    expect(run[1] === "bash tests/migrations/checksums.sh packages/database/prisma/migrations").toBe(true);
  });

  it("runs append-only.sh on the first parent's tree with pipefail, failing when the first parent is missing", () => {
    expect(safe(named("Check that no applied migration changed")).slice(1)).toEqual([
      "timeout-minutes: 2",
      "shell: bash",
      "run: |",
      "if ! git rev-parse --verify --quiet 'HEAD^1^{commit}' > /dev/null; then",
      'echo "::error::The first parent, HEAD^1, is not in the checkout: the job needs fetch-depth: 2."',
      "exit 1",
      "fi",
      'mkdir -p "$RUNNER_TEMP/parent"',
      'git archive "$(git rev-parse HEAD^1)" packages/database/prisma | tar -x -C "$RUNNER_TEMP/parent"',
      [
        "bash tests/migrations/append-only.sh",
        '"$RUNNER_TEMP/parent/packages/database/prisma"',
        "packages/database/prisma",
      ].join(" "),
    ]);
  });

  it("runs upgrade.sh on a new database through libpq's environment, bounded, with prisma's URL in the job", () => {
    const step = named("Upgrade a seeded database to the head's migrations");
    expect(safe(step).slice(1, 3)).toEqual(["timeout-minutes: 3", "run: >-"]);
    const run = step.slice(3);
    expect(run.length).toBe(2);
    expect(/^PGPASSWORD=\S+ PGHOST=localhost PGUSER=revt PGDATABASE=revt$/.test(run[0] ?? "")).toBe(true);
    const command = "bash tests/migrations/upgrade.sh packages/database/prisma tests/migrations/seed revt_upgrade";
    expect(run[1] === command).toBe(true);
    // Booleans only: the line holds a password.
    const url = databaseJob().filter((line) => line.startsWith("      UPGRADE_DATABASE_URL: "));
    expect([url.length, url.every((line) => line.endsWith("@localhost:5432/revt_upgrade?schema=public"))]).toEqual([
      1,
      true,
    ]);
  });

  it("runs each seed with ON_ERROR_STOP in one transaction, before the head's full deploy and the check", () => {
    const lines = readFileSync(join(REPO, "tests/migrations/upgrade.sh"), "utf8").split("\n");
    const at = (text: string): number => lines.findIndex((line) => line.trim() === text);
    const sql = at('sql() { psql -X -w -q -A -t -v ON_ERROR_STOP=1 "$@"; }');
    const seed = at('sql -1 -f "$seeds/$seed"');
    const head = at('deploy "$prisma/schema.prisma"');
    const check = at('sql -f "$seeds/check.sql"');
    const sums = lines.map((line) => line.trim()).lastIndexOf('bash "$here/checksums.sh" "$prisma/migrations"');
    expect([sql > 0, seed > sql, head > seed, check === head + 1, sums === check + 1]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("names nothing that skips the lock, resets, pushes a schema or passes an address, anywhere", () => {
    const hits = (lines: readonly string[]): number[] =>
      lines.flatMap((line, i) => (BANNED.test(line) ? [i + 1] : []));
    expect(hits(LINES)).toEqual([]);
    for (const script of SCRIPTS) {
      const lines = readFileSync(join(REPO, script), "utf8").split("\n");
      expect([script, hits(lines)]).toEqual([script, []]);
    }
  });

  it("keeps the scripts quiet about settings: no tracing, no echo of a URL, byte-order names", () => {
    for (const script of SCRIPTS) {
      const text = readFileSync(join(REPO, script), "utf8");
      const lines = text.split("\n");
      const tracing = lines.flatMap((line, i) => (/set\s+-[a-z]*x|xtrace|bash\s+-[a-z]*x/.test(line) ? [i + 1] : []));
      const echoed = lines.flatMap((line, i) =>
        /\b(?:echo|printf)\b.*\$\{?[A-Za-z_]*URL\b/.test(line) ? [i + 1] : [],
      );
      expect([script, tracing, echoed]).toEqual([script, [], []]);
      expect([script, text.includes("\nset -euo pipefail\nexport LC_ALL=C\n")]).toEqual([script, true]);
    }
  });
});
