import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the attempt submission's discovery and ending (ADR-0097) may and may
 * not do.
 *
 * 1. **Dormancy.** Nothing in production constructs the repository. The
 *    sender (GS-7c-2b) and the pipeline command (GS-9) are what will.
 * 2. **No paid boundary.** The module and the repository reach no provider,
 *    HTTP client or storage, and schedule nothing.
 * 3. **One write.** The ending moves an orchestrated attempt from `QUEUED` to
 *    `CANCELLED_PRE_SUBMISSION` and writes its event; it writes nothing else
 *    and locks nothing but the attempt.
 * 4. **The declared lock order.** The cost-admission lock first, then the
 *    attempt.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MODULE_DIR = __dirname;
const REPOSITORY = join(REPO_ROOT, "packages", "database", "src", "attempt-submission-repository.ts");

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (entry.name.includes(".test.")) continue;
        found.push({ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) });
      }
    }
  };
  walk(dir);
  return found;
}

function productionSources(): { name: string; text: string }[] {
  return [
    join(REPO_ROOT, "apps", "web", "src"),
    join(REPO_ROOT, "apps", "worker", "src"),
    join(REPO_ROOT, "apps", "ops", "src"),
    join(REPO_ROOT, "packages"),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the repository exists but nothing runs it", () => {
  it("is not constructed in production", () => {
    const callers = productionSources()
      .filter(({ text }) => text.includes("createAttemptSubmissionRepository("))
      .map(({ name }) => name);
    expect(callers).toEqual(["packages/database/src/attempt-submission-repository.ts"]);
  });
});

describe("no paid boundary is reachable", () => {
  it("keeps the module to the preflight's vocabulary and the orchestration ports", () => {
    for (const { name, text } of sourceFiles(MODULE_DIR)) {
      for (const source of imports(text)) {
        expect(`${name}: ${source}`).toMatch(
          new RegExp(
            ": (" +
              [
                "\\./(index|ports|preparation-refusal)",
                "\\.\\./generation/(execution-ports|execution-preflight-errors)",
                "\\.\\./orchestration/ports",
                "@app/shared",
              ].join("|") +
              ")$",
          ),
        );
      }
    }
  });

  it("schedules nothing and calls no provider, network or storage", () => {
    const files = [
      ...sourceFiles(MODULE_DIR),
      { name: REPOSITORY, text: code(readFileSync(REPOSITORY, "utf8")) },
    ];
    for (const { name, text } of files) {
      for (const banned of [
        "fetch(",
        "createGeneration(",
        "createSignedDownloadUrl(",
        "@app/video-providers",
        "@app/storage",
        "setTimeout(",
        "setInterval(",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

describe("one write, after the cost-admission lock", () => {
  const repo = code(readFileSync(REPOSITORY, "utf8"));
  const body = repo.slice(repo.indexOf("async function endWithin("));

  it("moves only a QUEUED attempt, only into CANCELLED_PRE_SUBMISSION", () => {
    expect(body.match(/UPDATE "/g)).toHaveLength(1);
    expect(body).toContain(`UPDATE "scene_generations" a`);
    expect(body).toContain(`SET "orchestrationState" = 'CANCELLED_PRE_SUBMISSION'::"GenerationAttemptState"`);
    expect(body).toContain(`AND a."orchestrationState" = 'QUEUED'::"GenerationAttemptState"`);
    for (const banned of ["INSERT INTO", "DELETE FROM", ".update(", ".updateMany(", ".create(", ".upsert("]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("locks nothing but the attempt it moves", () => {
    for (const banned of ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"]) {
      expect(`${banned}: ${repo.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("takes the cost-admission lock before the compare-and-set, and writes the event after it", () => {
    const order = [
      "await acquireCostAdmissionLock(",
      `UPDATE "scene_generations" a`,
      "await appendGenerationEvent(",
    ].map((marker) => body.indexOf(marker));
    expect(order.every((position) => position > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
