/**
 * The real AWS adapter's read path, driven by AWS-SDK-shaped outcomes.
 *
 * ## Why this suite exists
 *
 * Every other suite in this package drives a *fake* object store, and the fake
 * modelled a missing key as `{ contentLength: null, body: null }`. Real AWS does
 * not: `GetObject` on a missing key **rejects**. So the fake made the deliverable
 * probe look correct while the real adapter could never produce absence at all —
 * a fresh canonical key would have rejected, deferred, and never started the
 * composition it was supposed to permit.
 *
 * The seam's contract is therefore asserted here against SDK shapes rather than
 * against the fake: `body: null` means *the store proved this key is empty*, and
 * nothing else may produce it.
 *
 * No `S3Client` is constructed and no network is reachable. `client.send` is a
 * stub returning or throwing exactly what the SDK would.
 */

import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { AppError } from "@app/shared";
import { createS3MultipartClient } from "./s3-client-adapter";

const BUCKET = "managed-output-bucket";
const KEY = "org/org_1/deliverables/gdv_1/output";

/** A stub `S3Client` whose `send` resolves or rejects with what it is given. */
function clientThat(behaviour: { resolve?: unknown; reject?: unknown }): S3Client {
  return {
    async send(): Promise<unknown> {
      if ("reject" in behaviour) throw behaviour.reject;
      return behaviour.resolve;
    },
  } as unknown as S3Client;
}

function read(client: S3Client) {
  return createS3MultipartClient(client).getObject({
    bucket: BUCKET,
    key: KEY,
    expectedBucketOwner: undefined,
  });
}

/** An AWS SDK service error, as the SDK actually shapes one. */
function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(`${name}: service says so`), {
    name,
    $fault: "client",
    $metadata: { httpStatusCode, requestId: "REQ-SECRET-1234", attempts: 1 },
  });
}

/** A body the SDK would hand back: streamable, never buffered whole. */
function sdkBody(chunks: readonly Uint8Array[]): unknown {
  return {
    transformToWebStream(): ReadableStream<Uint8Array> {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index];
          index += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------

describe("a missing key is normalized into the seam's absence shape", () => {
  it("maps NoSuchKey to body:null, the one meaning of absence", async () => {
    const result = await read(clientThat({ reject: awsError("NoSuchKey", 404) }));
    expect(result).toEqual({ contentLength: null, body: null });
  });

  it("does not need a status code to reach that conclusion", async () => {
    // Some SDK paths omit `$metadata`; the name alone is the contract.
    const bare = Object.assign(new Error("gone"), { name: "NoSuchKey" });
    await expect(read(clientThat({ reject: bare }))).resolves.toEqual({
      contentLength: null,
      body: null,
    });
  });
});

describe("nothing else is ever read as absence", () => {
  it("rethrows AccessDenied, which proves nothing about the key", async () => {
    // Without `s3:ListBucket`, AWS answers 403 for a *missing* key too. The
    // application cannot tell those apart, so it must not claim absence.
    await expect(read(clientThat({ reject: awsError("AccessDenied", 403) }))).rejects.toThrow();
  });

  it("rethrows NoSuchBucket even though it is also a 404", async () => {
    // Reading "404" as "the key is empty" would let a deleted or misconfigured
    // bucket look like a deliverable nobody has composed yet.
    await expect(read(clientThat({ reject: awsError("NoSuchBucket", 404) }))).rejects.toThrow();
  });

  it("rethrows throttling, timeouts and 5xx", async () => {
    for (const [name, status] of [
      ["SlowDown", 503],
      ["RequestTimeout", 400],
      ["InternalError", 500],
      ["ServiceUnavailable", 503],
    ] as const) {
      await expect(read(clientThat({ reject: awsError(name, status) }))).rejects.toThrow();
    }
  });

  it("rethrows an ordinary network error and a non-object rejection", async () => {
    await expect(
      read(clientThat({ reject: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) })),
    ).rejects.toThrow();
    await expect(read(clientThat({ reject: "a thrown string" }))).rejects.toBeDefined();
  });

  it("treats an error whose name cannot be read as a failure, not absence", async () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("nope");
      },
    });
    await expect(read(clientThat({ reject: hostile }))).rejects.toBeDefined();
  });

  it("refuses a successful response that carries no body", async () => {
    // The dangerous case, and the reason this is not `body: null`: the request
    // *succeeded*, so nothing about it establishes that the key is empty.
    const outcome = await read(clientThat({ resolve: { ContentLength: 10 } })).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(AppError);
    expect((outcome as AppError).code).toBe("INTERNAL_ERROR");
  });

  it("carries no SDK text, bucket, key or request id in that refusal", async () => {
    const error = await read(clientThat({ resolve: {} })).catch((e: unknown) => e);
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    for (const leak of [BUCKET, KEY, "REQ-SECRET", "org/", "gdv_1"]) {
      expect(`${leak}: ${text.includes(leak)}`).toBe(`${leak}: false`);
    }
  });
});

describe("a real body still streams exactly as before", () => {
  it("reads chunk by chunk and reports EOF once", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const result = await read(
      clientThat({ resolve: { ContentLength: 5, Body: sdkBody(chunks) } }),
    );
    expect(result.contentLength).toBe(5);
    expect(result.body).not.toBeNull();
    const body = result.body!;
    expect(await body.read()).toEqual(chunks[0]);
    expect(await body.read()).toEqual(chunks[1]);
    expect(await body.read()).toBeNull();
    await body.cancel();
  });

  it("reports a missing Content-Length as null rather than guessing", async () => {
    const result = await read(clientThat({ resolve: { Body: sdkBody([]) } }));
    expect(result.contentLength).toBeNull();
    expect(result.body).not.toBeNull();
    await result.body!.cancel();
  });

  it("swallows a failing cancel rather than replacing the caller's outcome", async () => {
    const result = await read(
      clientThat({
        resolve: {
          Body: {
            transformToWebStream(): ReadableStream<Uint8Array> {
              return new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new Uint8Array([7]));
                },
                cancel() {
                  throw new Error("cancel refused");
                },
              });
            },
          },
        },
      }),
    );
    await expect(result.body!.cancel()).resolves.toBeUndefined();
  });
});
