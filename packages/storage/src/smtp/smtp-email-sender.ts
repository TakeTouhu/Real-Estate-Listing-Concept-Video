import { isIP } from "node:net";
import { createTransport } from "nodemailer";
import { outgoingEmail, type EmailSender, type OutgoingEmail } from "@app/domain";
import { AppError, isDnsName, isNetworkHost, isPlainEmailAddress } from "@app/shared";

/**
 * The library's own limits, in milliseconds, each of which ends the one connection of one send (ADR-0166; allowed
 * without asking, ADR-0153): reaching the server, its greeting, a DNS answer, and the quiet allowed while waiting
 * for any later reply. Nothing here keeps a deadline of its own, so a server that answers each step just inside the
 * idle limit can hold a send for minutes; a deadline for the whole send is the product owner's (TODO).
 */
export const SMTP_LIMITS_MS = Object.freeze({ connection: 10_000, greeting: 10_000, dns: 10_000, idle: 30_000 });

/** How the connection is encrypted: TLS from its first byte (port 465), or STARTTLS, required (port 587). */
export type SmtpTls = "implicit" | "starttls";

export interface SmtpEmailSenderOptions {
  /** The server's host: a DNS name or an IP address, never with a port. */
  readonly host: string;
  readonly port: number;
  readonly tls: SmtpTls;
  /** The name its certificate must carry, when that is not `host`; required when `host` is an IP address. */
  readonly servername?: string;
  readonly user: string;
  readonly password: string;
  /** The sender's address, bare, as `From` and in the envelope. */
  readonly from: string;
  /** The DNS name this side gives in `EHLO`, so no container's own name or address is sent. */
  readonly ehloName: string;
  /** For tests: the only certificate authority trusted. */
  readonly ca?: string;
  /** For tests: the library's limits, {@link SMTP_LIMITS_MS} unless given. */
  readonly limitsMs?: Partial<Record<keyof typeof SMTP_LIMITS_MS, number>>;
}

/** The library's codes that may be logged: each one word, naming no server text, address or certificate. */
const LOGGED_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "EPROTOCOL",
  "EENVELOPE",
  "EMESSAGE",
  "EAUTH",
  "ENOAUTH",
  "ECONFIG",
]);

/** Why a send failed, as one word: the library's code when it is on the list, `UNKNOWN` otherwise. */
export function smtpFailureCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOGGED_CODES.has(code) ? code : "UNKNOWN";
}

const refuse = (message: string): never => {
  throw new AppError("CONFIGURATION_ERROR", message);
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Email delivered by an SMTP server (ADR-0166), through nodemailer. Each send opens one connection, encrypted from
 * its first byte or upgraded by STARTTLS before logging in or naming anyone, with the server's certificate checked
 * whatever the process's environment says, logs in, hands over the one email and closes. No send is pooled or
 * retried, the library's logger is off, and no file or address is read for content.
 *
 * The email is checked again before anything is sent. A failure rejects with `PROVIDER_ERROR` and a fixed message
 * naming only {@link smtpFailureCode}, which its `details.smtpCode` repeats as data (ADR-0168): never the server's
 * reply, which can quote what was sent, a certificate or an address. A server may still have delivered an email
 * whose send rejected; the port says every flow tolerates that.
 *
 * Built with no connection, and nothing here starts anything by itself. The web app's adapters build one for each
 * email when `SMTP_HOST` is set (ADR-0168); the worker never does.
 */
export function createSmtpEmailSender(options: SmtpEmailSenderOptions): EmailSender {
  // No refusal repeats what was given.
  if (typeof options.host !== "string" || !isNetworkHost(options.host)) {
    refuse("The SMTP host must be a DNS name or an IP address, with no port");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    refuse("The SMTP port must be a whole number from 1 to 65535");
  }
  if (options.tls !== "implicit" && options.tls !== "starttls") {
    refuse('The SMTP encryption must be "implicit" or "starttls"');
  }
  const servername = options.servername ?? (isIP(options.host) === 0 ? options.host : undefined);
  if (servername === undefined || !isDnsName(servername)) {
    refuse("The SMTP certificate name must be a DNS name, given for an IP host");
  }
  if (!nonEmpty(options.user) || !nonEmpty(options.password)) {
    refuse("The SMTP user and password must each be given");
  }
  // Already as the product stores an address (trimmed, lower case): nothing is changed silently. The environment's
  // `EMAIL_FROM` is judged by the same rule (ADR-0167).
  if (typeof options.from !== "string" || !isPlainEmailAddress(options.from)) {
    refuse("The sender's address must be one plain address, in lower case");
  }
  if (typeof options.ehloName !== "string" || !isDnsName(options.ehloName)) {
    refuse("The SMTP EHLO name must be a DNS name");
  }
  const limits = { ...SMTP_LIMITS_MS, ...options.limitsMs };
  // Above 2^31 - 1 ms, Node would arm the library's limit for 1 ms instead.
  if (!Object.values(limits).every((value) => Number.isInteger(value) && value >= 1 && value <= 2_147_483_647)) {
    refuse("The SMTP limits must be whole numbers of milliseconds");
  }
  const from = options.from;
  const implicit = options.tls === "implicit";

  return {
    async send(email: OutgoingEmail): Promise<void> {
      // Checked again: the brand is the compiler's promise, and a cast can break it.
      const checked = outgoingEmail(email);
      const transport = createTransport({
        host: options.host,
        port: options.port,
        secure: implicit,
        // STARTTLS or nothing: never the password, or an email, in clear (measured, ADR-0166).
        requireTLS: !implicit,
        ignoreTLS: false,
        opportunisticTLS: false,
        name: options.ehloName,
        auth: { user: options.user, pass: options.password },
        // Logs in even when the server does not offer it, so the email is never handed over unnamed.
        forceAuth: true,
        tls: {
          servername,
          minVersion: "TLSv1.2",
          // Said here, so `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot turn the check off (measured, ADR-0166).
          rejectUnauthorized: true,
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        pool: false,
        connectionTimeout: limits.connection,
        greetingTimeout: limits.greeting,
        socketTimeout: limits.idle,
        dnsTimeout: limits.dns,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      try {
        await transport.sendMail({
          envelope: { from, to: [checked.to] },
          from,
          to: checked.to,
          subject: checked.subject,
          text: checked.text,
        });
      } catch (error) {
        const code = smtpFailureCode(error);
        // No cause: the library's error carries the server's reply and the certificate.
        throw new AppError("PROVIDER_ERROR", `The email was not accepted for delivery (${code})`, {
          details: { smtpCode: code },
        });
      } finally {
        transport.close();
      }
    },
  };
}
