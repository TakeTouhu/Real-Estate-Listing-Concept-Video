/**
 * The one error the streaming transfer core throws of its own accord.
 *
 * Thrown only for adapter-contract defects — a source that handed back
 * something other than a byte stream, a chunk that is not bytes, a sink whose
 * commit result is outside the closed union. None of these is a transient
 * condition and none is evidence about the provider: they are bugs in the code
 * on either side of this core, and the right answer is a loud, fixed-text
 * failure that leaves the attempt exactly where it was. The Phase 2H-2 runner
 * catches it as `TRANSFER_SOURCE_FAILED` and the attempt stays
 * `OUTPUT_INGESTING`.
 *
 * Every message is fixed text keyed by a closed code. There is deliberately no
 * way to attach the offending value: a malformed commit result may be a raw
 * storage response carrying a signed URL, and a malformed chunk may be a slice
 * of a customer's video. The default rendering of a thrown value is the one
 * place unsafe content escapes without anyone choosing to log it.
 */

export type ManagedOutputTransferDefectCode =
  | "BYTE_SOURCE_OPEN_RESULT_MALFORMED"
  | "BYTE_SOURCE_STREAM_MALFORMED"
  | "BYTE_SOURCE_CHUNK_MALFORMED"
  | "STAGING_COMMIT_RESULT_MALFORMED";

const MESSAGES: Record<ManagedOutputTransferDefectCode, string> = {
  BYTE_SOURCE_OPEN_RESULT_MALFORMED:
    "The provider byte source returned something other than an open result",
  BYTE_SOURCE_STREAM_MALFORMED:
    "The provider byte source opened a stream outside the byte-stream contract",
  BYTE_SOURCE_CHUNK_MALFORMED: "The provider byte stream emitted a chunk that is not bytes",
  STAGING_COMMIT_RESULT_MALFORMED:
    "The managed output staging sink returned something other than a commit outcome",
};

export class ManagedOutputTransferDefect extends Error {
  readonly code: ManagedOutputTransferDefectCode;

  constructor(code: ManagedOutputTransferDefectCode) {
    // No `cause`. `new Error(msg, { cause })` is what makes `console.error(err)`
    // print whatever the adapter threw, and that is exactly the channel this
    // class exists to close.
    super(MESSAGES[code]);
    this.name = "ManagedOutputTransferDefect";
    this.code = code;
  }
}
