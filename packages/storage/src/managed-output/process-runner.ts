/**
 * The bounded-subprocess seam, as types only.
 *
 * Extracted here because two adapters now need it — the media inspector and the
 * deliverable composer — and the seam belongs to neither of them. Reaching the
 * shared vocabulary through the inspector's module would make the composer look
 * coupled to media inspection, and the repository's dormancy tripwire reads
 * exactly that: *no production file outside the inspector may name it*. A
 * type-only module keeps the tripwire at full strength instead of adding an
 * exemption to it, which is the part that matters — an exemption would also
 * excuse the constructor bans it enforces in the same pass.
 *
 * Nothing here runs anything. There is no import of a process module, no
 * default implementation and no configuration: this file declares what a runner
 * must offer, and the one place that actually launches a program stays where it
 * was.
 */

/** A bounded subprocess invocation. No shell, fixed args, capped output. */
export interface ProcessRunInput {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

/**
 * What running a program concluded, before any interpretation.
 *
 * Five distinct things can happen, and collapsing any two of them would put a
 * false statement in front of a customer:
 *
 * - `EXITED` — the program ran and returned a real exit status. Only here can a
 *   non-zero code be read as evidence about the *file*.
 * - `LAUNCH_FAILED` — the binary is missing or unusable: a *deployment* defect.
 * - `OUTPUT_TOO_LARGE` — it overran the configured stdout ceiling.
 * - `TIMED_OUT` — it exceeded the configured timeout.
 * - `TRANSIENT_FAILURE` — the *host* could not run it this time: `EMFILE`,
 *   `ENOMEM`, an abnormal signal, any other non-numeric system failure. The
 *   binary may be perfectly fine and the file may be perfectly valid, so this is
 *   neither `LAUNCH_FAILED` nor evidence of invalid media — it is retryable.
 */
export type ProcessRunOutcome =
  | { readonly kind: "EXITED"; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: "TIMED_OUT" }
  | { readonly kind: "OUTPUT_TOO_LARGE" }
  | { readonly kind: "LAUNCH_FAILED" }
  | { readonly kind: "TRANSIENT_FAILURE" };

export interface ProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunOutcome>;
}
