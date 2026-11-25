import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { isPlainEmailAddress } from "./email-address";

/**
 * Server-side environment schema. This module must only ever be imported by
 * server-side code (route handlers, workers). Secrets defined here must never
 * be bundled into client code or exposed to the browser.
 */
const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/**
 * The single authoritative id of the configured WaveSpeedAI video model.
 *
 * It lives here, beside the environment schema, because that is the one place
 * both sides of the boundary can reach: `@app/video-providers` depends on
 * `@app/shared`, not the reverse, so a constant in the adapter package could
 * not supply this schema's default. Previously the id was a bare literal here
 * *and* an unused `WaveSpeedConfig.modelId` field, which let the capability
 * descriptor and the configured default drift apart silently (ADR-0019).
 *
 * This is the **default model for new admissions only**. It is emphatically not
 * the model an existing generation executes against: a persisted
 * `providerModelId` is frozen at admission and stays authoritative, so changing
 * this constant can never retarget work already admitted.
 */
export const WAVESPEED_OPEN_VIDEO_MODEL_ID = "wavespeed-ai/open-video/image-to-video";

/**
 * Google's own Cloud Storage: the one origin its adapter sends the process's
 * token to (ADR-0158 Decision 2), and the one store a production start uses,
 * named by no setting (ADR-0159). It lives here, as the model id above does:
 * the environment's rules, the web app's choice and the adapter all need it,
 * and `@app/storage` depends on `@app/shared`, not the reverse.
 */
export const GOOGLE_CLOUD_STORAGE_ORIGIN = "https://storage.googleapis.com";

/**
 * Lowercase letters, digits, `-`, `_` and `.`, 3 to 63 of them, beginning and
 * ending with a letter or a digit. Every name Cloud Storage allows of at most
 * 63 characters, and some it refuses (an address such as `192.168.5.4`, a name
 * beginning `goog`), which no bucket can have; none can reach another path.
 */
const CLOUD_STORAGE_BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/** Whether `name` can be a bucket's: the one rule the environment and the adapter share (ADR-0159). */
export function isCloudStorageBucketName(name: string): boolean {
  return CLOUD_STORAGE_BUCKET_NAME.test(name);
}

/**
 * Whether an address is at Google's API domain, `googleapis.com` or a name below it, with a final dot or not: the
 * one rule the environment and the development pipeline share (ADR-0162). An address that does not parse is not;
 * whoever reads it refuses it for that.
 */
export function isGoogleApiAddress(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const host = new URL(value).hostname.replace(/\.$/, "");
  return host === "googleapis.com" || host.endsWith(".googleapis.com");
}

/** The port a ClamAV daemon listens on unless told otherwise, as its own configuration has it (ADR-0163). */
export const CLAMAV_DEFAULT_PORT = 3310;

/** The one refusal of a ClamAV port, which repeats no value (ADR-0164). */
const CLAMAV_PORT_MESSAGE = "CLAMAV_PORT must be a whole number from 1 to 65535";

/** Whether `value` is a TCP port in plain digits, 1 to 65535, with no sign, space or leading zero (ADR-0164). */
export function isNetworkPort(value: string): boolean {
  return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65_535;
}

/** Whether `value` can name a ClamAV daemon's port: {@link isNetworkPort} (ADR-0164). */
export function isClamAvPort(value: string): boolean {
  return isNetworkPort(value);
}

/** A DNS name: labels of letters, digits and inner hyphens, 253 characters in all. An IPv4 address is one too. */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Whether `value` can name a server's host: a DNS name, an IPv4 address or an IPv6 address without brackets, and
 * nothing else, so no port, path or user rides along. The rule each network adapter and the environment share.
 */
export function isNetworkHost(value: string): boolean {
  if (HOST_NAME.test(value)) return true;
  return value.includes(":") && !/[[\]/%@\s]/.test(value) && URL.canParse(`tcp://[${value}]`);
}

/** Whether `value` can name a ClamAV daemon's host: {@link isNetworkHost} (ADR-0163, ADR-0164). */
export function isClamAvHost(value: string): boolean {
  return isNetworkHost(value);
}

/**
 * Whether `value` is a DNS name and not an IP address: what a certificate or an EHLO greeting names (ADR-0166,
 * ADR-0167). Its last label is never digits alone, as no top-level domain is, so nothing a resolver may read as an
 * address, such as `127.1`, passes.
 */
export function isDnsName(value: string): boolean {
  return isNetworkHost(value) && isIP(value) === 0 && !/(?:^|\.)[0-9]+$/.test(value);
}

/** How an SMTP connection is encrypted (ADR-0166 Decision 2): TLS from its first byte, or STARTTLS. No plain mode. */
export function isSmtpTlsMode(value: string): value is "implicit" | "starttls" {
  return value === "implicit" || value === "starttls";
}

/**
 * The SMTP server and what it is given, all or none (ADR-0167): with `SMTP_HOST`, each of the rest is required;
 * without it, none may be set. The browser test refuses every one.
 */
export const SMTP_SETTINGS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_TLS",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_EHLO_NAME",
  "EMAIL_FROM",
] as const;

/**
 * Why an address is not an http(s) origin, or null when it is: no user, path,
 * query or fragment, so nothing built on it can lead anywhere else; https in
 * production. An application base address must be one to start an emailed
 * link (ADR-0129), and an emulator's endpoint to be asked (ADR-0159).
 */
function baseUrlProblem(value: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute address";
  }
  if (url.protocol !== "https:" && (production || url.protocol !== "http:")) {
    return production ? "must use https in production" : "must use http or https";
  }
  if (url.username !== "" || url.password !== "") return "must not name a user";
  // An empty query or fragment ("?", "#") leaves the parsed URL's as "", so the text is asked.
  if (url.pathname !== "/" || /[?#]/.test(value)) {
    return "must be an origin, with no path, query or fragment";
  }
  return null;
}

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // PostgreSQL connection string for Prisma (Phase 1). Optional at build/test
    // time; required at runtime for database-backed features, and a production
    // start of the web app refuses without it (ADR-0151).
    DATABASE_URL: z.string().url().optional(),

    // Session signing secret for the web session cookie.
    SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
    HEALTHCHECK_API_TOKEN: z
      .string()
      .min(16, "HEALTHCHECK_API_TOKEN must be at least 16 characters"),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Session lifetime for authenticated user sessions (Phase 1).
    USER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // HMAC secret for short-lived, single-purpose storage URLs (Phase 2).
    STORAGE_SIGNING_SECRET: z
      .string()
      .min(16, "STORAGE_SIGNING_SECRET must be at least 16 characters"),

    // A folder on disk the web app and the worker share for stored objects,
    // in development and CI only (ADR-0085). Absolute, so both processes name
    // the same folder whatever their working directory. Unset, the web app
    // keeps objects in its own memory. Refused in production.
    SHARED_STORAGE_DIR: z.string().min(1).optional(),

    // The Cloud Storage bucket the web app keeps objects in (ADR-0159): 3 to
    // 63 lowercase letters, digits, '.', '-' or '_', beginning and ending with
    // a letter or a digit (`isCloudStorageBucketName`, the adapter's rule too).
    // Set, it is used instead of the shared folder or memory: in production,
    // Google's own store, at an origin no setting names, with the token of the
    // account the process runs as (ADR-0158); elsewhere, the emulator the
    // endpoint names. Never beside the shared folder: the web app and the
    // development pipeline keep their objects in one store (ADR-0162).
    GOOGLE_CLOUD_STORAGE_BUCKET: z.string().optional(),

    // A Cloud Storage emulator's origin, in development and CI only
    // (ADR-0159): http(s), with no path, query or fragment, and not at
    // Google's API domain. Outside production a bucket requires it, so
    // development never uses Google's own store or its token. Refused in
    // production, and refused without a bucket.
    GOOGLE_CLOUD_STORAGE_ENDPOINT: z.string().url().optional(),

    // The ClamAV daemon that scans each uploaded photo (ADR-0164): a DNS name
    // or an IP address, with no port (`isClamAvHost`, the adapter's rule too).
    // Set, the web app asks it in every environment; unset, it scans with the
    // test scanner, which a production start refuses.
    CLAMAV_HOST: z
      .string()
      .refine(isClamAvHost, "CLAMAV_HOST must be a DNS name or an IP address, with no port")
      .optional(),

    // The daemon's TCP port, 3310 unless set (ADR-0164): plain digits, kept
    // as text, so a wrong port is refused beside every other refusal rather
    // than in their place. Refused without a host, which it is read beside.
    CLAMAV_PORT: z.string().refine(isClamAvPort, CLAMAV_PORT_MESSAGE).optional(),

    // The SMTP server every email is to be handed to (ADR-0166, ADR-0167): a
    // DNS name with no port, never an IP address, since its certificate is
    // checked for this name and no setting names another. Set, each of
    // SMTP_PORT, SMTP_TLS, SMTP_USER, SMTP_PASSWORD, SMTP_EHLO_NAME and
    // EMAIL_FROM is required; unset, none may be. Never beside
    // EMAIL_OUTBOX_DIR. The seven are checked here and used by nothing yet:
    // the web app is given the SMTP sender in the next milestone.
    SMTP_HOST: z
      .string()
      .refine(isDnsName, "SMTP_HOST must be a DNS name, with no port and not an IP address")
      .optional(),
    // Its TCP port, plain digits kept as text, as CLAMAV_PORT is. No default:
    // which port goes with which encryption is the mail service's to say.
    SMTP_PORT: z.string().refine(isNetworkPort, "SMTP_PORT must be a whole number from 1 to 65535").optional(),
    // "implicit" (TLS from the first byte) or "starttls" (TLS required before
    // logging in). Text with a check, not a list of choices, so a wrong value
    // is refused beside every other refusal rather than in their place.
    SMTP_TLS: z.string().refine(isSmtpTlsMode, 'SMTP_TLS must be "implicit" or "starttls"').optional(),
    // The login, in every environment: the sender never hands an email over
    // unnamed (ADR-0166 Decision 3). A secret in production; never logged.
    SMTP_USER: z.string().min(1, "SMTP_USER must not be empty").optional(),
    SMTP_PASSWORD: z.string().min(1, "SMTP_PASSWORD must not be empty").optional(),
    // The DNS name this side gives in EHLO, so no container's own name or
    // address is sent (ADR-0166 Decision 6).
    SMTP_EHLO_NAME: z.string().refine(isDnsName, "SMTP_EHLO_NAME must be a DNS name, not an IP address").optional(),
    // The sender, as From and in the envelope: one plain address in lower
    // case with no display name, so nothing about it is changed silently.
    EMAIL_FROM: z
      .string()
      .refine(isPlainEmailAddress, "EMAIL_FROM must be one plain address, in lower case, with no name")
      .optional(),

    // The folder the product's emails are written to instead of being sent,
    // in development and CI only (ADR-0126). Absolute, for the same reason as
    // the shared folder. Unset, the web app sends no email (ADR-0129).
    // Refused in production, and beside SMTP_HOST.
    EMAIL_OUTBOX_DIR: z.string().min(1).optional(),

    // The web app's own address, which every link it emails starts with
    // (ADR-0129): an http(s) origin with no path, query or fragment, https in
    // production. Never taken from a request. Optional because the worker
    // shares this schema and emails nothing; unset, the web app emails no link,
    // and a production start of the web app refuses (ADR-0151).
    APP_BASE_URL: z.string().url().optional(),

    // AES-256-GCM key sealing MFA secrets at rest: 32 bytes as 64 hex
    // characters (ADR-0065). Optional because the worker shares this schema
    // and never needs it; the web app fails closed without it (Decision 14),
    // and a production start of the web app refuses (ADR-0151).
    MFA_SECRET_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "MFA_SECRET_KEY must be 32 bytes as 64 hex characters")
      .optional(),

    // Image-analysis provider selection. Phase 3 ships the deterministic
    // offline adapter only; no real vision vendor is integrated (ADR-0009).
    ANALYSIS_PROVIDER: z.enum(["deterministic"]).default("deterministic"),

    // Video provider selection. Phase 0 defaults to the fake adapter and must
    // never call the real WaveSpeedAI API.
    VIDEO_PROVIDER: z.enum(["fake", "wavespeed"]).default("fake"),

    // WaveSpeedAI configuration (server-side only; optional while provider=fake).
    WAVESPEED_API_KEY: z.string().min(1).optional(),
    WAVESPEED_API_BASE_URL: z.string().url().default("https://api.wavespeed.ai/api/v3"),
    WAVESPEED_VIDEO_MODEL_ID: z.string().min(1).default(WAVESPEED_OPEN_VIDEO_MODEL_ID),
    WAVESPEED_WEBHOOK_SECRET: z.string().min(1).optional(),
    WAVESPEED_POLL_INITIAL_MS: z.coerce.number().int().positive().default(2000),
    WAVESPEED_POLL_MAX_MS: z.coerce.number().int().positive().default(15000),
    WAVESPEED_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),

    // Node.js's own debug output, read only to be refused in production
    // (ADR-0159). Naming `https`, or matching it as `*` or `h*` do, it writes
    // each new connection's request, its token included, to the error output
    // (ADR-0158 Decision 6). Node.js reads it once, as the process starts, so
    // nothing can turn it off later: a start is refused instead.
    NODE_DEBUG: z.string().optional(),

    // Node.js's own switch for checking certificates, read only to be refused
    // in production (ADR-0167). Set to 0, it turns the check off for every
    // connection that does not ask for it itself, so a client could send its
    // token or password to a server nobody checked (measured, ADR-0166).
    NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    LOG_PRETTY: booleanish.default("false"),
  })
  .superRefine((env, ctx) => {
    if (env.SHARED_STORAGE_DIR !== undefined) {
      if (!isAbsolute(env.SHARED_STORAGE_DIR)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SHARED_STORAGE_DIR"],
          message: "SHARED_STORAGE_DIR must be an absolute path",
        });
      }
      if (env.NODE_ENV === "production") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SHARED_STORAGE_DIR"],
          message: "SHARED_STORAGE_DIR is for development and CI only; it must not be set in production",
        });
      }
    }

    if (env.EMAIL_OUTBOX_DIR !== undefined) {
      if (!isAbsolute(env.EMAIL_OUTBOX_DIR)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["EMAIL_OUTBOX_DIR"],
          message: "EMAIL_OUTBOX_DIR must be an absolute path",
        });
      }
      if (env.NODE_ENV === "production") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["EMAIL_OUTBOX_DIR"],
          message: "EMAIL_OUTBOX_DIR is for development and CI only; it must not be set in production",
        });
      }
    }

    const bucket = env.GOOGLE_CLOUD_STORAGE_BUCKET;
    const endpoint = env.GOOGLE_CLOUD_STORAGE_ENDPOINT;
    const production = env.NODE_ENV === "production";
    const storageIssue = (name: "BUCKET" | "ENDPOINT", message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [`GOOGLE_CLOUD_STORAGE_${name}`], message });
    if (bucket !== undefined) {
      if (!isCloudStorageBucketName(bucket)) {
        storageIssue(
          "BUCKET",
          "GOOGLE_CLOUD_STORAGE_BUCKET must be 3 to 63 lowercase letters, digits, '.', '-' or '_', " +
            "beginning and ending with a letter or a digit",
        );
      }
      if (env.SHARED_STORAGE_DIR !== undefined) {
        storageIssue(
          "BUCKET",
          "GOOGLE_CLOUD_STORAGE_BUCKET and SHARED_STORAGE_DIR must not both be set: " +
            "the web app and the development pipeline keep their objects in one store",
        );
      }
      if (endpoint === undefined && !production) {
        storageIssue(
          "ENDPOINT",
          "GOOGLE_CLOUD_STORAGE_ENDPOINT must name an emulator when GOOGLE_CLOUD_STORAGE_BUCKET is set " +
            "outside production: only production uses Google's own store",
        );
      }
    }
    if (endpoint !== undefined) {
      const problem = baseUrlProblem(endpoint, false);
      if (problem !== null) storageIssue("ENDPOINT", `GOOGLE_CLOUD_STORAGE_ENDPOINT ${problem}`);
      if (production) {
        storageIssue(
          "ENDPOINT",
          "GOOGLE_CLOUD_STORAGE_ENDPOINT is for development and CI only; it must not be set in production",
        );
      } else if (problem === null && isGoogleApiAddress(endpoint)) {
        storageIssue(
          "ENDPOINT",
          "GOOGLE_CLOUD_STORAGE_ENDPOINT must name an emulator, not Google's own API domain: " +
            "only production uses Google's own store",
        );
      }
      if (bucket === undefined) {
        storageIssue("BUCKET", "GOOGLE_CLOUD_STORAGE_BUCKET is required when GOOGLE_CLOUD_STORAGE_ENDPOINT is set");
      }
    }

    // No ClamAV message repeats a value, which the start check prints (ADR-0164).
    if (env.CLAMAV_PORT !== undefined && env.CLAMAV_HOST === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAMAV_PORT"],
        message: "CLAMAV_HOST is required when CLAMAV_PORT is set",
      });
    }

    // No SMTP message repeats a value, which the start check prints (ADR-0167).
    const smtpIssue = (path: string, message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    for (const name of SMTP_SETTINGS.slice(1)) {
      if (env.SMTP_HOST === undefined && env[name] !== undefined) {
        smtpIssue(name, `SMTP_HOST is required when ${name} is set`);
      }
      if (env.SMTP_HOST !== undefined && env[name] === undefined) {
        smtpIssue(name, `${name} is required when SMTP_HOST is set`);
      }
    }
    if (env.SMTP_HOST !== undefined && env.EMAIL_OUTBOX_DIR !== undefined) {
      smtpIssue(
        "SMTP_HOST",
        "SMTP_HOST and EMAIL_OUTBOX_DIR must not both be set: the web app sends each email one way",
      );
    }

    // Any value: which names write what is Node.js's to change. An empty value names nothing.
    if (production && (env.NODE_DEBUG ?? "") !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NODE_DEBUG"],
        message:
          "NODE_DEBUG must not be set in production: " +
          "Node.js would write requests, their tokens included, to the error output",
      });
    }
    // Any value, as NODE_DEBUG: how Node.js reads it is Node.js's to change. An empty value names nothing.
    if (production && (env.NODE_TLS_REJECT_UNAUTHORIZED ?? "") !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NODE_TLS_REJECT_UNAUTHORIZED"],
        message:
          "NODE_TLS_REJECT_UNAUTHORIZED must not be set in production: " +
          "Node.js would let a connection skip checking the server's certificate",
      });
    }

    if (env.APP_BASE_URL !== undefined) {
      const problem = baseUrlProblem(env.APP_BASE_URL, env.NODE_ENV === "production");
      if (problem !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_BASE_URL"], message: `APP_BASE_URL ${problem}` });
      }
    }

    if (env.VIDEO_PROVIDER === "wavespeed" && !env.WAVESPEED_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WAVESPEED_API_KEY"],
        message: "WAVESPEED_API_KEY is required when VIDEO_PROVIDER=wavespeed",
      });
    }

    // One production model identity, enforced at configuration resolution.
    //
    // The variable stays for compatibility, but it may only *restate* the
    // supported model — it cannot select a different one. Without this, setting
    // it to another id split the system in two: the self-check exercised the
    // configured model while admission validated against OpenVideo's
    // capabilities and froze OpenVideo's id onto the row, so a later submission
    // would have paid OpenVideo for work the operator configured elsewhere.
    //
    // Failing closed here rather than at first use means a misconfigured
    // deployment cannot start and admit anything at all. Supporting a genuinely
    // different model needs its own verified capability descriptor, which is a
    // deliberate future decision, not an environment override (ADR-0019).
    if (env.WAVESPEED_VIDEO_MODEL_ID !== WAVESPEED_OPEN_VIDEO_MODEL_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WAVESPEED_VIDEO_MODEL_ID"],
        message:
          `WAVESPEED_VIDEO_MODEL_ID must be "${WAVESPEED_OPEN_VIDEO_MODEL_ID}". ` +
          "Selecting a different model requires a verified capability descriptor for it; " +
          "an environment override cannot switch models.",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Parse and validate server environment. Throws a readable error listing all
 * invalid/missing variables. The parsed result is cached per process.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clear the cached environment so it can be re-parsed. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
