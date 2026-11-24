import { createConnection } from "node:net";
import type { MalwareScanner, ScanVerdict } from "@app/domain";
import { AppError, CLAMAV_DEFAULT_PORT, isClamAvHost } from "@app/shared";

/**
 * The milliseconds a connection to the daemon may go without a byte either way before it is given up: the
 * connection's own setting (`net.createConnection`'s `timeout` option), which ends that one connection. Nothing
 * here keeps a deadline of its own. The daemon answers only once it has read and scanned the whole photo, so the
 * quiet a scan waits through is its turn in the daemon's queue plus its scan: 60 s held for 60 large photos at once
 * where 30 s failed healthy scans (ADR-0163).
 */
export const CLAMAV_IDLE_LIMIT_MS = 60_000;

/** The bytes of a photo sent in each `INSTREAM` chunk. */
export const CLAMAV_CHUNK_BYTES = 64 * 1024;

/** The longest answer read, its NUL included: the daemon's are one short line. */
const MAX_ANSWER_BYTES = 1024;

/** A one-word code a Node.js error carries, such as `ECONNREFUSED`. */
const TRANSPORT_CODE = /^E[A-Z0-9_]{1,31}$/;

/** `stream: <signature> FOUND`, the signature one printable word. */
const FOUND = /^stream: ([\x21-\x7e]{1,255}) FOUND$/;

/**
 * Why a scan did not end in a verdict, as the port's `detail`. Never a message, a host or a signature's name.
 * `CLAMAV_LIMITS_EXCEEDED` is the daemon saying it did not read the photo in full; the transport's own code (for
 * example `ECONNREFUSED`) is passed on as it is.
 */
export type ClamAvFailureCode =
  | "CLAMAV_IDLE"
  | "CLAMAV_CLOSED"
  | "CLAMAV_EARLY_ANSWER"
  | "CLAMAV_UNEXPECTED_ANSWER"
  | "CLAMAV_SIZE_LIMIT"
  | "CLAMAV_LIMITS_EXCEEDED"
  | "CLAMAV_ERROR"
  | "CLAMAV_UNREACHABLE"
  | `E${string}`;

export interface ClamAvScannerOptions {
  /** The daemon's host: a DNS name or an IP address, never with a port. */
  readonly host: string;
  /** Its TCP port, `3310` unless given. */
  readonly port?: number;
  /** For tests: the connection's idle limit, `CLAMAV_IDLE_LIMIT_MS` unless given. */
  readonly idleLimitMs?: number;
}

type ScanResult = { verdict: ScanVerdict; detail?: string };

const failed = (code: ClamAvFailureCode): ScanResult => ({ verdict: "SCAN_FAILED", detail: code });

/** What a whole answer, read without its NUL, means. */
function verdictOf(answer: string): ScanResult {
  if (answer === "stream: OK") return { verdict: "CLEAN" };
  const found = FOUND.exec(answer);
  if (found?.[1] !== undefined) {
    // Not read in full is not a detection: it fails closed, and the photo may be scanned again (ADR-0163).
    if (found[1].startsWith("Heuristics.Limits.Exceeded")) return failed("CLAMAV_LIMITS_EXCEEDED");
    return { verdict: "INFECTED" };
  }
  if (answer === "INSTREAM size limit exceeded. ERROR") return failed("CLAMAV_SIZE_LIMIT");
  if (answer.endsWith(" ERROR")) return failed("CLAMAV_ERROR");
  return failed("CLAMAV_UNEXPECTED_ANSWER");
}

/**
 * Malware scanning by a ClamAV daemon over TCP (ADR-0163; ADR-0054 Decision 5). Each scan opens one connection and
 * sends the photo as `zINSTREAM`, in chunks after their four-byte big-endian length and then a length of zero,
 * waiting whenever the connection asks it to. Nothing is written to disk.
 *
 * The answer is read when the daemon closes its side. `CLEAN` is exactly `stream: OK` and its NUL, alone, after the
 * whole photo was sent; `stream: <name> FOUND` is `INFECTED`, with no detail, so nothing can log the name; every
 * other answer, and every failed, refused, quiet or closed connection, is `SCAN_FAILED` with a code. A scan never
 * throws, so a photo is never left being scanned.
 *
 * Built with no connection, and nothing here starts anything by itself. Nothing builds it yet (ADR-0163).
 */
export function createClamAvScanner(options: ClamAvScannerOptions): MalwareScanner {
  // Neither refusal repeats what was given.
  if (typeof options.host !== "string" || !isClamAvHost(options.host)) {
    throw new AppError("CONFIGURATION_ERROR", "The ClamAV host must be a DNS name or an IP address, with no port");
  }
  const port = options.port ?? CLAMAV_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError("CONFIGURATION_ERROR", "The ClamAV port must be a whole number from 1 to 65535");
  }
  const idleLimitMs = options.idleLimitMs ?? CLAMAV_IDLE_LIMIT_MS;
  if (!Number.isInteger(idleLimitMs) || idleLimitMs < 1) {
    throw new AppError("CONFIGURATION_ERROR", "The ClamAV idle limit must be a whole number of milliseconds");
  }
  const host = options.host;

  return {
    scan(data: Uint8Array): Promise<ScanResult> {
      return new Promise<ScanResult>((resolve) => {
        const received: Buffer[] = [];
        let receivedBytes = 0;
        let sent = false;
        let settled = false;

        const socket = createConnection({ host, port, timeout: idleLimitMs });

        const settle = (result: ScanResult): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(result);
        };

        /** The answer received so far, if it is one whole answer: exactly one NUL, at its end. */
        const wholeAnswer = (): string | undefined => {
          const answer = Buffer.concat(received, receivedBytes);
          const end = answer.indexOf(0);
          return end !== -1 && end === answer.length - 1 ? answer.subarray(0, end).toString("latin1") : undefined;
        };

        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_ANSWER_BYTES) settle(failed("CLAMAV_UNEXPECTED_ANSWER"));
        });
        // The daemon closes its side right after its one answer: that is when the answer is read.
        socket.on("end", () => {
          const answer = wholeAnswer();
          if (answer === undefined) {
            return settle(failed(receivedBytes === 0 ? "CLAMAV_CLOSED" : "CLAMAV_UNEXPECTED_ANSWER"));
          }
          const result = verdictOf(answer);
          // A verdict counts only once the whole photo was sent; a refusal may come sooner.
          if (!sent && result.verdict !== "SCAN_FAILED") return settle(failed("CLAMAV_EARLY_ANSWER"));
          settle(result);
        });
        socket.on("timeout", () => settle(failed("CLAMAV_IDLE")));
        socket.on("error", (error: NodeJS.ErrnoException) => {
          // The daemon may refuse and close while bytes are still on their way: keep its refusal's code, and
          // never a verdict cut off by an error.
          const answer = wholeAnswer();
          const refusal = answer === undefined ? undefined : verdictOf(answer);
          if (refusal?.verdict === "SCAN_FAILED") return settle(refusal);
          const code = typeof error.code === "string" && TRANSPORT_CODE.test(error.code) ? error.code : undefined;
          settle(failed(code === undefined ? "CLAMAV_UNREACHABLE" : (code as `E${string}`)));
        });
        socket.on("close", () => settle(failed("CLAMAV_CLOSED")));

        /** Writes one piece, then waits until the connection takes more; false once it is gone. */
        const write = (piece: Uint8Array): Promise<boolean> =>
          new Promise((written) => {
            if (settled || socket.destroyed || !socket.writable) return written(false);
            if (socket.write(piece)) return written(true);
            const onDrain = (): void => {
              socket.off("close", onClose);
              written(true);
            };
            const onClose = (): void => {
              socket.off("drain", onDrain);
              written(false);
            };
            socket.once("drain", onDrain);
            socket.once("close", onClose);
          });

        const send = async (): Promise<void> => {
          if (!(await write(Buffer.from("zINSTREAM\0", "latin1")))) return;
          for (let start = 0; start < data.byteLength; start += CLAMAV_CHUNK_BYTES) {
            const piece = data.subarray(start, Math.min(start + CLAMAV_CHUNK_BYTES, data.byteLength));
            const length = Buffer.alloc(4);
            length.writeUInt32BE(piece.byteLength);
            if (!(await write(length)) || !(await write(piece))) return;
          }
          if (settled || socket.destroyed || !socket.writable) return;
          socket.write(Buffer.alloc(4), (error) => {
            if (!error) sent = true;
          });
        };

        socket.once("connect", () => {
          void send();
        });
      });
    },
  };
}
