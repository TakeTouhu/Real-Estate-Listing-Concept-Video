import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The claims that are only worth anything if nobody can quietly undo them.
 *
 * The streaming core is concrete: it really hashes, stages and publishes. What
 * keeps it dormant, as of Phase 4C-3B-2H-3B-3, is narrower still: the *complete*
 * real data-plane pieces now exist — a concrete fal `ProviderOutputByteSource`,
 * the transfer core, and a concrete durable `S3ManagedOutputStagingSink`. The
 * claim is therefore no longer "no durable sink exists" but "every piece exists
 * yet no production code joins or executes them." So the assertions below prove:
 * nothing in production constructs the fal byte source, the transfer core, the S3
 * sink or an `S3Client`; there is exactly one production implementer of each
 * port; no storage credential is in the environment schema; the runner has no
 * production caller; and the dependency direction and streaming shortcuts are
 * unchanged. The AWS SDK is used only by the dormant client adapter.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CORE_DIR = __dirname;
const CORE_FILES = ["streaming-transfer.ts", "staging.ts", "defect.ts", "index.ts"];

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function coreSource(name: string): string {
  return code(readFileSync(join(CORE_DIR, name), "utf8"));
}

function sourceFiles(dir: string): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // `testing/` holds deterministic fakes for suites; it is not production.
        if (entry.name === "testing") continue;
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

/** Every production source that could plausibly compose the core. */
function productionSources(): { name: string; text: string }[] {
  return [
    join(REPO_ROOT, "apps", "web", "src"),
    join(REPO_ROOT, "apps", "worker", "src"),
    join(REPO_ROOT, "packages", "database", "src"),
    join(REPO_ROOT, "packages", "video-providers", "src"),
    join(REPO_ROOT, "packages", "storage", "src"),
    join(REPO_ROOT, "packages", "domain", "src"),
  ]
    .filter((dir) => existsSync(dir))
    .flatMap(sourceFiles);
}

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("dependency direction", () => {
  it("keeps the domain's provider-output module free of @app/storage", () => {
    const dir = join(REPO_ROOT, "packages", "domain", "src", "provider-output");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
      const specifiers = imports(code(readFileSync(join(dir, name), "utf8")));
      for (const specifier of specifiers) {
        const internal = specifier.startsWith(".") || specifier === "@app/shared";
        expect(`${name} imports ${specifier}: ${internal}`).toBe(`${name} imports ${specifier}: true`);
      }
    }
  });

  it("keeps @app/storage out of the domain package's dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "domain", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@app/storage");
  });

  it("keeps the streaming core free of providers, the database and Prisma", () => {
    for (const name of CORE_FILES) {
      const text = coreSource(name);
      for (const banned of [
        "@app/video-providers",
        "@app/database",
        "@prisma/client",
        "@prisma",
        "prisma",
        "Prisma",
        "FalQueue",
        "FalH3Max",
        "fal.media",
        "queue.fal.run",
        "WaveSpeed",
        "wavespeed",
        "Veo",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
      for (const specifier of imports(text)) {
        const allowed =
          specifier.startsWith(".") ||
          specifier === "@app/shared" ||
          specifier === "@app/domain" ||
          specifier === "node:crypto";
        expect(`${name} imports ${specifier}: ${allowed}`).toBe(`${name} imports ${specifier}: true`);
      }
    }
  });
});

describe("the core has no transport, no store and no environment of its own", () => {
  it("references no object store, HTTP client, fetch or process.env", () => {
    for (const name of CORE_FILES) {
      const text = coreSource(name);
      for (const banned of [
        "LocalObjectStorage",
        "FetchHttpClient",
        "HttpClient",
        "fetch(",
        "globalThis.fetch",
        "process.env",
        "@aws-sdk",
        "S3Client",
        "@azure/storage-blob",
        "@google-cloud/storage",
        "node:fs",
        "node:http",
        "node:https",
        "undici",
        "axios",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("never reads the locator", () => {
    const text = coreSource("streaming-transfer.ts");
    // The locator is passed to the source by property name and nothing else
    // happens to it. There is no accessor to call, and the core does not try.
    for (const banned of [".raw", ".value", ".url", "unwrap", "unsafeRaw", "toString()"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("adds no scheduler, timer or retry loop", () => {
    const text = coreSource("streaming-transfer.ts");
    for (const banned of ["setInterval", "setTimeout", "node-cron", "while (", "retry", "backoff"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    // Exactly one loop: the `for await` over the body. Any second loop is
    // worth a look.
    expect((text.match(/\bfor\b/g) ?? []).length).toBe(1);
    expect(text.includes("for await")).toBe(true);
  });
});

describe("no full-body buffering", () => {
  it("uses none of the shortcuts that would read the whole output into memory", () => {
    const text = coreSource("streaming-transfer.ts");
    // The behavioural backpressure test is the primary proof. This is the
    // source-level guard for the obvious ways of defeating it, kept to tokens
    // rather than formatting so it does not overfit.
    for (const banned of [
      "Buffer.concat",
      "arrayBuffer(",
      ".text(",
      ".push(",
      "Array.from(",
      "[...",
      "new Uint8Array(total",
      "chunks: Uint8Array[]",
      "collected",
    ]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("hashes incrementally with Node's streaming API", () => {
    const text = coreSource("streaming-transfer.ts");
    expect(text.includes('createHash("sha256")')).toBe(true);
    expect(text.includes("hash.update(chunk)")).toBe(true);
    // One digest call, after the loop, never per chunk.
    expect(text.match(/\.digest\(/g)?.length).toBe(1);
  });
});

describe("no production composition", () => {
  it("constructs the streaming core nowhere in production", () => {
    for (const { name, text } of productionSources()) {
      if (name.endsWith("managed-output/streaming-transfer.ts")) continue;
      if (name.endsWith("managed-output/index.ts")) continue;
      if (name.endsWith("packages/storage/src/index.ts")) continue;
      for (const banned of ["new StreamingManagedOutputTransfer", "StreamingManagedOutputTransfer("]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has exactly one production byte source (fal) and exactly one durable staging sink (S3)", () => {
    // The dormancy truth changed in Phase 4C-3B-2H-3B-3: a concrete durable
    // `ManagedOutputStagingSink` now exists too. Exactly one production file may
    // implement each port — the authorized fal adapter for the byte source and
    // the S3 sink for the staging sink — and nothing else, so a second concrete
    // implementation of either gets the review it needs.
    const AUTHORIZED_BYTE_SOURCE = "packages/video-providers/src/fal/provider-output-byte-source.ts";
    const AUTHORIZED_SINK = "packages/storage/src/managed-output/s3-staging-sink.ts";
    const byteSourceImplementers: string[] = [];
    const sinkImplementers: string[] = [];
    for (const { name, text } of productionSources()) {
      if (text.includes("implements ProviderOutputByteSource")) byteSourceImplementers.push(name);
      if (text.includes("implements ManagedOutputStagingSink")) sinkImplementers.push(name);
    }
    expect(byteSourceImplementers).toEqual([AUTHORIZED_BYTE_SOURCE]);
    expect(sinkImplementers).toEqual([AUTHORIZED_SINK]);
  });

  it("constructs the S3 sink and an S3Client nowhere in production", () => {
    // The sink is concrete but unconstructed, and no production code builds a
    // real `S3Client` or maps one onto the sink's seam. A future wiring PR that
    // does gets the review it needs.
    const AUTHORIZED_SINK = "packages/storage/src/managed-output/s3-staging-sink.ts";
    const CLIENT_ADAPTER = "packages/storage/src/managed-output/s3-client-adapter.ts";
    for (const { name, text } of productionSources()) {
      if (name.endsWith("managed-output/index.ts")) continue;
      if (name.endsWith("packages/storage/src/index.ts")) continue;
      if (!name.endsWith(AUTHORIZED_SINK)) {
        for (const banned of ["new S3ManagedOutputStagingSink", "S3ManagedOutputStagingSink("]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
      for (const banned of ["new S3Client", "new S3Client("]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
      // Only the dormant client adapter may reference the AWS SDK at all.
      if (!name.endsWith(CLIENT_ADAPTER)) {
        expect(`${name}: @aws-sdk: ${text.includes("@aws-sdk")}`).toBe(`${name}: @aws-sdk: false`);
      }
    }
  });

  it("constructs the media validator and its ffprobe inspector nowhere in production", () => {
    // Phase 2H-3B-4 adds two more concrete pieces — a managed-output media
    // validator and an `ffprobe`-backed inspector. Both exist; neither is built,
    // and no production code launches a subprocess to inspect managed output.
    const VALIDATOR = "packages/storage/src/managed-output/media-validation.ts";
    const PROBE = "packages/storage/src/managed-output/ffprobe.ts";
    for (const { name, text } of productionSources()) {
      if (name.endsWith("managed-output/index.ts")) continue;
      if (name.endsWith("packages/storage/src/index.ts")) continue;
      if (!name.endsWith(VALIDATOR)) {
        for (const banned of ["new S3ManagedOutputMediaValidator", "S3ManagedOutputMediaValidator("]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
      if (!name.endsWith(PROBE)) {
        for (const banned of ["new FfprobeMediaProbe", "FfprobeMediaProbe(", "createDefaultProcessRunner("]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
        // Only the dormant inspector may reference a child process at all.
        for (const banned of ["node:child_process", "execFile", "spawn(", "ffprobe"]) {
          expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
        }
      }
    }
  });

  it("never invokes the media inspector through a shell", () => {
    // The one process invocation in the repository is `execFile` with the shell
    // disabled and a fixed argument vector. No command string is ever built.
    const probe = code(readFileSync(join(CORE_DIR, "ffprobe.ts"), "utf8"));
    for (const banned of ["shell: true", "execSync", "spawnSync", "/bin/sh", "exec("]) {
      expect(`${banned}: ${probe.includes(banned)}`).toBe(`${banned}: false`);
    }
    expect(probe.includes("shell: false")).toBe(true);
    expect(probe.includes("execFile(")).toBe(true);
  });

  it("constructs the fal byte source nowhere in production", () => {
    // Concrete but unconstructed: the adapter exists, and no production code
    // builds one. A future wiring PR that does gets the review it needs.
    const AUTHORIZED_BYTE_SOURCE = "packages/video-providers/src/fal/provider-output-byte-source.ts";
    for (const { name, text } of productionSources()) {
      if (name.endsWith(AUTHORIZED_BYTE_SOURCE)) continue;
      if (name.endsWith("packages/video-providers/src/index.ts")) continue;
      for (const banned of ["new FalProviderOutputByteSource", "FalProviderOutputByteSource("]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("leaves the Phase 2H-2 runner without a production caller", () => {
    for (const { name, text } of productionSources()) {
      if (name.startsWith("packages/domain/src/provider-output/")) continue;
      for (const banned of [
        "createProviderOutputRunner",
        "runProviderOutputAttemptOnce",
        "runProviderOutputBatchOnce",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("adds no storage credential to the environment schema", () => {
    const env = readFileSync(join(REPO_ROOT, "packages", "shared", "src", "env.ts"), "utf8");
    for (const banned of [
      "FAL_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "AZURE_STORAGE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GCS_",
      "S3_BUCKET",
    ]) {
      expect(`${banned}: ${env.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("does not export the fakes from the package root", () => {
    const root = coreSource("../index.ts");
    for (const banned of ["FakeManagedOutputStagingSink", "FakeProviderOutputByteSource", "./testing"]) {
      expect(`${banned}: ${root.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("the locator still cannot be read", () => {
  it("has no raw accessor, in any spelling", () => {
    const text = code(
      readFileSync(
        join(REPO_ROOT, "packages", "domain", "src", "provider-output", "locator.ts"),
        "utf8",
      ),
    );
    for (const banned of ["get raw", "get value", "get url", "unwrap", "unsafeRaw", "reveal", "expose"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    // `#raw` is written once and read once, in `equals`. A third occurrence is
    // a new reader and needs review.
    expect(text.match(/this\.#raw/g)?.length).toBe(2);
    expect(text.includes("other.#raw")).toBe(true);
  });
});

describe("nothing about the existing adapters changed shape", () => {
  it("leaves the provider HttpClient a string-bodied control-plane client", () => {
    const text = code(
      readFileSync(join(REPO_ROOT, "packages", "video-providers", "src", "http.ts"), "utf8"),
    );
    expect(text.includes("readonly body: string;")).toBe(true);
    for (const banned of ["ReadableStream", "AsyncIterable", "stream", "Uint8Array"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("leaves LocalObjectStorage a whole-object in-memory adapter", () => {
    const text = code(
      readFileSync(join(REPO_ROOT, "packages", "storage", "src", "local-storage.ts"), "utf8"),
    );
    expect(text.includes("putObject(key: string, data: Uint8Array)")).toBe(true);
    for (const banned of ["ManagedOutputStagingSink", "begin(", "commit(", "AsyncIterable"]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("adds no migration and no schema column", () => {
    const migrations = join(REPO_ROOT, "packages", "database", "prisma", "migrations");
    const dirs = readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs.at(-1)).toBe("00000000000011_phase4c3b2h1_managed_output_integrity");

    const schema = readFileSync(
      join(REPO_ROOT, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    for (const banned of [
      "stagingKey",
      "transferLease",
      "transferOwner",
      "transferRetryCount",
      "transferStartedAt",
      "outputMime",
      "outputContentType",
      "providerOutputUrl",
      "temporaryUrl",
    ]) {
      expect(`${banned}: ${schema.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
