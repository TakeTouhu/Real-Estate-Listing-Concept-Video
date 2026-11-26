import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `append-only.sh` (ADR-0191), run by bash on trees each test builds: a parent and a head, each a folder holding
 * `migrations/` as `packages/database/prisma` does.
 */
const REPO = join(__dirname, "..", "..");
const SCRIPT = join(__dirname, "append-only.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Trees {
  readonly parent: string;
  readonly head: string;
}

/** A parent holding `names`, each with one migration.sql, and the lock file; the head a copy of it. */
function trees(names: readonly string[]): Trees {
  const root = mkdtempSync(join(tmpdir(), "append-only-"));
  roots.push(root);
  const parent = join(root, "parent");
  const head = join(root, "head");
  for (const name of names) {
    mkdirSync(join(parent, "migrations", name), { recursive: true });
    writeFileSync(join(parent, "migrations", name, "migration.sql"), `-- ${name}\nSELECT 1;\n`);
  }
  mkdirSync(join(parent, "migrations"), { recursive: true });
  writeFileSync(join(parent, "migrations", "migration_lock.toml"), 'provider = "postgresql"\n');
  cpSync(parent, head, { recursive: true });
  return { parent, head };
}

function add(prisma: string, name: string): void {
  mkdirSync(join(prisma, "migrations", name));
  writeFileSync(join(prisma, "migrations", name, "migration.sql"), "SELECT 2;\n");
}

function run(t: Trees, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string } {
  const result = spawnSync("bash", [SCRIPT, t.parent, t.head], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout };
}

const OLD = ["00000000000000_init", "00000000000001_properties", "00000000000002_media"];

describe("append-only.sh", () => {
  it("passes an unchanged copy", () => {
    const t = trees(OLD);
    expect(run(t)).toEqual({ status: 0, stdout: "Append-only: the parent's 3 migration(s) are unchanged.\n" });
  });

  it("passes the repository's own migrations against themselves, old names with banned words included", () => {
    const prisma = join(REPO, "packages", "database", "prisma");
    const result = spawnSync("bash", [SCRIPT, prisma, prisma], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("refuses a comment appended to an old migration", () => {
    const t = trees(OLD);
    appendFileSync(join(t.head, "migrations", OLD[1] ?? "", "migration.sql"), "-- a note\n");
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${OLD[1]}: changed migration.sql after the parent held it`);
  });

  it("refuses a deleted migration", () => {
    const t = trees(OLD);
    rmSync(join(t.head, "migrations", OLD[2] ?? ""), { recursive: true });
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${OLD[2]}: is in the parent but not in the head`);
  });

  it("refuses a renamed migration, even to a valid later name", () => {
    const t = trees(OLD);
    renameSync(join(t.head, "migrations", OLD[1] ?? ""), join(t.head, "migrations", "00000000000003_properties"));
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${OLD[1]}: is in the parent but not in the head`);
  });

  it("refuses an extra file inside an old migration", () => {
    const t = trees(OLD);
    writeFileSync(join(t.head, "migrations", OLD[0] ?? "", "notes.txt"), "x\n");
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${OLD[0]}: holds different files in the head than in the parent`);
  });

  it("refuses a changed lock file", () => {
    const t = trees(OLD);
    writeFileSync(join(t.head, "migrations", "migration_lock.toml"), 'provider = "mysql"\n');
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("migration_lock.toml: differs from the parent's");
  });

  it("passes a valid new migration after the parent's last", () => {
    const t = trees(OLD);
    add(t.head, "00000000000003_rate_limit_counters");
    expect(run(t).status).toBe(0);
  });

  it("refuses a new migration that sorts before the parent's last", () => {
    const t = trees(OLD);
    add(t.head, "00000000000001a_x");
    add(t.head, "00000000000001_properties_more");
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`00000000000001_properties_more: is new but sorts before the parent's last`);
    expect(result.stdout).toContain("00000000000001a_x: is new but sorts before the parent's last");
    expect(result.stdout).toContain("00000000000001a_x: is new and does not match");
  });

  it("refuses a new name outside ^[0-9]{14}_[a-z0-9_]+$", () => {
    for (const name of ["00000000000003_Upper", "0000000000003_short", "00000000000003_dash-ed", "00000000000003_"]) {
      const t = trees(OLD);
      add(t.head, name);
      const result = run(t);
      expect([name, result.status]).toEqual([name, 1]);
      expect(result.stdout).toContain(`${name}: is new and does not match`);
    }
  });

  it.each(["mfa", "queue", "delivery", "recovery", "phase"])("refuses a new name holding %s", (word) => {
    const t = trees(OLD);
    const name = `00000000000003_add_${word}_table`;
    add(t.head, name);
    const result = run(t);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${name}: is new and holds the word ${word}`);
  });

  it("judges only new names: a parent already holding phase and mfa names passes with a valid new one", () => {
    const t = trees(["00000000000000_init", "00000000000001_phase2_properties", "00000000000002_mfa_foundation"]);
    add(t.head, "00000000000003_rate_limit_counters");
    expect(run(t).status).toBe(0);
  });

  // In byte order "_" (0x5f) comes before "b" (0x62); a collation that ignores "_" would swap these two.
  const locale = { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };
  // Where en_US.UTF-8 is not installed, bash falls back to byte order, and the locale cases would pass even without
  // the script's `export LC_ALL=C`. So they run only where the locale really orders "_ab" first; workflow.test.ts
  // requires that line in the script everywhere.
  const input = "20260101000000_a_z\n20260101000000_ab\n";
  const probe = spawnSync("sort", { input, encoding: "utf8", env: { ...process.env, ...locale } });
  const collates = probe.status === 0 && probe.stdout.startsWith("20260101000000_ab\n");

  function byteOrder(env: NodeJS.ProcessEnv): void {
    it("passes a new name that is later only in byte order", () => {
      const t = trees(["00000000000000_init", "20260101000000_a_z"]);
      add(t.head, "20260101000000_ab");
      expect(run(t, env).status).toBe(0);
    });

    it("refuses a new name that is earlier only in byte order", () => {
      const t = trees(["00000000000000_init", "20260101000000_ab"]);
      add(t.head, "20260101000000_a_z");
      const result = run(t, env);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("20260101000000_a_z: is new but sorts before the parent's last");
    });
  }

  describe("orders names by byte, in the caller's own locale", () => {
    byteOrder({});
  });

  describe.skipIf(!collates)("orders names by byte under en_US.UTF-8 (skipped where it is not installed)", () => {
    byteOrder(locale);
  });
});
