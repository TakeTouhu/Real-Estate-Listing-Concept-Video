import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as domainRoot from "@app/domain";
import { TransientProviderOutputLocator } from "@app/domain";
import { withTransientProviderOutputLocatorForByteSource } from "@app/domain/provider-output-byte-source-access";

/**
 * The one controlled door to a locator's raw value, and the guard rail that
 * keeps it the only one.
 *
 * The capability itself is deliberately awkward: the raw location is handed to a
 * callback and never returned, so it exists only for the length of one open.
 * Everything else here proves the awkwardness cannot be routed around — the
 * package root exposes no reader, the instance stays redacted, and in production
 * only the authorized fal adapter is allowed to import the subpath.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const RAW = "https://v3.fal.media/files/panda/out.mp4?X-Fal-Signature=SECRETSIGNATURE";

function locator(raw = RAW): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

describe("the byte-source access capability", () => {
  it("invokes the callback with the exact raw location, unmodified", async () => {
    // What is enforceable and true: the authorized adapter receives the exact
    // string the locator was built from, so a signed URL keeps its signature.
    // This test deliberately makes no claim that the string cannot escape the
    // callback — a trusted callback is ordinary code, and JavaScript cannot
    // confine a value it has intentionally been handed.
    let observed: string | null = null;
    await withTransientProviderOutputLocatorForByteSource(locator(), async (raw) => {
      observed = raw;
    });
    expect(observed).toBe(RAW);
  });

  it("returns void: the capability is not itself a raw-return channel", async () => {
    // The enforceable guarantee: the capability's own result cannot carry the
    // raw string out. It returns `Promise<void>`, so awaiting it yields nothing.
    const returned = await withTransientProviderOutputLocatorForByteSource(
      locator(),
      async () => undefined,
    );
    expect(returned).toBeUndefined();
  });

  it("rejects a direct-extraction callback at compile time", () => {
    // The regression that fails if the arbitrary-result channel is restored:
    // a callback that returns the raw string is a type error against the
    // `Promise<void>` contract. If the capability were changed back to a generic
    // `<T>` result channel, this `@ts-expect-error` would become unused and the
    // typecheck would fail.
    const attempt = (): Promise<void> =>
      withTransientProviderOutputLocatorForByteSource(
        locator(),
        // @ts-expect-error the callback must return Promise<void>; the raw string cannot be returned out.
        async (raw) => raw,
      );
    // Not invoked — this test's assertion is the compile-time check above.
    expect(typeof attempt).toBe("function");
  });

  it("propagates a callback rejection without exposing the raw value", async () => {
    await expect(
      withTransientProviderOutputLocatorForByteSource(locator(), async () => {
        throw new Error("open failed");
      }),
    ).rejects.toThrow("open failed");
  });
});

describe("the @app/domain root exposes no raw read-back", () => {
  it("does not export the byte-source access capability", () => {
    expect("withTransientProviderOutputLocatorForByteSource" in domainRoot).toBe(false);
  });

  it("exports the locator class and its redaction constant, but no raw reader", () => {
    expect(typeof (domainRoot as Record<string, unknown>).TransientProviderOutputLocator).toBe(
      "function",
    );
    for (const banned of [
      "readTransientLocatorRawForByteSource",
      "rawLocation",
      "unwrapLocator",
      "readLocatorRaw",
    ]) {
      expect(`${banned} in root: ${banned in domainRoot}`).toBe(`${banned} in root: false`);
    }
  });
});

describe("the locator instance stays redacted", () => {
  it("has no enumerable raw property and redacts every stringification", () => {
    const loc = locator();
    expect(Object.keys(loc)).toEqual([]);
    // Spread copies only enumerable own properties; the raw is a `#` field, so a
    // spread carries nothing of it.
    const spread = { ...loc } as Record<string, unknown>;
    expect(Object.keys(spread)).toEqual([]);
    const rendered = `${String(loc)} ${JSON.stringify(loc)} ${JSON.stringify(spread)} ${JSON.stringify({ loc })}`;
    expect(rendered).not.toContain("SECRETSIGNATURE");
    expect(String(loc)).toBe("[redacted provider output locator]");
  });
});

describe("in production only the authorized fal adapter imports the access subpath", () => {
  const SUBPATH = "@app/domain/provider-output-byte-source-access";
  const AUTHORIZED = join(
    "packages",
    "video-providers",
    "src",
    "fal",
    "provider-output-byte-source.ts",
  );

  // Strip comments so a doc-comment that names the subpath in prose is not
  // mistaken for an import of it.
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const importsSubpath = (text: string): boolean => code(text).includes(`"${SUBPATH}"`);

  function productionFiles(): { name: string; text: string }[] {
    const roots = [
      join(REPO_ROOT, "apps", "web", "src"),
      join(REPO_ROOT, "apps", "worker", "src"),
      join(REPO_ROOT, "packages", "database", "src"),
      join(REPO_ROOT, "packages", "storage", "src"),
      join(REPO_ROOT, "packages", "video-providers", "src"),
      join(REPO_ROOT, "packages", "domain", "src"),
      join(REPO_ROOT, "packages", "ai-providers", "src"),
      join(REPO_ROOT, "packages", "queue", "src"),
      join(REPO_ROOT, "packages", "observability", "src"),
    ].filter((dir) => existsSync(dir));

    const found: { name: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "testing") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          if (entry.name.includes(".test.")) continue;
          if (entry.name.includes(".spec.")) continue;
          found.push({ name: full.slice(REPO_ROOT.length + 1), text: readFileSync(full, "utf8") });
        }
      }
    };
    for (const root of roots) walk(root);
    return found;
  }

  it("is imported by exactly the authorized adapter, and by nothing else", () => {
    const importers = productionFiles()
      .filter(({ text }) => importsSubpath(text))
      .map(({ name }) => name);
    // The defining module re-exports from a relative path, so it never names the
    // subpath; only the authorized adapter imports the capability by subpath.
    expect(importers).toEqual([AUTHORIZED]);
  });

  it("is imported by neither submission, polling, factory nor composition code", () => {
    const forbidden = [
      "packages/video-providers/src/fal/h3-max-provider.ts",
      "packages/video-providers/src/fal/queue-status-source.ts",
      "packages/video-providers/src/factory.ts",
      "packages/domain/src/provider-output/runner.ts",
    ];
    const byName = new Map(productionFiles().map(({ name, text }) => [name, text]));
    for (const name of forbidden) {
      const text = byName.get(name);
      if (text === undefined) continue;
      expect(`${name} imports access: ${importsSubpath(text)}`).toBe(`${name} imports access: false`);
    }
  });
});
