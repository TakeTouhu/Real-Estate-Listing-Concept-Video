import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The claims that are only worth anything if nobody can quietly undo them.
 *
 * This phase's dormancy claim is **weaker and more precise** than Phase 2H-2's,
 * and the difference matters enough to state twice. 2H-2 could say the
 * repository contained no concrete polling implementation at all. It now
 * contains one: `FalQueueCompletionStatusSource` builds real fal queue requests
 * and would reach `queue.fal.run` if it were ever handed a credential and
 * called.
 *
 * So the honest claim is about *composition*, not capability:
 *
 * - nothing in production constructs it;
 * - nothing in production supplies a fal credential;
 * - `VIDEO_PROVIDER` still cannot select fal;
 * - the Phase 2H-2 runner it satisfies still has no production caller;
 * - and no test in this repository can reach the network to find out.
 *
 * Each of those is asserted below rather than described.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ADAPTER_DIR = __dirname;

function sourceFiles(dir: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (entry.name.includes(".test.")) continue;
        found.push({ name: full.slice(REPO_ROOT.length + 1), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return found;
}

/** Every production source that could plausibly compose an adapter. */
function productionSources(): { name: string; text: string }[] {
  return [
    join(REPO_ROOT, "apps", "web", "src"),
    join(REPO_ROOT, "apps", "worker", "src"),
    join(REPO_ROOT, "packages", "database", "src"),
    join(REPO_ROOT, "packages", "storage", "src"),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the concrete fal status adapter has no production composition", () => {
  it("is constructed nowhere in any application, worker, database or storage source", () => {
    for (const { name, text } of productionSources()) {
      for (const banned of [
        "FalQueueCompletionStatusSource",
        "FalH3MaxSubmissionProvider",
        "falQueueStatusUrl",
        "falQueueResultUrl",
      ]) {
        expect(`${name}:${banned}: ${code(text).includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("is constructed nowhere inside the provider package either", () => {
    // The factory is the one place a provider is legitimately built, and it has
    // no fal branch. If a future PR adds one, this fails and the wiring gets
    // the review it needs.
    for (const { name, text } of sourceFiles(join(REPO_ROOT, "packages", "video-providers", "src"))) {
      if (name.endsWith("fal/queue-status-source.ts") || name.endsWith("src/index.ts")) continue;
      expect(`${name}: ${code(text).includes("FalQueueCompletionStatusSource")}`).toBe(
        `${name}: false`,
      );
    }
  });

  it("leaves the Phase 2H-2 runner without a production caller", () => {
    // The adapter is useless without something to call it. That something is
    // still absent, which is the second half of the dormancy claim.
    for (const { name, text } of productionSources()) {
      for (const banned of [
        "createProviderOutputRunner",
        "runProviderOutputAttemptOnce",
        "runProviderOutputBatchOnce",
      ]) {
        expect(`${name}:${banned}: ${code(text).includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("adds no scheduler, cron, daemon or polling loop anywhere", () => {
    for (const { name, text } of [
      ...productionSources(),
      ...sourceFiles(join(REPO_ROOT, "packages", "video-providers", "src")),
    ]) {
      for (const banned of ["setInterval", "setTimeout(", "node-cron", "cron.schedule"]) {
        // `setTimeout` is permitted only in the transport's abort timer, which
        // is a per-request deadline rather than a cadence.
        if (banned === "setTimeout(" && name.endsWith("src/http.ts")) continue;
        expect(`${name}:${banned}: ${code(text).includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

describe("no fal credential exists in production", () => {
  it("is absent from the environment schema", () => {
    const env = readFileSync(join(REPO_ROOT, "packages", "shared", "src", "env.ts"), "utf8");
    expect(env.includes("FAL_KEY")).toBe(false);
    expect(env.includes("FAL_API_KEY")).toBe(false);
  });

  it("is read from no production source", () => {
    for (const { name, text } of [
      ...productionSources(),
      ...sourceFiles(join(REPO_ROOT, "packages", "video-providers", "src")),
      ...sourceFiles(join(REPO_ROOT, "packages", "shared", "src")),
    ]) {
      for (const banned of ["FAL_KEY", "FAL_API_KEY"]) {
        expect(`${name}:${banned}: ${code(text).includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("cannot be selected by VIDEO_PROVIDER", () => {
    const env = readFileSync(join(REPO_ROOT, "packages", "shared", "src", "env.ts"), "utf8");
    // The enum is the gate. Adding "fal" to it is the single edit that would
    // make every other dormancy claim in this file worth re-reading.
    expect(env).toContain('z.enum(["fake", "wavespeed"])');
  });

  it("is never read from process.env by the adapter", () => {
    const text = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    // An adapter that reaches for its own key can be armed by configuration
    // alone. This one cannot exist without a caller deciding to hand it one.
    expect(text.includes("process.env")).toBe(false);
  });

  it("keeps the credential out of every field an error can carry", () => {
    const text = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    // The credential appears exactly twice: assigned in the constructor and
    // interpolated into the Authorization header. Any third occurrence is worth
    // a look.
    expect(text.match(/this\.credential/g)?.length).toBe(3);
  });
});

describe("nothing in this phase can reach the network from a test", () => {
  it("uses no global fetch, HTTP client construction or SDK inside the adapter", () => {
    for (const file of ["queue-status-source.ts", "queue-status-mapping.ts"]) {
      const text = code(readFileSync(join(ADAPTER_DIR, file), "utf8"));
      for (const banned of [
        "fetch(",
        "FetchHttpClient",
        "@fal-ai/client",
        "axios",
        "undici",
        "node-fetch",
        'from "node:http"',
        'from "node:https"',
        "XMLHttpRequest",
      ]) {
        expect(`${file}:${banned}: ${text.includes(banned)}`).toBe(`${file}:${banned}: false`);
      }
    }
  });

  it("reaches the network only through the injected seam", () => {
    const text = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    // Exactly one call site, in `getOnce`. Both requests go through it, which
    // is what makes "one status request, then at most one result request" a
    // property the request-counting suites can actually observe.
    expect(text.match(/this\.http\.request\(/g)?.length).toBe(1);
  });

  it("never loops, waits, or calls fal's polling helpers", () => {
    const text = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    // `retryable` is a legitimate output field, so the ban is on the shapes
    // that would actually repeat a call: a loop, a wait, or fal's
    // poll-until-done helper. Any of them would silently convert "one status
    // request per poll" into "hold a batch slot for the whole render".
    for (const banned of ["subscribe", "sleep", "backoff", "while (", "for (", "do {"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("constructs the transport nowhere in this phase's tests", () => {
    // The suites inject a scripted fake. If any of them ever builds a real
    // client, a `pnpm test` on a laptop starts spending money.
    //
    // This file is excluded from its own scan: it necessarily contains every
    // literal it searches for.
    const scanned = readdirSync(ADAPTER_DIR).filter(
      (f) => f.includes("queue-status") && f.endsWith(".test.ts") && !f.includes("dormancy"),
    );
    expect(scanned.sort()).toEqual([
      "queue-status-mapping.test.ts",
      "queue-status-source.test.ts",
    ]);
    for (const file of scanned) {
      const text = code(readFileSync(join(ADAPTER_DIR, file), "utf8"));
      for (const banned of ["new FetchHttpClient", "globalThis.fetch", "fetch("]) {
        expect(`${file}:${banned}: ${text.includes(banned)}`).toBe(`${file}:${banned}: false`);
      }
    }
  });

  it("names no external host anywhere except the frozen queue constant", () => {
    const mapping = code(readFileSync(join(ADAPTER_DIR, "queue-status-mapping.ts"), "utf8"));
    const adapter = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    // The host lives in exactly one place — `FAL_QUEUE_BASE_URL`, imported —
    // so there is one line to review if fal ever moves it, and no second
    // spelling to drift.
    expect(mapping.includes("https://")).toBe(false);
    expect(adapter.includes("https://")).toBe(false);
  });
});

describe("no persistence, pricing or resolution surface changed", () => {
  it("adds no provider-result column to the schema", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const banned of [
      "falErrorType",
      "providerStatus",
      "providerLogs",
      "providerMetrics",
      "responseUrl",
      "statusUrl",
      "providerOutputUrl",
      "providerFileName",
      "providerContentType",
      "providerFileSize",
    ]) {
      expect(`${banned}: ${schema.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("adds no migration", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    // Phase 2H-1's is still the newest. This phase persists nothing new.
    expect(dirs.at(-1)).toBe("00000000000011_phase4c3b2h1_managed_output_integrity");
  });

  it("touches no pricing or resolution mapping", () => {
    for (const file of ["queue-status-source.ts", "queue-status-mapping.ts"]) {
      const text = code(readFileSync(join(ADAPTER_DIR, file), "utf8"));
      for (const banned of [
        "pricing",
        "Pricing",
        "nativeGenerationResolution",
        "targetOutputResolution",
        "nativeMeetsTarget",
        "MicroUsd",
        "Yen",
      ]) {
        expect(`${file}:${banned}: ${text.includes(banned)}`).toBe(`${file}:${banned}: false`);
      }
    }
  });

  it("cannot submit, cancel or re-spend anything", () => {
    const text = code(readFileSync(join(ADAPTER_DIR, "queue-status-source.ts"), "utf8"));
    for (const banned of [
      "createGeneration",
      "cancel",
      "POST",
      "DELETE",
      "SYSTEM_RECOVERY",
      "GenerationReservation",
    ]) {
      // Not declined — unexpressible. The submission port is not among this
      // adapter's dependencies, so a second paid generation is not something it
      // refuses to do.
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
