import type {
  ManagedGenerationOutputKey,
  ManagedOutputVerificationReceipt,
  ProviderOutputByteSource,
  ProviderOutputByteSourceOpenResult,
  ProviderOutputByteStream,
  TransientProviderOutputLocator,
} from "@app/domain";
import type {
  ManagedOutputStagingCommitOutcome,
  ManagedOutputStagingSession,
  ManagedOutputStagingSink,
} from "../managed-output/staging";

/**
 * Deterministic stand-ins for the two contracts the streaming core consumes.
 *
 * **Test support only.** Neither is a production adapter, neither is exported
 * from the package root, and the static suite asserts that nothing in
 * production constructs the core that would use them. They exist so the core's
 * properties — backpressure, bounded size, exactly-once close, first-publish-
 * wins, receipt recovery — can be proved with barriers rather than timing, and
 * so the live-PostgreSQL suite can run the real core through the real runner
 * without a byte crossing the network.
 *
 * Neither fake ever reads the locator. The source records that it was *handed*
 * one and nothing more; there is no accessor to read, and the fakes do not
 * pretend otherwise.
 */

/**
 * A two-way barrier around one point in a fake.
 *
 * `entered` resolves when the fake has definitely reached the point; the fake
 * then waits at `waitForRelease` until the test calls `release`. Both
 * directions are explicit, so a test never has to guess with a timer whether
 * the core is inside the call yet — a guess that fails in the direction that
 * hides bugs.
 */
export interface TransferBarrier {
  readonly entered: Promise<void>;
  signalEntered(): void;
  waitForRelease(): Promise<void>;
  release(): void;
}

export function createTransferBarrier(): TransferBarrier {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    signalEntered: () => signalEntered(),
    waitForRelease: () => released,
    release: () => release(),
  };
}

// ---------------------------------------------------------------------------
// Provider byte source
// ---------------------------------------------------------------------------

export interface FakeByteSourceScript {
  /** The chunks the body emits, in order. */
  readonly chunks: readonly Uint8Array[];
  /** What the stream claims about its size. Default: claims nothing. */
  readonly declaredSizeBytes?: number | null;
  /**
   * How `open` answers. `"OPEN"` (default) hands back a stream; `"RETRYABLE"`
   * returns the transient arm; `"THROW"` rejects.
   */
  readonly open?: "OPEN" | "RETRYABLE" | "THROW";
  /** Return exactly this from `open`, bypassing the contract. For defect tests. */
  readonly openOverride?: () => unknown;
  /** Throw from the iterator after this many chunks have been emitted. */
  readonly throwAfterChunks?: number;
  /** Emit this value (not bytes) as the chunk at this index. For defect tests. */
  readonly malformedChunkAt?: { readonly index: number; readonly value: unknown };
  /** Awaited before each chunk is emitted. For barriers. */
  readonly beforeChunk?: (index: number) => Promise<void>;
  /** Throw from `close`. Proves close failures do not change the result. */
  readonly closeThrows?: boolean;
}

/** One opened stream's observable history. */
export interface FakeStreamRecord {
  /** How many chunks the iterator has actually yielded so far. */
  emitted: number;
  /** How many times `close` was called. */
  closeCalls: number;
  /** Whether the consumer stopped iterating before the body was exhausted. */
  returnedEarly: boolean;
}

export class FakeProviderOutputByteSource implements ProviderOutputByteSource {
  readonly openCalls: TransientProviderOutputLocator[] = [];
  readonly streams: FakeStreamRecord[] = [];

  constructor(private readonly script: FakeByteSourceScript) {}

  /** The most recently opened stream's record, or throw if none was opened. */
  get lastStream(): FakeStreamRecord {
    const last = this.streams.at(-1);
    if (last === undefined) throw new Error("fake source: no stream was opened");
    return last;
  }

  async open(source: TransientProviderOutputLocator): Promise<ProviderOutputByteSourceOpenResult> {
    this.openCalls.push(source);
    if (this.script.openOverride !== undefined) {
      return this.script.openOverride() as ProviderOutputByteSourceOpenResult;
    }
    if (this.script.open === "THROW") throw new Error("fake source: open exploded");
    if (this.script.open === "RETRYABLE") return { kind: "RETRYABLE_FAILURE" };

    const record: FakeStreamRecord = { emitted: 0, closeCalls: 0, returnedEarly: false };
    this.streams.push(record);
    const script = this.script;

    async function* body(): AsyncGenerator<Uint8Array, void, undefined> {
      let index = 0;
      try {
        for (const chunk of script.chunks) {
          if (script.throwAfterChunks !== undefined && index >= script.throwAfterChunks) {
            throw new Error("fake source: iterator exploded mid-stream");
          }
          if (script.beforeChunk !== undefined) await script.beforeChunk(index);
          record.emitted += 1;
          if (script.malformedChunkAt !== undefined && script.malformedChunkAt.index === index) {
            yield script.malformedChunkAt.value as Uint8Array;
          } else {
            yield chunk;
          }
          index += 1;
        }
        if (script.throwAfterChunks !== undefined && index >= script.throwAfterChunks) {
          throw new Error("fake source: iterator exploded at end");
        }
      } finally {
        if (index < script.chunks.length) record.returnedEarly = true;
      }
    }

    const stream: ProviderOutputByteStream = {
      body: body(),
      declaredSizeBytes: script.declaredSizeBytes ?? null,
      async close() {
        record.closeCalls += 1;
        if (script.closeThrows === true) throw new Error("fake source: close exploded");
      },
    };
    return { kind: "OPEN", stream };
  }
}

// ---------------------------------------------------------------------------
// Managed output staging sink
// ---------------------------------------------------------------------------

/** A canonical object as the fake store holds it. */
export interface FakeCanonicalObject {
  readonly bytes: Uint8Array;
  readonly receipt: ManagedOutputVerificationReceipt;
}

export interface FakeStagingSinkOptions {
  /** Throw from `write` on this zero-based write index. */
  readonly writeThrowsAt?: number;
  /** Awaited before each write, with the zero-based index. For barriers. */
  readonly beforeWrite?: (session: FakeStagingSession, index: number) => Promise<void>;
  /** Awaited before commit decides anything. For ordering two sessions. */
  readonly beforeCommit?: (session: FakeStagingSession) => Promise<void>;
  /**
   * Override the commit answer. `"RETRYABLE"` returns the transient arm,
   * `"THROW"` rejects, a function returns its value verbatim (for defect tests).
   * Default: real first-publish-wins semantics.
   */
  readonly commit?: "RETRYABLE" | "THROW" | (() => unknown);
  /** Throw from `abort`. Proves abort failures do not change the result. */
  readonly abortThrows?: boolean;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class FakeStagingSession implements ManagedOutputStagingSession {
  /** Bytes staged so far, isolated from the canonical map until commit. */
  readonly staged: Uint8Array[] = [];
  writes = 0;
  commitCalls = 0;
  abortCalls = 0;
  /** What commit answered, if it answered. */
  committed: ManagedOutputStagingCommitOutcome | null = null;

  // `#` fields, not TypeScript `private`: the back-reference to the sink
  // must be invisible to `JSON.stringify`, spread and `Object.keys`, so a test
  // can serialize a session's observable state without walking into the
  // canonical map it belongs to.
  readonly #sink: FakeManagedOutputStagingSink;
  readonly #options: FakeStagingSinkOptions;

  constructor(
    sink: FakeManagedOutputStagingSink,
    readonly destinationKey: ManagedGenerationOutputKey,
    options: FakeStagingSinkOptions,
  ) {
    this.#sink = sink;
    this.#options = options;
  }

  async write(chunk: Uint8Array): Promise<void> {
    const index = this.writes;
    if (this.#options.beforeWrite !== undefined) await this.#options.beforeWrite(this, index);
    if (this.#options.writeThrowsAt === index) throw new Error("fake sink: write exploded");
    this.staged.push(Uint8Array.from(chunk));
    this.writes += 1;
  }

  async commit(input: { readonly receipt: ManagedOutputVerificationReceipt }): Promise<unknown> {
    this.commitCalls += 1;
    if (this.#options.beforeCommit !== undefined) await this.#options.beforeCommit(this);
    if (this.#options.commit === "THROW") throw new Error("fake sink: commit exploded");
    if (this.#options.commit === "RETRYABLE") {
      this.committed = { kind: "RETRYABLE_FAILURE" };
      return this.committed;
    }
    if (typeof this.#options.commit === "function") return this.#options.commit();

    // First publish wins. The canonical map is consulted and, if empty for
    // this key, written in one synchronous step — there is no await between
    // the check and the set, which is what makes two racing sessions on one
    // key resolve to exactly one PUBLISHED and one EXISTING.
    const existing = this.#sink.canonical.get(this.destinationKey);
    if (existing !== undefined) {
      this.committed = { kind: "EXISTING", receipt: existing.receipt };
      return this.committed;
    }
    this.#sink.canonical.set(this.destinationKey, {
      bytes: concatenate(this.staged),
      receipt: input.receipt,
    });
    this.committed = { kind: "PUBLISHED" };
    return this.committed;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.#options.abortThrows === true) throw new Error("fake sink: abort exploded");
    this.staged.length = 0;
  }
}

export class FakeManagedOutputStagingSink implements ManagedOutputStagingSink {
  /** The canonical store: what is visible at each key after a publish. */
  readonly canonical = new Map<string, FakeCanonicalObject>();
  readonly sessions: FakeStagingSession[] = [];

  constructor(private readonly options: FakeStagingSinkOptions = {}) {}

  /** The most recently begun session, or throw if none was begun. */
  get lastSession(): FakeStagingSession {
    const last = this.sessions.at(-1);
    if (last === undefined) throw new Error("fake sink: no session was begun");
    return last;
  }

  async begin(input: {
    readonly destinationKey: ManagedGenerationOutputKey;
  }): Promise<ManagedOutputStagingSession> {
    const session = new FakeStagingSession(this, input.destinationKey, this.options);
    this.sessions.push(session);
    return session;
  }
}
