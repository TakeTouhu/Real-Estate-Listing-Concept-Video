import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TransientProviderOutputLocator,
  type ProviderOutputByteSourceOpenResult,
} from "@app/domain";
import {
  FalProviderOutputByteSource,
  parseFalOutputContentLength,
  type FalOutputFetch,
  type FalOutputFetchResponse,
  type FalOutputResponseBody,
} from "./provider-output-byte-source";

/**
 * The fal streaming byte source, driven entirely by an injected fetch seam — no
 * network, no fal, no Internet. The seam's shape is itself part of the proof:
 * it accepts only a URL, so the adapter has no way to attach an `Authorization`
 * header, a `FAL_KEY`, a cookie, a body, or a method other than GET.
 */

const START = "https://fal.media/files/panda/out.mp4?X-Fal-Signature=SECRETSIGNATURE";

function locator(raw = START): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

interface Scripted {
  readonly status: number;
  readonly location?: string | null;
  readonly contentLength?: string | null;
  /** Body chunks; omit for no body (null). */
  readonly chunks?: readonly Uint8Array[];
}

interface Harness {
  readonly fetch: FalOutputFetch;
  readonly requests: string[];
  readonly reads: number[];
  readonly cancels: number[];
}

function harness(script: readonly (Scripted | "throw")[]): Harness {
  const requests: string[] = [];
  const reads: number[] = [];
  const cancels: number[] = [];
  let index = 0;

  const fetch: FalOutputFetch = async ({ url }) => {
    requests.push(url);
    const step = script[index] ?? { status: 500 };
    const idx = index;
    index += 1;
    reads[idx] = 0;
    cancels[idx] = 0;
    if (step === "throw") throw new Error(`network exploded reaching ${url}`);

    let position = 0;
    let cancelled = false;
    const body: FalOutputResponseBody | null =
      step.chunks === undefined
        ? null
        : {
            async read(): Promise<Uint8Array | null> {
              reads[idx] = (reads[idx] ?? 0) + 1;
              if (cancelled || position >= step.chunks!.length) return null;
              const chunk = step.chunks![position];
              position += 1;
              return chunk ?? null;
            },
            async cancel(): Promise<void> {
              cancelled = true;
              cancels[idx] = (cancels[idx] ?? 0) + 1;
            },
          };

    const response: FalOutputFetchResponse = {
      status: step.status,
      location: step.location ?? null,
      contentLength: step.contentLength ?? null,
      body,
    };
    return response;
  };

  return { fetch, requests, reads, cancels };
}

function source(h: Harness): FalProviderOutputByteSource {
  return new FalProviderOutputByteSource({ fetch: h.fetch });
}

async function drain(open: ProviderOutputByteSourceOpenResult): Promise<Uint8Array[]> {
  if (open.kind !== "OPEN") throw new Error(`expected OPEN, got ${open.kind}`);
  const out: Uint8Array[] = [];
  for await (const chunk of open.stream.body) out.push(chunk);
  return out;
}

describe("a successful 200 opens a streaming body", () => {
  it("makes exactly one GET and no second request", async () => {
    const h = harness([{ status: 200, contentLength: "3", chunks: [bytes(1, 2, 3)] }]);
    const open = await source(h).open(locator());
    expect(open.kind).toBe("OPEN");
    expect(h.requests).toEqual([START]);
  });

  it("returns an open result carrying no raw URL or signature", async () => {
    const h = harness([{ status: 200, contentLength: "1", chunks: [bytes(1)] }]);
    const open = await source(h).open(locator());
    expect(open.kind).toBe("OPEN");
    // The raw signed URL stays inside the access callback; the open result holds
    // the response stream, never the location.
    const serialized = JSON.stringify(open);
    expect(serialized).not.toContain("SECRETSIGNATURE");
    expect(serialized).not.toContain("fal.media");
    expect(serialized).not.toContain("X-Fal-Signature");
    if (open.kind === "OPEN") {
      const streamRecord = open.stream as unknown as Record<string, unknown>;
      for (const key of Object.keys(streamRecord)) {
        expect(String(streamRecord[key])).not.toContain("SECRETSIGNATURE");
      }
    }
  });

  it("streams the exact bytes and exposes a valid Content-Length as the declaration", async () => {
    const h = harness([{ status: 200, contentLength: "5", chunks: [bytes(1, 2), bytes(3, 4, 5)] }]);
    const open = await source(h).open(locator());
    if (open.kind !== "OPEN") throw new Error("expected OPEN");
    expect(open.stream.declaredSizeBytes).toBe(5);
    expect(await drain(open)).toEqual([bytes(1, 2), bytes(3, 4, 5)]);
  });

  it("pulls the body lazily: nothing is read until the consumer iterates", async () => {
    const h = harness([{ status: 200, chunks: [bytes(1), bytes(2)] }]);
    const open = await source(h).open(locator());
    if (open.kind !== "OPEN") throw new Error("expected OPEN");
    // Opened, but not yet iterated: the body has not been pulled.
    expect(h.reads[0]).toBe(0);
    const iterator = open.stream.body[Symbol.asyncIterator]();
    await iterator.next();
    expect(h.reads[0]).toBe(1);
    await iterator.next();
    expect(h.reads[0]).toBe(2);
  });

  it("cancels the underlying response when the stream is closed early", async () => {
    const h = harness([{ status: 200, chunks: [bytes(1), bytes(2), bytes(3)] }]);
    const open = await source(h).open(locator());
    if (open.kind !== "OPEN") throw new Error("expected OPEN");
    await open.stream.close();
    expect(h.cancels[0]).toBe(1);
    // Idempotent: a second close does not cancel again.
    await open.stream.close();
    expect(h.cancels[0]).toBe(1);
  });
});

describe("Content-Length is a preflight hint, refused when unusable", () => {
  it.each([
    ["a valid size", "1024", 1024],
    ["absent", null, null],
    ["zero", "0", null],
    ["negative", "-1", null],
    ["fractional", "1.5", null],
    ["non-numeric", "abc", null],
    ["a duplicated ambiguous header", "10, 20", null],
    ["an unsafe integer", String(Number.MAX_SAFE_INTEGER + 1), null],
  ])("reads %s as %o", (_label, header, expected) => {
    expect(parseFalOutputContentLength(header)).toBe(expected);
  });

  it("exposes null declaredSize for a malformed Content-Length on the open", async () => {
    const h = harness([{ status: 200, contentLength: "10, 20", chunks: [bytes(1)] }]);
    const open = await source(h).open(locator());
    if (open.kind !== "OPEN") throw new Error("expected OPEN");
    expect(open.stream.declaredSizeBytes).toBeNull();
  });
});

describe("every failure is retryable, never a provider failure", () => {
  it.each([[403], [404], [410], [429], [500], [503]])(
    "maps HTTP %i to RETRYABLE_FAILURE and releases nothing it did not open",
    async (status) => {
      const h = harness([{ status }]);
      expect(await source(h).open(locator())).toEqual({ kind: "RETRYABLE_FAILURE" });
    },
  );

  it("maps a 200 with no body to RETRYABLE_FAILURE", async () => {
    const h = harness([{ status: 200 }]);
    expect(await source(h).open(locator())).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("maps a fetch rejection to RETRYABLE_FAILURE without reading its text", async () => {
    const h = harness(["throw"]);
    const result = await source(h).open(locator());
    expect(result).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(JSON.stringify(result)).not.toContain("SECRETSIGNATURE");
  });

  it("releases a non-final response body it will not use", async () => {
    const h = harness([{ status: 500, chunks: [bytes(9)] }]);
    await source(h).open(locator());
    expect(h.cancels[0]).toBe(1);
  });
});

describe("redirects are manual, revalidated, and bounded", () => {
  it("follows one authorized same-policy redirect and releases the redirect body first", async () => {
    const target = "https://v3.fal.media/files/moved.mp4";
    const h = harness([
      { status: 302, location: target, chunks: [bytes(0)] },
      { status: 200, chunks: [bytes(7, 8)] },
    ]);
    const open = await source(h).open(locator());
    expect(await drain(open)).toEqual([bytes(7, 8)]);
    expect(h.requests).toEqual([START, target]);
    // The redirect's body was released before the next GET.
    expect(h.cancels[0]).toBe(1);
  });

  it("resolves a relative redirect against the current URL and revalidates it", async () => {
    const h = harness([
      { status: 307, location: "/files/relative.mp4", chunks: [] },
      { status: 200, chunks: [bytes(5)] },
    ]);
    const open = await source(h).open(locator());
    expect(open.kind).toBe("OPEN");
    expect(h.requests).toEqual([START, "https://fal.media/files/relative.mp4"]);
  });

  it("refuses a redirect to a non-fal host before making the second request", async () => {
    const h = harness([{ status: 302, location: "https://evil.example/files/x", chunks: [] }]);
    const result = await source(h).open(locator());
    expect(result).toEqual({ kind: "RETRYABLE_FAILURE" });
    // Only the initial request was made; the out-of-policy target was never dialed.
    expect(h.requests).toEqual([START]);
  });

  it.each([
    ["a missing Location", { status: 302, location: null, chunks: [] as Uint8Array[] }],
    ["a same-family loopback trick", { status: 302, location: "https://127.0.0.1/files/x", chunks: [] as Uint8Array[] }],
    ["a scheme downgrade", { status: 302, location: "http://fal.media/files/x", chunks: [] as Uint8Array[] }],
  ])("refuses %s as RETRYABLE_FAILURE", async (_label, step) => {
    const h = harness([step]);
    expect(await source(h).open(locator())).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(h.requests).toEqual([START]);
  });

  it("stops at the three-redirect budget rather than following a fourth", async () => {
    const u = (n: number): string => `https://fal.media/files/hop${n}.mp4`;
    const h = harness([
      { status: 302, location: u(1), chunks: [] },
      { status: 302, location: u(2), chunks: [] },
      { status: 302, location: u(3), chunks: [] },
      { status: 302, location: u(4), chunks: [] },
    ]);
    const result = await source(h).open(locator());
    expect(result).toEqual({ kind: "RETRYABLE_FAILURE" });
    // Initial + three follows = four requests; the fourth redirect is refused.
    expect(h.requests).toEqual([START, u(1), u(2), u(3)]);
  });
});

describe("the adapter never materializes the body or carries a credential", () => {
  // Comments stripped: the doc comments describe these prohibitions in prose,
  // and prose naming a method is not the code calling it.
  const src = readFileSync(join(__dirname, "provider-output-byte-source.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("never calls text(), json() or arrayBuffer()", () => {
    for (const banned of [".text(", ".json(", ".arrayBuffer(", "Buffer.concat", "Buffer.from"]) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("attaches no Authorization, bearer token, key or cookie to a request", () => {
    // Note the default seam sets `credentials: "omit"`, which is the *absence*
    // of credentials — so "credential" is not a banned token here.
    for (const banned of ["Authorization", "Bearer", "FAL_KEY", "Cookie", "apiKey", "x-api-key"]) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The one appearance of "credentials" is the omit directive.
    expect(src.includes('credentials: "omit"')).toBe(true);
  });

  it("issues GET only and never a HEAD or a retry loop", () => {
    expect(src.includes('method: "HEAD"')).toBe(false);
    expect(src.includes("HEAD")).toBe(false);
    // The default seam names GET explicitly; the adapter otherwise has no method.
    expect(src.includes('method: "GET"')).toBe(true);
  });
});
