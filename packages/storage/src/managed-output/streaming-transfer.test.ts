import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  isWellFormedTransferOutcome,
  managedGenerationOutputKey,
  REDACTED_LOCATOR,
  safePositiveByteCount,
  sha256Digest,
  TransientProviderOutputLocator,
  type ManagedOutputTransferOutcome,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";
import {
  createTransferBarrier,
  FakeManagedOutputStagingSink,
  FakeProviderOutputByteSource,
  type FakeByteSourceScript,
  type FakeStagingSinkOptions,
} from "../testing/managed-output-fakes";
import { ManagedOutputTransferDefect } from "./defect";
import {
  MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
  StreamingManagedOutputTransfer,
  validateManagedOutputByteLimit,
} from "./streaming-transfer";

/**
 * The streaming core against deterministic fakes.
 *
 * Nothing here waits on a clock. Every ordering claim — "the source has not
 * advanced past the blocked write", "A committed before B" — is established
 * with a two-way barrier, because a sleep-based proof fails in the direction
 * that hides bugs.
 */

const RAW_URL = "https://fal.media/files/panda/out.mp4?X-Fal-Signature=SECRETSIGNATURE";
const KEY = managedGenerationOutputKey({ organizationId: "org_a", attemptId: "sgen_a" });

function locator(raw = RAW_URL): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The test's own oracle: one call over the whole buffer, never chunked. */
function digestOf(...chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

function receiptOf(...chunks: readonly Uint8Array[]): ManagedOutputVerificationReceipt {
  return {
    sha256: sha256Digest(digestOf(...chunks)),
    sizeBytes: safePositiveByteCount(chunks.reduce((n, c) => n + c.byteLength, 0)),
  };
}

function core(
  script: FakeByteSourceScript,
  sinkOptions: FakeStagingSinkOptions = {},
  maxBytes = 1_048_576,
) {
  const source = new FakeProviderOutputByteSource(script);
  const sink = new FakeManagedOutputStagingSink(sinkOptions);
  const transfer = new StreamingManagedOutputTransfer({ maxBytes }, { source, staging: sink });
  const run = (key = KEY, loc = locator()) =>
    transfer.transferAndVerify({ source: loc, destinationKey: key });
  return { source, sink, transfer, run };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the transfer to reject");
}

function verified(outcome: ManagedOutputTransferOutcome): ManagedOutputVerificationReceipt {
  if (outcome.kind !== "VERIFIED") throw new Error(`expected VERIFIED, got ${outcome.kind}`);
  return outcome.receipt as ManagedOutputVerificationReceipt;
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("names a 512 MiB hard ceiling", () => {
    expect(MAX_MANAGED_PROVIDER_OUTPUT_BYTES).toBe(536_870_912);
    expect(MAX_MANAGED_PROVIDER_OUTPUT_BYTES).toBe(512 * 1024 * 1024);
  });

  it("accepts a positive safe integer at or below the ceiling", () => {
    expect(validateManagedOutputByteLimit(1)).toBe(1);
    expect(validateManagedOutputByteLimit(MAX_MANAGED_PROVIDER_OUTPUT_BYTES)).toBe(
      MAX_MANAGED_PROVIDER_OUTPUT_BYTES,
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["one over the ceiling", MAX_MANAGED_PROVIDER_OUTPUT_BYTES + 1],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "1024"],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s rather than clamping", (_label, value) => {
    // Never clamped. A limit above the ceiling is a mistake worth seeing, and
    // silently lowering it would hide the mistake behind a value nobody chose.
    expect(() => validateManagedOutputByteLimit(value)).toThrow(AppError);
    expect(
      () =>
        new StreamingManagedOutputTransfer(
          { maxBytes: value as number },
          {
            source: new FakeProviderOutputByteSource({ chunks: [] }),
            staging: new FakeManagedOutputStagingSink(),
          },
        ),
    ).toThrow(AppError);
  });

  it("refuses with a configuration error carrying no value", () => {
    let caught: unknown;
    try {
      validateManagedOutputByteLimit(MAX_MANAGED_PROVIDER_OUTPUT_BYTES + 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("CONFIGURATION_ERROR");
    expect((caught as AppError).message).not.toContain("536870913");
  });
});

// ---------------------------------------------------------------------------

describe("hashing and counting", () => {
  it("produces the known SHA-256 of known bytes", async () => {
    // FIPS 180-4 test vector for "abc".
    const { run } = core({ chunks: [utf8("abc")] });
    const receipt = verified(await run());
    expect(receipt.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(receipt.sizeBytes).toBe(3);
  });

  it("digests many chunks exactly as it would one chunk of the same bytes", async () => {
    const whole = utf8("the quick brown fox jumps over the lazy dog");
    const split = [whole.subarray(0, 4), whole.subarray(4, 4), whole.subarray(4, 19), whole.subarray(19)];
    const one = verified(await core({ chunks: [whole] }).run());
    const many = verified(await core({ chunks: split }).run());
    expect(many.sha256).toBe(one.sha256);
    expect(many.sizeBytes).toBe(one.sizeBytes);
    expect(one.sha256).toBe(digestOf(whole));
  });

  it("counts every byte actually emitted", async () => {
    const { run } = core({ chunks: [bytes(1, 2, 3), bytes(), bytes(4), bytes(5, 6, 7, 8, 9)] });
    expect(verified(await run()).sizeBytes).toBe(9);
  });

  it("lets the actual count win over a smaller declared size", async () => {
    const { run } = core({ chunks: [bytes(1, 2, 3, 4)], declaredSizeBytes: 2 });
    const receipt = verified(await run());
    expect(receipt.sizeBytes).toBe(4);
    expect(receipt.sha256).toBe(digestOf(bytes(1, 2, 3, 4)));
  });

  it("lets the actual count win over a larger declared size", async () => {
    const { run } = core({ chunks: [bytes(1, 2)], declaredSizeBytes: 1000 });
    expect(verified(await run()).sizeBytes).toBe(2);
  });

  it("emits a lowercase digest", async () => {
    const receipt = verified(await core({ chunks: [bytes(255, 254, 253)] }).run());
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.sha256).toBe(receipt.sha256.toLowerCase());
  });

  it("stages exactly the bytes it hashed", async () => {
    const chunks = [utf8("hello, "), utf8("world")];
    const { sink, run } = core({ chunks });
    const receipt = verified(await run());
    const canonical = sink.canonical.get(KEY);
    expect(canonical).toBeDefined();
    expect(digestOf(canonical!.bytes)).toBe(receipt.sha256);
    expect(canonical!.bytes.byteLength).toBe(receipt.sizeBytes);
  });
});

// ---------------------------------------------------------------------------

describe("size bounds", () => {
  const N = 8;

  it("allows exactly N bytes under a limit of N", async () => {
    const { run } = core({ chunks: [bytes(1, 2, 3, 4), bytes(5, 6, 7, 8)] }, {}, N);
    expect((await run()).kind).toBe("VERIFIED");
  });

  it("refuses N + 1 actual bytes as retryable, aborts staging, closes the source", async () => {
    const { source, sink, run } = core({ chunks: [bytes(1, 2, 3, 4), bytes(5, 6, 7, 8, 9)] }, {}, N);
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.canonical.size).toBe(0);
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(sink.lastSession.commitCalls).toBe(0);
    expect(source.lastStream.closeCalls).toBe(1);
  });

  it("stops consuming at the chunk that crosses the limit", async () => {
    const { source, sink, run } = core(
      { chunks: [bytes(1, 2, 3, 4), bytes(5, 6, 7, 8, 9), bytes(10), bytes(11)] },
      {},
      N,
    );
    await run();
    // The over-limit chunk was pulled (it had to be, to be measured) and
    // nothing after it. It was neither hashed nor written.
    expect(source.lastStream.emitted).toBe(2);
    expect(source.lastStream.returnedEarly).toBe(true);
    expect(sink.lastSession.writes).toBe(1);
  });

  it("refuses a declared N + 1 before any staging begins, and still closes", async () => {
    const { source, sink, run } = core({ chunks: [bytes(1)], declaredSizeBytes: N + 1 }, {}, N);
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.sessions).toHaveLength(0);
    expect(source.lastStream.emitted).toBe(0);
    expect(source.lastStream.closeCalls).toBe(1);
  });

  it("still catches an actual N + 1 behind a declared N", async () => {
    // The header lied. The stream decides.
    const { sink, run } = core(
      { chunks: [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)], declaredSizeBytes: N },
      {},
      N,
    );
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.canonical.size).toBe(0);
  });

  it("governs by the actual count when nothing is declared", async () => {
    const ok = core({ chunks: [bytes(1, 2, 3, 4, 5, 6, 7, 8)], declaredSizeBytes: null }, {}, N);
    expect((await ok.run()).kind).toBe("VERIFIED");
    const over = core({ chunks: [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)], declaredSizeBytes: null }, {}, N);
    expect(await over.run()).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("refuses zero bytes as retryable and never creates a canonical object", async () => {
    const { source, sink, run } = core({ chunks: [] });
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.canonical.size).toBe(0);
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(sink.lastSession.commitCalls).toBe(0);
    expect(source.lastStream.closeCalls).toBe(1);
  });

  it("treats a body of only empty chunks as zero bytes", async () => {
    const { sink, run } = core({ chunks: [bytes(), bytes(), bytes()] });
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.canonical.size).toBe(0);
  });

  it("never manufactures a size of one for an empty output", async () => {
    const { run } = core({ chunks: [] });
    const outcome = await run();
    expect(outcome.kind).not.toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------

describe("backpressure", () => {
  it("does not advance the source while the sink is blocked on a write", async () => {
    const chunks = [bytes(1), bytes(2), bytes(3), bytes(4), bytes(5)];
    const barrier = createTransferBarrier();
    const { source, sink, run } = core(
      { chunks },
      {
        beforeWrite: async (_session, index) => {
          if (index !== 0) return;
          barrier.signalEntered();
          await barrier.waitForRelease();
        },
      },
    );

    const pending = run();
    // Resolves only once the core is inside the first write.
    await barrier.entered;

    // Exactly one chunk has been pulled — the one being written — and none
    // beyond it. An implementation that read the body into an array before
    // writing would already show all five here.
    expect(source.lastStream.emitted).toBe(1);
    expect(sink.lastSession.writes).toBe(0);

    barrier.release();
    const receipt = verified(await pending);
    expect(source.lastStream.emitted).toBe(chunks.length);
    expect(sink.lastSession.writes).toBe(chunks.length);
    expect(receipt.sizeBytes).toBe(5);
  });

  it("pulls each subsequent chunk only after the previous write resolved", async () => {
    // A stricter form: track, at every write, how many chunks had been emitted.
    const emittedAtWrite: number[] = [];
    const sourceRef: { current: FakeProviderOutputByteSource | null } = { current: null };
    const { source, run } = core(
      { chunks: [bytes(1), bytes(2), bytes(3), bytes(4)] },
      {
        beforeWrite: async () => {
          emittedAtWrite.push(sourceRef.current!.lastStream.emitted);
        },
      },
    );
    sourceRef.current = source;
    await run();
    // At write i (zero-based), exactly i + 1 chunks have been emitted: never
    // more, because the next pull waits on this write.
    expect(emittedAtWrite).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------

describe("the source is closed exactly once", () => {
  const CASES: readonly [string, () => ReturnType<typeof core>, "outcome" | "throw"][] = [
    ["a PUBLISHED success", () => core({ chunks: [bytes(1)] }), "outcome"],
    [
      "an EXISTING success",
      () => {
        const c = core({ chunks: [bytes(1)] });
        c.sink.canonical.set(KEY, { bytes: bytes(9), receipt: receiptOf(bytes(9)) });
        return c;
      },
      "outcome",
    ],
    ["a declared oversize", () => core({ chunks: [bytes(1)], declaredSizeBytes: 2 }, {}, 1), "outcome"],
    ["an actual oversize", () => core({ chunks: [bytes(1, 2)] }, {}, 1), "outcome"],
    ["zero bytes", () => core({ chunks: [] }), "outcome"],
    ["an iterator throw", () => core({ chunks: [bytes(1), bytes(2)], throwAfterChunks: 1 }), "throw"],
    ["a sink write throw", () => core({ chunks: [bytes(1)] }, { writeThrowsAt: 0 }), "throw"],
    ["a commit RETRYABLE_FAILURE", () => core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" }), "outcome"],
    ["a commit throw", () => core({ chunks: [bytes(1)] }, { commit: "THROW" }), "throw"],
    [
      "a malformed commit result",
      () => core({ chunks: [bytes(1)] }, { commit: () => ({ kind: "PUBLISHED", url: "s3://x" }) }),
      "throw",
    ],
    [
      "a malformed chunk",
      () => core({ chunks: [bytes(1), bytes(2)], malformedChunkAt: { index: 1, value: "bytes" } }),
      "throw",
    ],
  ];

  it.each(CASES)("after %s", async (_label, build, mode) => {
    const c = build();
    if (mode === "throw") await rejection(c.run());
    else await c.run();
    expect(c.source.lastStream.closeCalls).toBe(1);
  });

  it("has nothing to close when open itself reports RETRYABLE_FAILURE", async () => {
    const { source, sink, run } = core({ chunks: [bytes(1)], open: "RETRYABLE" });
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(source.streams).toHaveLength(0);
    expect(sink.sessions).toHaveLength(0);
  });

  it("lets a failing close leave the primary result untouched", async () => {
    const ok = core({ chunks: [bytes(1, 2, 3)], closeThrows: true });
    expect((await ok.run()).kind).toBe("VERIFIED");
    expect(ok.source.lastStream.closeCalls).toBe(1);

    const over = core({ chunks: [bytes(1, 2)], closeThrows: true }, {}, 1);
    expect(await over.run()).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("does not let a failing close mask a real thrown failure", async () => {
    const { run } = core({ chunks: [bytes(1)] , closeThrows: true }, { writeThrowsAt: 0 });
    const error = await rejection(run());
    expect((error as Error).message).toContain("write exploded");
    expect((error as Error).message).not.toContain("close exploded");
  });
});

// ---------------------------------------------------------------------------

describe("staging is aborted on failure and only on failure", () => {
  it.each([
    ["an actual oversize", () => core({ chunks: [bytes(1, 2)] }, {}, 1), "outcome"],
    ["zero bytes", () => core({ chunks: [] }), "outcome"],
    ["an iterator throw", () => core({ chunks: [bytes(1), bytes(2)], throwAfterChunks: 1 }), "throw"],
    ["a sink write throw", () => core({ chunks: [bytes(1)] }, { writeThrowsAt: 0 }), "throw"],
    ["a commit RETRYABLE_FAILURE", () => core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" }), "outcome"],
    ["a commit throw", () => core({ chunks: [bytes(1)] }, { commit: "THROW" }), "throw"],
    [
      "a malformed commit result",
      () => core({ chunks: [bytes(1)] }, { commit: () => ({ kind: "EXISTING" }) }),
      "throw",
    ],
    [
      "a malformed chunk",
      () => core({ chunks: [bytes(1), bytes(2)], malformedChunkAt: { index: 1, value: 42 } }),
      "throw",
    ],
  ] as const)("aborts after %s", async (_label, build, mode) => {
    const c = build();
    if (mode === "throw") await rejection(c.run());
    else await c.run();
    expect(c.sink.lastSession.abortCalls).toBe(1);
    expect(c.sink.canonical.size).toBe(0);
  });

  it("does not abort after PUBLISHED", async () => {
    const { sink, run } = core({ chunks: [bytes(1)] });
    expect((await run()).kind).toBe("VERIFIED");
    expect(sink.lastSession.abortCalls).toBe(0);
  });

  it("does not abort after EXISTING", async () => {
    const { sink, run } = core({ chunks: [bytes(1)] });
    sink.canonical.set(KEY, { bytes: bytes(9), receipt: receiptOf(bytes(9)) });
    expect((await run()).kind).toBe("VERIFIED");
    expect(sink.lastSession.abortCalls).toBe(0);
  });

  it("does not begin staging when open reports RETRYABLE_FAILURE", async () => {
    const { sink, run } = core({ chunks: [bytes(1)], open: "RETRYABLE" });
    await run();
    expect(sink.sessions).toHaveLength(0);
  });

  it("lets a failing abort leave the primary result untouched", async () => {
    const over = core({ chunks: [bytes(1, 2)] }, { abortThrows: true }, 1);
    expect(await over.run()).toEqual({ kind: "RETRYABLE_FAILURE" });

    const thrown = core({ chunks: [bytes(1)] }, { abortThrows: true, writeThrowsAt: 0 });
    const error = await rejection(thrown.run());
    expect((error as Error).message).toContain("write exploded");
    expect((error as Error).message).not.toContain("abort exploded");
  });
});

// ---------------------------------------------------------------------------

describe("commit outcomes", () => {
  it("returns VERIFIED with the computed receipt on PUBLISHED", async () => {
    const chunks = [utf8("alpha"), utf8("beta")];
    const { sink, run } = core({ chunks });
    const outcome = await run();
    expect(outcome).toEqual({ kind: "VERIFIED", receipt: receiptOf(...chunks) });
    expect(sink.lastSession.committed).toEqual({ kind: "PUBLISHED" });
  });

  it("returns VERIFIED with the canonical receipt, not its own, on EXISTING", async () => {
    const canonicalBytes = utf8("the one that got there first");
    const canonicalReceipt = receiptOf(canonicalBytes);
    const { sink, run } = core({ chunks: [utf8("different bytes entirely")] });
    sink.canonical.set(KEY, { bytes: canonicalBytes, receipt: canonicalReceipt });

    const outcome = await run();
    expect(outcome).toEqual({ kind: "VERIFIED", receipt: canonicalReceipt });
    // Its own receipt is for bytes that are not at the key. Reporting it would
    // finalize the database against an object that does not exist.
    expect((outcome as { receipt: ManagedOutputVerificationReceipt }).receipt.sha256).not.toBe(
      digestOf(utf8("different bytes entirely")),
    );
    expect(sink.canonical.get(KEY)!.bytes).toEqual(canonicalBytes);
  });

  it("passes an EXISTING receipt onward untouched, however it looks", async () => {
    // Untrusted input to Phase 2H-1, which is the receipt's only validator.
    const { run } = core({ chunks: [bytes(1)] }, { commit: () => ({ kind: "EXISTING", receipt: "??" }) });
    expect(await run()).toEqual({ kind: "VERIFIED", receipt: "??" });
  });

  it("returns RETRYABLE_FAILURE on a retryable commit", async () => {
    const { sink, run } = core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" });
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.canonical.size).toBe(0);
  });

  it("propagates a commit throw without wrapping it", async () => {
    const { run } = core({ chunks: [bytes(1)] }, { commit: "THROW" });
    const error = await rejection(run());
    expect((error as Error).message).toBe("fake sink: commit exploded");
  });

  it("keeps the canonical destination untouched until commit", async () => {
    const seenAtEachWrite: number[] = [];
    let sinkRef: FakeManagedOutputStagingSink | null = null;
    const { sink, run } = core(
      { chunks: [bytes(1), bytes(2), bytes(3)] },
      {
        beforeWrite: async () => {
          seenAtEachWrite.push(sinkRef!.canonical.size);
        },
      },
    );
    sinkRef = sink;
    await run();
    expect(seenAtEachWrite).toEqual([0, 0, 0]);
    expect(sink.canonical.size).toBe(1);
  });

  it("commits only after every byte has been written", async () => {
    const chunks = [bytes(1), bytes(2), bytes(3), bytes(4)];
    let writesAtCommit = -1;
    const { sink, run } = core(
      { chunks },
      { beforeCommit: async (session) => void (writesAtCommit = session.writes) },
    );
    await run();
    expect(writesAtCommit).toBe(chunks.length);
    expect(sink.canonical.get(KEY)!.bytes).toEqual(bytes(1, 2, 3, 4));
  });

  it("hands the sink exactly the receipt it will report", async () => {
    const chunks = [utf8("x"), utf8("yz")];
    let seen: ManagedOutputVerificationReceipt | null = null;
    const sink = new FakeManagedOutputStagingSink({
      commit: () => ({ kind: "PUBLISHED" }),
    });
    const original = sink.begin.bind(sink);
    sink.begin = async (input) => {
      const session = await original(input);
      const commit = session.commit.bind(session);
      session.commit = async (i) => {
        seen = i.receipt;
        return commit(i);
      };
      return session;
    };
    const transfer = new StreamingManagedOutputTransfer(
      { maxBytes: 1024 },
      { source: new FakeProviderOutputByteSource({ chunks }), staging: sink },
    );
    const outcome = await transfer.transferAndVerify({ source: locator(), destinationKey: KEY });
    expect(seen).toEqual(receiptOf(...chunks));
    expect(outcome).toEqual({ kind: "VERIFIED", receipt: receiptOf(...chunks) });
  });
});

// ---------------------------------------------------------------------------

describe("first canonical publish wins", () => {
  it("lets A publish, gives B EXISTING with A's receipt, and leaves A's bytes canonical", async () => {
    const bytesA = utf8("AAAA-the-first-runner's-bytes");
    const bytesB = utf8("BBBB-a-different-download-of-the-same-render");
    const sink = new FakeManagedOutputStagingSink({
      beforeCommit: async (session) => {
        // Hold B at its commit until A has fully finished.
        if (session === sink.sessions[1]) await gateB.waitForRelease();
      },
    });
    const gateB = createTransferBarrier();

    const A = new StreamingManagedOutputTransfer(
      { maxBytes: 1024 },
      { source: new FakeProviderOutputByteSource({ chunks: [bytesA] }), staging: sink },
    );
    const B = new StreamingManagedOutputTransfer(
      { maxBytes: 1024 },
      { source: new FakeProviderOutputByteSource({ chunks: [bytesB] }), staging: sink },
    );

    const runA = A.transferAndVerify({ source: locator(), destinationKey: KEY });
    const runB = B.transferAndVerify({ source: locator(), destinationKey: KEY });

    // Both stage. A commits and finishes while B is held at its commit.
    const outcomeA = await runA;
    expect(outcomeA).toEqual({ kind: "VERIFIED", receipt: receiptOf(bytesA) });
    expect(sink.canonical.get(KEY)!.bytes).toEqual(bytesA);
    expect(sink.sessions[0]!.committed).toEqual({ kind: "PUBLISHED" });

    gateB.release();
    const outcomeB = await runB;

    // B staged different bytes, and they went nowhere.
    expect(sink.sessions[1]!.committed).toEqual({ kind: "EXISTING", receipt: receiptOf(bytesA) });
    expect(outcomeB).toEqual({ kind: "VERIFIED", receipt: receiptOf(bytesA) });
    expect(sink.canonical.get(KEY)!.bytes).toEqual(bytesA);
    expect(sink.canonical.get(KEY)!.receipt).toEqual(receiptOf(bytesA));
    expect(sink.sessions[1]!.abortCalls).toBe(0);
  });

  it("never lets a later session with identical bytes republish either", async () => {
    const same = utf8("identical");
    const sink = new FakeManagedOutputStagingSink();
    const make = () =>
      new StreamingManagedOutputTransfer(
        { maxBytes: 1024 },
        { source: new FakeProviderOutputByteSource({ chunks: [same] }), staging: sink },
      );
    await make().transferAndVerify({ source: locator(), destinationKey: KEY });
    const second = await make().transferAndVerify({ source: locator(), destinationKey: KEY });
    expect(sink.sessions[1]!.committed?.kind).toBe("EXISTING");
    expect(second).toEqual({ kind: "VERIFIED", receipt: receiptOf(same) });
  });
});

// ---------------------------------------------------------------------------

describe("crash recovery", () => {
  it("recovers the canonical receipt when a prior run published but never finalized", async () => {
    // Run 1 publishes. "The process crashes" — nothing else happens.
    const published = utf8("published-by-run-one");
    const sink = new FakeManagedOutputStagingSink();
    const first = new StreamingManagedOutputTransfer(
      { maxBytes: 1024 },
      { source: new FakeProviderOutputByteSource({ chunks: [published] }), staging: sink },
    );
    expect(await first.transferAndVerify({ source: locator(), destinationKey: KEY })).toEqual({
      kind: "VERIFIED",
      receipt: receiptOf(published),
    });

    // Run 2 resumes the ingesting attempt, downloads again (bytes may differ),
    // stages, and commits.
    const again = utf8("re-downloaded-by-run-two-and-different");
    const second = new StreamingManagedOutputTransfer(
      { maxBytes: 1024 },
      { source: new FakeProviderOutputByteSource({ chunks: [again] }), staging: sink },
    );
    const outcome = await second.transferAndVerify({ source: locator(), destinationKey: KEY });

    expect(sink.sessions).toHaveLength(2);
    expect(sink.sessions[1]!.committed?.kind).toBe("EXISTING");
    expect(outcome).toEqual({ kind: "VERIFIED", receipt: receiptOf(published) });
    expect(sink.canonical.get(KEY)!.bytes).toEqual(published);
  });
});

// ---------------------------------------------------------------------------

describe("adapter-contract defects throw a fixed application-owned error", () => {
  it.each([
    ["null", () => null],
    ["an array", () => []],
    ["a string", () => "OPEN"],
    ["an unknown kind", () => ({ kind: "TERMINAL_FAILURE" })],
    ["OPEN without a stream", () => ({ kind: "OPEN" })],
    ["OPEN with a URL alongside", () => ({ kind: "OPEN", stream: null, url: "https://x" })],
    ["RETRYABLE_FAILURE with a message", () => ({ kind: "RETRYABLE_FAILURE", message: "x" })],
  ])("for an open result that is %s", async (_label, openOverride) => {
    const { sink, run } = core({ chunks: [bytes(1)], openOverride });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_OPEN_RESULT_MALFORMED");
    expect(sink.sessions).toHaveLength(0);
  });

  it.each([
    ["a string body", { body: "bytes", declaredSizeBytes: null }],
    ["an array body", { body: [bytes(1)], declaredSizeBytes: null }],
    ["a zero declared size", { body: (async function* () {})(), declaredSizeBytes: 0 }],
    ["a negative declared size", { body: (async function* () {})(), declaredSizeBytes: -5 }],
    ["a string declared size", { body: (async function* () {})(), declaredSizeBytes: "5" }],
  ])("for an open stream with %s, after releasing it", async (_label, shape) => {
    let closes = 0;
    const { sink, run } = core({
      chunks: [],
      openOverride: () => ({
        kind: "OPEN",
        stream: { ...shape, close: async () => void (closes += 1) },
      }),
    });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_STREAM_MALFORMED");
    // The handle was broken but its `close` was callable, so the resource it
    // may hold is released once before the defect is raised.
    expect(closes).toBe(1);
    expect(sink.sessions).toHaveLength(0);
  });

  it.each([
    ["status", { status: 200 }],
    ["url", { url: "https://fal.media/files/x?sig=SECRETSIGNATURE" }],
    ["headers", { headers: { "content-length": "3" } }],
  ])(
    "for a valid stream inside an OPEN wrapper carrying %s: closes the stream once, then raises the wrapper's defect",
    async (_label, extra) => {
      // The wrapper is the defective part — the stream is fully valid. That
      // makes it *more* important to release, not less: a valid handle is
      // exactly the one holding a real response body or socket.
      let closes = 0;
      const { sink, run } = core({
        chunks: [],
        openOverride: () => ({
          kind: "OPEN",
          stream: {
            body: (async function* () {
              yield bytes(1);
            })(),
            declaredSizeBytes: null,
            close: async () => void (closes += 1),
          },
          ...extra,
        }),
      });
      const error = await rejection(run());
      expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
      expect((error as ManagedOutputTransferDefect).code).toBe(
        "BYTE_SOURCE_OPEN_RESULT_MALFORMED",
      );
      expect(closes).toBe(1);
      expect(sink.sessions).toHaveLength(0);
      expect(sink.canonical.size).toBe(0);
    },
  );

  it("for a stream whose close getter throws: the fixed defect stands and the getter's text never escapes", async () => {
    // A hostile handle. Obtaining `close` throws before it could ever be
    // invoked. The validator answers false rather than propagating, cleanup
    // swallows the getter, and the defect that follows is the only thing a
    // caller can observe.
    const { sink, run } = core({
      chunks: [],
      openOverride: () => ({
        kind: "OPEN",
        stream: {
          body: (async function* () {})(),
          declaredSizeBytes: null,
          get close(): never {
            throw new Error("GETTER-SECRET s3://bucket/key?sig=SECRETSIGNATURE");
          },
        },
      }),
    });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_STREAM_MALFORMED");
    const text = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
    for (const fragment of ["GETTER-SECRET", "SECRETSIGNATURE", "s3://"]) {
      expect(text).not.toContain(fragment);
    }
    expect((error as Error).cause).toBeUndefined();
    expect(sink.sessions).toHaveLength(0);
  });

  it("for a stream whose close getter throws inside an OPEN wrapper with an extra key: still the stream's defect, still nothing escapes", async () => {
    const { sink, run } = core({
      chunks: [],
      openOverride: () => ({
        kind: "OPEN",
        stream: {
          body: (async function* () {})(),
          declaredSizeBytes: null,
          get close(): never {
            throw new Error("GETTER-SECRET");
          },
        },
        status: 200,
      }),
    });
    const error = await rejection(run());
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_STREAM_MALFORMED");
    expect((error as Error).message).not.toContain("GETTER-SECRET");
    expect(sink.sessions).toHaveLength(0);
  });

  it("for an OPEN wrapper whose stream getter throws: the wrapper's defect, no cleanup attempted", async () => {
    const { sink, run } = core({
      chunks: [],
      openOverride: () => ({
        kind: "OPEN",
        get stream(): never {
          throw new Error("STREAM-GETTER-SECRET");
        },
      }),
    });
    const error = await rejection(run());
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_OPEN_RESULT_MALFORMED");
    expect((error as Error).message).not.toContain("STREAM-GETTER-SECRET");
    expect(sink.sessions).toHaveLength(0);
  });

  it("for an open stream with no close, without attempting one", async () => {
    const { run } = core({
      chunks: [],
      openOverride: () => ({ kind: "OPEN", stream: { body: (async function* () {})(), declaredSizeBytes: null } }),
    });
    const error = await rejection(run());
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_STREAM_MALFORMED");
  });

  it.each([
    ["a string", "chunk"],
    ["a number", 42],
    ["null", null],
    ["a plain array", [1, 2, 3]],
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["an object", { byteLength: 4 }],
  ])("for a chunk that is %s, after aborting staging and closing", async (_label, value) => {
    const { source, sink, run } = core({
      chunks: [bytes(1), bytes(2), bytes(3)],
      malformedChunkAt: { index: 1, value },
    });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_CHUNK_MALFORMED");
    expect(sink.lastSession.writes).toBe(1);
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(source.lastStream.closeCalls).toBe(1);
    expect(sink.canonical.size).toBe(0);
  });

  it("accepts a Buffer chunk, which is a Uint8Array", async () => {
    const { run } = core({ chunks: [Buffer.from("abc")] });
    expect(verified(await run()).sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it.each([
    ["null", () => null],
    ["an array", () => []],
    ["a string", () => "PUBLISHED"],
    ["an unknown kind", () => ({ kind: "OK" })],
    ["PUBLISHED with an extra key", () => ({ kind: "PUBLISHED", etag: "x" })],
    ["PUBLISHED with a URL", () => ({ kind: "PUBLISHED", url: "s3://b/k" })],
    ["EXISTING without a receipt", () => ({ kind: "EXISTING" })],
    ["EXISTING with a URL", () => ({ kind: "EXISTING", receipt: {}, url: "s3://b/k" })],
    ["RETRYABLE_FAILURE with a message", () => ({ kind: "RETRYABLE_FAILURE", message: "m" })],
    ["RETRYABLE_FAILURE with a diagnostic", () => ({ kind: "RETRYABLE_FAILURE", code: "X" })],
  ])("for a commit result that is %s, after aborting and closing", async (_label, commit) => {
    const { source, sink, run } = core({ chunks: [bytes(1)] }, { commit });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("STAGING_COMMIT_RESULT_MALFORMED");
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(source.lastStream.closeCalls).toBe(1);
  });

  it("for a commit result whose kind getter throws: the fixed defect stands, nothing of the getter escapes, staging is aborted, nothing is published", async () => {
    const { source, sink, run } = core(
      { chunks: [bytes(1, 2, 3)] },
      {
        commit: () => ({
          get kind(): never {
            throw new Error("GETTER-SECRET s3://bucket/key?sig=SECRETSIGNATURE");
          },
        }),
      },
    );
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("STAGING_COMMIT_RESULT_MALFORMED");
    expect((error as Error).message).toBe(
      "The managed output staging sink returned something other than a commit outcome",
    );
    const text = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
    for (const fragment of ["GETTER-SECRET", "SECRETSIGNATURE", "s3://", "bucket"]) {
      expect(text).not.toContain(fragment);
    }
    expect((error as Error).cause).toBeUndefined();
    // The malformed answer is treated as no answer: the session is discarded,
    // the source released, and nothing has been made canonical.
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(source.lastStream.closeCalls).toBe(1);
    expect(sink.canonical.size).toBe(0);
  });

  it("for a commit result whose kind getter answers once and then throws: VERIFIED on the single guarded read, and the second-read trap is never sprung", async () => {
    // Passes a naive predicate, then explodes on the second read a naive
    // dispatch would perform. The core reads exactly once, under the guard.
    let reads = 0;
    const { sink, run } = core(
      { chunks: [bytes(1)] },
      {
        commit: () => ({
          get kind(): string {
            reads += 1;
            if (reads > 1) throw new Error("GETTER-SECRET-SECOND-READ");
            return "PUBLISHED";
          },
        }),
      },
    );
    // A `kind` that reads as PUBLISHED once and is otherwise well-formed is a
    // valid outcome on its single guarded read — and the core never reads it
    // again, so the second-read trap is never sprung.
    const outcome = await run();
    expect(outcome.kind).toBe("VERIFIED");
    expect(reads).toBe(1);
    expect(sink.lastSession.abortCalls).toBe(0);
  });

  it("for an EXISTING commit result whose receipt getter throws: the fixed defect, nothing escapes", async () => {
    const { sink, run } = core(
      { chunks: [bytes(1)] },
      {
        commit: () => ({
          kind: "EXISTING",
          get receipt(): never {
            throw new Error("GETTER-SECRET");
          },
        }),
      },
    );
    const error = await rejection(run());
    expect((error as ManagedOutputTransferDefect).code).toBe("STAGING_COMMIT_RESULT_MALFORMED");
    expect(`${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`).not.toContain(
      "GETTER-SECRET",
    );
    expect((error as Error).cause).toBeUndefined();
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(sink.canonical.size).toBe(0);
  });

  it("puts none of the malformed value into the thrown error", async () => {
    const { run } = core(
      { chunks: [bytes(1)] },
      { commit: () => ({ kind: "PUBLISHED", url: "s3://bucket/SECRET-KEY?sig=SECRETSIGNATURE" }) },
    );
    const error = await rejection(run());
    const text = `${(error as Error).message} ${JSON.stringify(error)} ${String(error)}`;
    for (const fragment of ["SECRET", "s3://", "bucket", "url"]) {
      expect(text).not.toContain(fragment);
    }
    expect((error as Error).cause).toBeUndefined();
  });

  // A revoked Proxy is hostile *before* any property is read: `typeof` still
  // answers "object", and the first real question — is it an array? — throws a
  // TypeError from the runtime itself, ahead of every parser's guard. The
  // shared record check is where that is absorbed. Where such a value can
  // actually arrive in this core is narrower than "anywhere an adapter answers":
  // a revoked Proxy cannot cross an `await`, because promise resolution reads
  // `.then` on it and that read throws inside the adapter's own promise. So it
  // never reaches the core as a whole open result or a whole commit result; it
  // reaches the core as a *property* of one — the `stream`, or the `EXISTING`
  // receipt — and those are the arrival points proved here.
  function revokedProxy(): object {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }

  it("for an OPEN result whose stream is a revoked Proxy: the stream's fixed defect, cleanup attempted quietly, nothing of the runtime escapes", async () => {
    const { sink, run } = core({
      chunks: [],
      openOverride: () => ({ kind: "OPEN", stream: revokedProxy() }),
    });
    const error = await rejection(run());
    expect(error).toBeInstanceOf(ManagedOutputTransferDefect);
    expect((error as ManagedOutputTransferDefect).code).toBe("BYTE_SOURCE_STREAM_MALFORMED");
    const text = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
    for (const fragment of ["revoked", "Proxy", "proxy", "IsArray", "TypeError"]) {
      expect(text).not.toContain(fragment);
    }
    expect((error as Error).cause).toBeUndefined();
    expect(sink.sessions).toHaveLength(0);
    expect(sink.canonical.size).toBe(0);
  });

  it("for an EXISTING commit result whose receipt is a revoked Proxy: carried onward untouched, for Phase 2H-1 to refuse", async () => {
    // The core never reads the receipt's contents, so it never trips the
    // Proxy; the value travels to the only authority on it, whose shared
    // record check answers false without throwing.
    const proxy = revokedProxy();
    const { sink, run } = core(
      { chunks: [bytes(1)] },
      { commit: () => ({ kind: "EXISTING", receipt: proxy }) },
    );
    const outcome = await run();
    expect(outcome.kind).toBe("VERIFIED");
    expect((outcome as { receipt: unknown }).receipt).toBe(proxy);
    expect(sink.lastSession.abortCalls).toBe(0);
  });

  it.each([
    ["open", { openOverride: () => revokedProxy() }, {}],
    ["commit", {}, { commit: () => revokedProxy() }],
  ] as const)(
    "a revoked Proxy returned whole from %s never reaches the core: the adapter's own promise rejects, and that is handled as the adapter's throw",
    async (_label, script, sinkOptions) => {
      // Not a defect of this core and not classified by it: resolving the
      // adapter's promise reads `.then` on the value, which throws inside the
      // adapter. The core sees exactly what it sees for any adapter throw and
      // does what it always does — abort staging if begun, close the source if
      // opened, propagate. Pinned so the arrival-point analysis above stays
      // honest if the runtime's promise semantics ever changed.
      const { source, sink, run } = core({ chunks: [bytes(1)], ...script }, sinkOptions);
      const error = await rejection(run());
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ManagedOutputTransferDefect);
      expect(sink.canonical.size).toBe(0);
      if (sink.sessions.length > 0) {
        expect(sink.lastSession.abortCalls).toBe(1);
        expect(source.lastStream.closeCalls).toBe(1);
      }
    },
  );
});

// ---------------------------------------------------------------------------

describe("expected operational failures are retryable, never thrown", () => {
  it("returns RETRYABLE_FAILURE when open reports it, touching nothing", async () => {
    const { sink, run } = core({ chunks: [bytes(1)], open: "RETRYABLE" });
    expect(await run()).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(sink.sessions).toHaveLength(0);
    expect(sink.canonical.size).toBe(0);
  });

  it("propagates a throw from open untouched", async () => {
    const { sink, run } = core({ chunks: [bytes(1)], open: "THROW" });
    const error = await rejection(run());
    expect((error as Error).message).toBe("fake source: open exploded");
    expect(sink.sessions).toHaveLength(0);
  });

  it("propagates an iterator throw after aborting and closing", async () => {
    const { source, sink, run } = core({ chunks: [bytes(1), bytes(2)], throwAfterChunks: 1 });
    const error = await rejection(run());
    expect((error as Error).message).toContain("iterator exploded");
    expect(sink.lastSession.writes).toBe(1);
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(source.lastStream.closeCalls).toBe(1);
    expect(sink.canonical.size).toBe(0);
  });

  it("propagates a sink write throw after aborting and closing", async () => {
    const { source, sink, run } = core({ chunks: [bytes(1), bytes(2)] }, { writeThrowsAt: 1 });
    const error = await rejection(run());
    expect((error as Error).message).toBe("fake sink: write exploded");
    expect(sink.lastSession.abortCalls).toBe(1);
    expect(source.lastStream.closeCalls).toBe(1);
    // Nothing more was pulled after the write refused.
    expect(source.lastStream.emitted).toBe(2);
  });

  it("never reports a provider failure of any kind", async () => {
    // The outcome union has no FAILED arm to reach. Stated as a test so the
    // property is asserted rather than implied by the types.
    for (const c of [
      core({ chunks: [bytes(1)], open: "RETRYABLE" }),
      core({ chunks: [bytes(1, 2)] }, {}, 1),
      core({ chunks: [] }),
      core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" }),
    ]) {
      const outcome = await c.run();
      expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
      expect(Object.getOwnPropertyNames(outcome)).toEqual(["kind"]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("locator secrecy", () => {
  it("hands the very same locator object to the source, unread", async () => {
    const loc = locator();
    const { source, run } = core({ chunks: [bytes(1)] });
    await run(KEY, loc);
    expect(source.openCalls).toHaveLength(1);
    expect(source.openCalls[0]).toBe(loc);
  });

  it("puts the raw locator in no outcome, on any path", async () => {
    for (const c of [
      core({ chunks: [bytes(1)] }),
      core({ chunks: [bytes(1)], open: "RETRYABLE" }),
      core({ chunks: [bytes(1, 2)] }, {}, 1),
      core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" }),
    ]) {
      const outcome = await c.run();
      const text = JSON.stringify(outcome) + String(outcome);
      expect(text).not.toContain("SECRETSIGNATURE");
      expect(text).not.toContain("fal.media");
    }
  });

  it("gives the sink no way to see the locator", async () => {
    const { sink, run } = core({ chunks: [bytes(1)] });
    await run();
    const text = JSON.stringify([...sink.canonical.entries()]) + JSON.stringify(sink.sessions);
    expect(text).not.toContain("SECRETSIGNATURE");
    expect(text).not.toContain("fal.media");
    expect(String(locator())).toBe(REDACTED_LOCATOR);
  });
});

// ---------------------------------------------------------------------------

describe("every outcome satisfies the Phase 2H-2 contract", () => {
  it.each([
    ["published", () => core({ chunks: [bytes(1)] })],
    ["open retryable", () => core({ chunks: [bytes(1)], open: "RETRYABLE" })],
    ["declared oversize", () => core({ chunks: [bytes(1)], declaredSizeBytes: 9 }, {}, 1)],
    ["actual oversize", () => core({ chunks: [bytes(1, 2)] }, {}, 1)],
    ["empty", () => core({ chunks: [] })],
    ["commit retryable", () => core({ chunks: [bytes(1)] }, { commit: "RETRYABLE" })],
    [
      "existing",
      () => {
        const c = core({ chunks: [bytes(1)] });
        c.sink.canonical.set(KEY, { bytes: bytes(9), receipt: receiptOf(bytes(9)) });
        return c;
      },
    ],
  ])("for %s", async (_label, build) => {
    const outcome = await build().run();
    // The runner validates with exactly this predicate. An outcome failing it
    // would be TRANSFER_OUTCOME_MALFORMED and no state change.
    expect(isWellFormedTransferOutcome(outcome)).toBe(true);
  });
});
