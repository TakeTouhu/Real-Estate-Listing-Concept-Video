import { afterEach, describe, expect, it } from "vitest";
import {
  isCloudStorageBucketName,
  isClamAvHost,
  isClamAvPort,
  isDnsName,
  isGoogleApiAddress,
  isNetworkHost,
  isNetworkPort,
  isSmtpTlsMode,
  isRateLimitValue,
  loadServerEnv,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_SETTINGS,
  resetServerEnvCache,
  serverEnvSchema,
  SMTP_SETTINGS,
} from "./env";

const base = {
  SESSION_SECRET: "session-secret-abcdef123456",
  HEALTHCHECK_API_TOKEN: "healthcheck-token-abcdef123456",
  STORAGE_SIGNING_SECRET: "storage-signing-secret-abc",
};

describe("serverEnvSchema", () => {
  it("applies documented defaults for the fake provider", () => {
    const env = serverEnvSchema.parse(base);
    expect(env.VIDEO_PROVIDER).toBe("fake");
    expect(env.WAVESPEED_API_BASE_URL).toBe("https://api.wavespeed.ai/api/v3");
    expect(env.WAVESPEED_VIDEO_MODEL_ID).toBe("wavespeed-ai/open-video/image-to-video");
    expect(env.SESSION_TTL_SECONDS).toBe(3600);
  });

  it("does not require a WaveSpeedAI key while provider=fake", () => {
    expect(serverEnvSchema.safeParse(base).success).toBe(true);
  });

  it("requires WAVESPEED_API_KEY when provider=wavespeed", () => {
    const result = serverEnvSchema.safeParse({ ...base, VIDEO_PROVIDER: "wavespeed" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("WAVESPEED_API_KEY"))).toBe(true);
    }
  });

  it("rejects short secrets", () => {
    expect(serverEnvSchema.safeParse({ ...base, SESSION_SECRET: "short" }).success).toBe(false);
  });

  it("accepts MFA_SECRET_KEY only as 32 bytes of hex, and does not require it", () => {
    expect(serverEnvSchema.parse(base).MFA_SECRET_KEY).toBeUndefined();
    expect(serverEnvSchema.safeParse({ ...base, MFA_SECRET_KEY: "ab".repeat(32) }).success).toBe(true);
    for (const bad of ["", "ab".repeat(31), "ab".repeat(33), "zz".repeat(32)]) {
      expect(serverEnvSchema.safeParse({ ...base, MFA_SECRET_KEY: bad }).success).toBe(false);
    }
  });

  it("accepts SHARED_STORAGE_DIR only as an absolute path outside production", () => {
    expect(serverEnvSchema.parse(base).SHARED_STORAGE_DIR).toBeUndefined();
    const dir = "/var/tmp/vtavision-storage";
    expect(serverEnvSchema.parse({ ...base, SHARED_STORAGE_DIR: dir }).SHARED_STORAGE_DIR).toBe(dir);
    for (const NODE_ENV of ["development", "test"]) {
      const env = { ...base, NODE_ENV, SHARED_STORAGE_DIR: dir };
      expect(serverEnvSchema.safeParse(env).success).toBe(true);
    }
    for (const bad of [
      { SHARED_STORAGE_DIR: "" },
      { SHARED_STORAGE_DIR: "relative/storage" },
      { SHARED_STORAGE_DIR: dir, NODE_ENV: "production" },
    ]) {
      const result = serverEnvSchema.safeParse({ ...base, ...bad });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
      expect(new Set(paths)).toEqual(new Set(["SHARED_STORAGE_DIR"]));
    }
    expect(serverEnvSchema.safeParse({ ...base, NODE_ENV: "production" }).success).toBe(true);
  });

  it("accepts EMAIL_OUTBOX_DIR only as an absolute path outside production", () => {
    expect(serverEnvSchema.parse(base).EMAIL_OUTBOX_DIR).toBeUndefined();
    const dir = "/var/tmp/vtavision-outbox";
    for (const NODE_ENV of ["development", "test"]) {
      expect(serverEnvSchema.parse({ ...base, NODE_ENV, EMAIL_OUTBOX_DIR: dir }).EMAIL_OUTBOX_DIR).toBe(dir);
    }
    for (const bad of [
      { EMAIL_OUTBOX_DIR: "" },
      { EMAIL_OUTBOX_DIR: "relative/outbox" },
      { EMAIL_OUTBOX_DIR: dir, NODE_ENV: "production" },
    ]) {
      const result = serverEnvSchema.safeParse({ ...base, ...bad });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
      expect(new Set(paths)).toEqual(new Set(["EMAIL_OUTBOX_DIR"]));
    }
  });

  it("accepts APP_BASE_URL only as an http(s) origin, https in production, and does not require it", () => {
    expect(serverEnvSchema.parse(base).APP_BASE_URL).toBeUndefined();
    expect(serverEnvSchema.parse({ ...base, NODE_ENV: "production" }).APP_BASE_URL).toBeUndefined();
    for (const good of ["http://localhost:3210", "https://app.example.com", "https://app.example.com/"]) {
      expect(serverEnvSchema.parse({ ...base, APP_BASE_URL: good }).APP_BASE_URL).toBe(good);
    }
    const production = { ...base, NODE_ENV: "production", APP_BASE_URL: "https://app.example.com" };
    expect(serverEnvSchema.safeParse(production).success).toBe(true);
    const notOrigin = "APP_BASE_URL must be an origin, with no path, query or fragment";
    const refused: [Record<string, string>, string][] = [
      [{ APP_BASE_URL: "" }, "Invalid url"],
      [{ APP_BASE_URL: "app.example.com" }, "Invalid url"],
      [{ APP_BASE_URL: "ftp://app.example.com" }, "APP_BASE_URL must use http or https"],
      [{ APP_BASE_URL: "javascript:alert(1)" }, "APP_BASE_URL must use http or https"],
      [{ APP_BASE_URL: "http://app.example.com", NODE_ENV: "production" }, "APP_BASE_URL must use https in production"],
      [{ APP_BASE_URL: "https://user:pw@app.example.com" }, "APP_BASE_URL must not name a user"],
      [{ APP_BASE_URL: "https://user@app.example.com" }, "APP_BASE_URL must not name a user"],
      [{ APP_BASE_URL: "https://app.example.com/app" }, notOrigin],
      [{ APP_BASE_URL: "https://app.example.com/?a=1" }, notOrigin],
      [{ APP_BASE_URL: "https://app.example.com?" }, notOrigin],
      [{ APP_BASE_URL: "https://app.example.com#top" }, notOrigin],
      [{ APP_BASE_URL: "https://app.example.com#" }, notOrigin],
    ];
    for (const [bad, message] of refused) {
      const result = serverEnvSchema.safeParse({ ...base, ...bad });
      expect(result.success).toBe(false);
      const issues = result.success ? [] : result.error.issues;
      expect(new Set(issues.map((i) => i.path.join(".")))).toEqual(new Set(["APP_BASE_URL"]));
      expect(issues.map((i) => i.message)).toContain(message);
    }
  });

  describe("Google Cloud Storage (ADR-0159)", () => {
    const BUCKET = "vtavision-objects";
    const EMULATOR = "http://127.0.0.1:4443";
    const NAMING =
      "GOOGLE_CLOUD_STORAGE_BUCKET must be 3 to 63 lowercase letters, digits, '.', '-' or '_', " +
      "beginning and ending with a letter or a digit";
    const NEEDS_EMULATOR =
      "GOOGLE_CLOUD_STORAGE_ENDPOINT must name an emulator when GOOGLE_CLOUD_STORAGE_BUCKET is set " +
      "outside production: only production uses Google's own store";
    const NOT_GOOGLE =
      "GOOGLE_CLOUD_STORAGE_ENDPOINT must name an emulator, not Google's own API domain: " +
      "only production uses Google's own store";
    const IN_PRODUCTION =
      "GOOGLE_CLOUD_STORAGE_ENDPOINT is for development and CI only; it must not be set in production";
    const NEEDS_BUCKET = "GOOGLE_CLOUD_STORAGE_BUCKET is required when GOOGLE_CLOUD_STORAGE_ENDPOINT is set";
    const WITH_FOLDER =
      "GOOGLE_CLOUD_STORAGE_BUCKET and SHARED_STORAGE_DIR must not both be set: " +
      "the web app and the development pipeline keep their objects in one store";
    const NOT_ORIGIN = "GOOGLE_CLOUD_STORAGE_ENDPOINT must be an origin, with no path, query or fragment";

    /** Each issue as `path: message`, or none when the environment is accepted. */
    const issuesOf = (settings: Record<string, string>): string[] => {
      const result = serverEnvSchema.safeParse({ ...base, ...settings });
      return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };

    it("takes neither by default, in development and in production", () => {
      for (const NODE_ENV of ["development", "test", "production"]) {
        const env = serverEnvSchema.parse({ ...base, NODE_ENV });
        expect([env.GOOGLE_CLOUD_STORAGE_BUCKET, env.GOOGLE_CLOUD_STORAGE_ENDPOINT]).toEqual([undefined, undefined]);
      }
    });

    it("takes a bucket alone in production, and a bucket with an emulator's origin elsewhere", () => {
      const production = { ...base, NODE_ENV: "production", GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET };
      expect(serverEnvSchema.parse(production).GOOGLE_CLOUD_STORAGE_BUCKET).toBe(BUCKET);
      for (const NODE_ENV of ["development", "test"]) {
        for (const endpoint of [EMULATOR, "http://localhost:4443/", "https://[::1]:4443", "http://gcs.example.test"]) {
          const settings = { NODE_ENV, GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET, GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint };
          expect(issuesOf(settings)).toEqual([]);
        }
      }
    });

    it("names a bucket by the shared rule, the adapter's own", () => {
      for (const good of ["abc", "a-b_c.d", "0bucket9", "a".repeat(63), "goog-is-refused-by-google-not-here"]) {
        expect(isCloudStorageBucketName(good)).toBe(true);
        expect(issuesOf({ NODE_ENV: "production", GOOGLE_CLOUD_STORAGE_BUCKET: good })).toEqual([]);
      }
      const bad = ["", "ab", "a".repeat(64), "Bucket", "aBc", "abC", "-abc", "abc-", "a/b", "a b", "abc%2F", "abc\n"];
      for (const name of bad) {
        expect(isCloudStorageBucketName(name)).toBe(false);
        expect(issuesOf({ NODE_ENV: "production", GOOGLE_CLOUD_STORAGE_BUCKET: name })).toEqual([
          `GOOGLE_CLOUD_STORAGE_BUCKET: ${NAMING}`,
        ]);
      }
    });

    it("refuses a bucket without an emulator outside production, where Google's own store is never used", () => {
      for (const NODE_ENV of ["development", "test"]) {
        expect(issuesOf({ NODE_ENV, GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET })).toEqual([
          `GOOGLE_CLOUD_STORAGE_ENDPOINT: ${NEEDS_EMULATOR}`,
        ]);
      }
    });

    it("refuses an endpoint at Google's API domain outside production, however it is written", () => {
      for (const google of [
        "https://storage.googleapis.com",
        "https://STORAGE.googleapis.com:443/",
        "http://storage.googleapis.com",
        "https://storage.googleapis.com.",
        "https://storage.asia-northeast1.rep.googleapis.com",
        "https://googleapis.com",
      ]) {
        const settings = { NODE_ENV: "development", GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET };
        expect(issuesOf({ ...settings, GOOGLE_CLOUD_STORAGE_ENDPOINT: google })).toEqual([
          `GOOGLE_CLOUD_STORAGE_ENDPOINT: ${NOT_GOOGLE}`,
        ]);
      }
      for (const near of ["https://storage.googleapis.com.example.test", "http://notgoogleapis.com"]) {
        expect(issuesOf({ GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET, GOOGLE_CLOUD_STORAGE_ENDPOINT: near })).toEqual([]);
      }
    });

    it("shares its rule for Google's API domain, which answers for any text (ADR-0162)", () => {
      expect(isGoogleApiAddress("https://storage.googleapis.com.")).toBe(true);
      expect(isGoogleApiAddress("https://storage%2Egoogleapis.com")).toBe(true);
      expect(isGoogleApiAddress("http://notgoogleapis.com")).toBe(false);
      // An address that does not parse is refused by whoever reads it, not taken for Google's.
      for (const text of ["", "storage.googleapis.com", "not a url"]) expect(isGoogleApiAddress(text)).toBe(false);
    });

    it("refuses an endpoint in production, Google's own included", () => {
      for (const endpoint of [EMULATOR, "https://storage.googleapis.com"]) {
        const settings = { NODE_ENV: "production", GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET };
        expect(issuesOf({ ...settings, GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint })).toEqual([
          `GOOGLE_CLOUD_STORAGE_ENDPOINT: ${IN_PRODUCTION}`,
        ]);
      }
    });

    it("takes an endpoint only as an http(s) origin, and only with a bucket", () => {
      const refused: [string, string[]][] = [
        ["", ["Invalid url", "GOOGLE_CLOUD_STORAGE_ENDPOINT must be an absolute address"]],
        ["127.0.0.1:4443", ["Invalid url", "GOOGLE_CLOUD_STORAGE_ENDPOINT must be an absolute address"]],
        ["localhost:4443", ["GOOGLE_CLOUD_STORAGE_ENDPOINT must use http or https"]],
        ["ftp://127.0.0.1:4443", ["GOOGLE_CLOUD_STORAGE_ENDPOINT must use http or https"]],
        ["http://user:pw@127.0.0.1:4443", ["GOOGLE_CLOUD_STORAGE_ENDPOINT must not name a user"]],
        ["http://127.0.0.1:4443/storage/v1", [NOT_ORIGIN]],
        ["http://127.0.0.1:4443?", [NOT_ORIGIN]],
        ["http://127.0.0.1:4443/#", [NOT_ORIGIN]],
      ];
      for (const [endpoint, messages] of refused) {
        const issues = issuesOf({ GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET, GOOGLE_CLOUD_STORAGE_ENDPOINT: endpoint });
        expect(issues).toEqual(messages.map((message) => `GOOGLE_CLOUD_STORAGE_ENDPOINT: ${message}`));
      }
      for (const NODE_ENV of ["development", "production"]) {
        const issues = issuesOf({ NODE_ENV, GOOGLE_CLOUD_STORAGE_ENDPOINT: EMULATOR });
        expect(issues).toContain(`GOOGLE_CLOUD_STORAGE_BUCKET: ${NEEDS_BUCKET}`);
      }
    });

    it("refuses a bucket beside the shared folder: the web app and the pipeline keep one store", () => {
      const folder = { SHARED_STORAGE_DIR: "/var/tmp/vtavision-storage", GOOGLE_CLOUD_STORAGE_BUCKET: BUCKET };
      expect(issuesOf({ ...folder, GOOGLE_CLOUD_STORAGE_ENDPOINT: EMULATOR })).toEqual([
        `GOOGLE_CLOUD_STORAGE_BUCKET: ${WITH_FOLDER}`,
      ]);
    });
  });

  it("refuses NODE_DEBUG in production, whatever it names, and leaves it alone elsewhere (ADR-0159)", () => {
    const line = "NODE_DEBUG: NODE_DEBUG must not be set in production: " +
      "Node.js would write requests, their tokens included, to the error output";
    for (const value of ["https", "HTTPS", "foo,https", "*", "h*", "*s", "http", "net", "tls", " "]) {
      const result = serverEnvSchema.safeParse({ ...base, NODE_ENV: "production", NODE_DEBUG: value });
      const issues = result.success ? [] : result.error.issues;
      expect(issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([line]);
      for (const NODE_ENV of ["development", "test"]) {
        expect(serverEnvSchema.safeParse({ ...base, NODE_ENV, NODE_DEBUG: value }).success).toBe(true);
      }
    }
    expect(serverEnvSchema.safeParse({ ...base, NODE_ENV: "production", NODE_DEBUG: "" }).success).toBe(true);
  });

  it("takes a ClamAV host and port, and refuses either by a message that repeats neither (ADR-0164)", () => {
    const issuesOf = (settings: Record<string, string>): string[] => {
      const result = serverEnvSchema.safeParse({ ...base, ...settings });
      return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    expect(serverEnvSchema.parse({ ...base, CLAMAV_HOST: "clamav" })).toMatchObject({ CLAMAV_HOST: "clamav" });
    expect(serverEnvSchema.parse({ ...base, CLAMAV_HOST: "clamav" }).CLAMAV_PORT).toBeUndefined();
    for (const [CLAMAV_HOST, port] of [["127.0.0.1", "1"], ["fd00::7", "3310"], ["clamav.internal", "65535"]]) {
      const env = serverEnvSchema.parse({ ...base, NODE_ENV: "production", CLAMAV_HOST, CLAMAV_PORT: port });
      expect([env.CLAMAV_HOST, env.CLAMAV_PORT]).toEqual([CLAMAV_HOST, port]);
    }
    const badHost = "CLAMAV_HOST: CLAMAV_HOST must be a DNS name or an IP address, with no port";
    for (const host of ["", "clamav:3310", "tcp://clamav", "[::1]", "clam av", "user@clamav"]) {
      expect(issuesOf({ CLAMAV_HOST: host })).toEqual([badHost]);
    }
    const badPort = "CLAMAV_PORT: CLAMAV_PORT must be a whole number from 1 to 65535";
    const ports = ["", "0", "65536", "99999", "999999", "abc", "3310.5", "03310", " 3310", "0x0cee", "1e3", "-1"];
    for (const port of [...ports, "\uff13\uff13\uff11\uff10"]) {
      expect(issuesOf({ CLAMAV_HOST: "clamav", CLAMAV_PORT: port })).toEqual([badPort]);
    }
    const needsHost = "CLAMAV_PORT: CLAMAV_HOST is required when CLAMAV_PORT is set";
    expect(issuesOf({ CLAMAV_PORT: "3310" })).toEqual([needsHost]);
    // A wrong port is refused beside the other refusals, and hides none of them.
    expect(issuesOf({ CLAMAV_PORT: "0" })).toEqual([badPort, needsHost]);
    expect(issuesOf({ CLAMAV_HOST: "clamav", CLAMAV_PORT: "0", SHARED_STORAGE_DIR: "relative" })).toEqual([
      badPort,
      "SHARED_STORAGE_DIR: SHARED_STORAGE_DIR must be an absolute path",
    ]);
  });

  describe("SMTP (ADR-0167)", () => {
    /** All seven, valid. Throwaway values: the password is not a secret. */
    const SMTP = {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_TLS: "starttls",
      SMTP_USER: "smtp-user",
      SMTP_PASSWORD: "smtp-password-not-a-secret",
      SMTP_EHLO_NAME: "app.example.com",
      EMAIL_FROM: "noreply@example.com",
    };
    const issuesOf = (settings: Record<string, string>): string[] => {
      const result = serverEnvSchema.safeParse({ ...base, ...settings });
      return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    const BAD_HOST = "SMTP_HOST must be a DNS name, with no port and not an IP address";
    /** The seven, with `name` taken out. */
    const without = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(SMTP).filter(([key]) => key !== name));

    it("names its seven settings in SMTP_SETTINGS, in order, which the browser test refuses", () => {
      const keys = Object.keys(serverEnvSchema.innerType().shape);
      expect(keys.filter((key) => key.startsWith("SMTP_") || key === "EMAIL_FROM")).toEqual([...SMTP_SETTINGS]);
      expect(Object.keys(SMTP)).toEqual([...SMTP_SETTINGS]);
    });

    it("takes none by default, and all seven together in every environment, the port kept as text", () => {
      const none = serverEnvSchema.parse({ ...base, NODE_ENV: "production" });
      for (const name of SMTP_SETTINGS) expect(none[name]).toBeUndefined();
      for (const NODE_ENV of ["development", "test", "production"]) {
        for (const [SMTP_TLS, SMTP_PORT] of [["starttls", "587"], ["implicit", "465"]]) {
          const settings = { ...SMTP, SMTP_TLS, SMTP_PORT };
          expect(serverEnvSchema.parse({ ...base, NODE_ENV, ...settings })).toMatchObject(settings);
        }
      }
    });

    it("refuses each setting that is not what it names, by a message that repeats no value", () => {
      const refused: [string, string[], string][] = [
        ["SMTP_HOST", ["", "smtp.example.com:587", "smtp://smtp.example.com", "user@smtp.example.com"], BAD_HOST],
        ["SMTP_HOST", ["smtp example", "127.0.0.1", "127.1", "0x7f000001", "::1", "[::1]"], BAD_HOST],
        [
          "SMTP_PORT",
          ["", "0", "65536", "99999", "abc", "587.5", "0587", " 587", "0x24b", "1e3", "-1", "５８７"],
          "SMTP_PORT must be a whole number from 1 to 65535",
        ],
        ["SMTP_TLS", ["", "none", "tls", "STARTTLS", "ssl"], 'SMTP_TLS must be "implicit" or "starttls"'],
        ["SMTP_USER", [""], "SMTP_USER must not be empty"],
        ["SMTP_PASSWORD", [""], "SMTP_PASSWORD must not be empty"],
        [
          "SMTP_EHLO_NAME",
          ["", "127.0.0.1", "127.1", "0127.0.0.1", "1.0x1", "app name", "app\r\nRCPT TO:<x@y.z>"],
          "SMTP_EHLO_NAME must be a DNS name, not an IP address",
        ],
        [
          "EMAIL_FROM",
          ["", "VTaVision <noreply@example.com>", "NoReply@example.com", " noreply@example.com"],
          "EMAIL_FROM must be one plain address, in lower case, with no name",
        ],
        [
          "EMAIL_FROM",
          ["noreply@example.com ", "noreply", "a@b@example.com", "noreply@localhost"],
          "EMAIL_FROM must be one plain address, in lower case, with no name",
        ],
      ];
      // Each beside the other six, valid, so its own line is the only one.
      for (const [name, values, message] of refused) {
        for (const value of values) expect(issuesOf({ ...SMTP, [name]: value })).toEqual([`${name}: ${message}`]);
      }
    });

    it("takes all seven or none: each of the six needs the host, and the host needs each of them", () => {
      for (const name of SMTP_SETTINGS.slice(1)) {
        expect(issuesOf({ [name]: SMTP[name] })).toEqual([`${name}: SMTP_HOST is required when ${name} is set`]);
        expect(issuesOf(without(name))).toEqual([`${name}: ${name} is required when SMTP_HOST is set`]);
      }
      expect(issuesOf({ SMTP_HOST: SMTP.SMTP_HOST })).toEqual(
        SMTP_SETTINGS.slice(1).map((name) => `${name}: ${name} is required when SMTP_HOST is set`),
      );
    });

    it("refuses the host beside the outbox folder: the web app sends each email one way", () => {
      const both =
        "SMTP_HOST: SMTP_HOST and EMAIL_OUTBOX_DIR must not both be set: the web app sends each email one way";
      const outbox = { ...SMTP, EMAIL_OUTBOX_DIR: "/var/tmp/vtavision-outbox" };
      expect(issuesOf(outbox)).toEqual([both]);
      expect(issuesOf({ ...outbox, NODE_ENV: "production" })).toEqual([
        "EMAIL_OUTBOX_DIR: EMAIL_OUTBOX_DIR is for development and CI only; it must not be set in production",
        both,
      ]);
    });

    it("refuses a wrong mode beside the other refusals, and hides none of them", () => {
      expect(issuesOf({ ...without("EMAIL_FROM"), SMTP_TLS: "tls", SHARED_STORAGE_DIR: "relative" })).toEqual([
        'SMTP_TLS: SMTP_TLS must be "implicit" or "starttls"',
        "SHARED_STORAGE_DIR: SHARED_STORAGE_DIR must be an absolute path",
        "EMAIL_FROM: EMAIL_FROM is required when SMTP_HOST is set",
      ]);
    });
  });

  describe("the abuse limits (ADR-0170)", () => {
    const issuesOf = (settings: Record<string, string>): string[] => {
      const result = serverEnvSchema.safeParse({ ...base, ...settings });
      return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };

    it("names its settings in RATE_LIMIT_SETTINGS, in order, each with a default", () => {
      const keys = Object.keys(serverEnvSchema.innerType().shape);
      expect(keys.filter((key) => key.startsWith("RATE_LIMIT_"))).toEqual([...RATE_LIMIT_SETTINGS]);
      expect(Object.keys(RATE_LIMIT_DEFAULTS)).toEqual([...RATE_LIMIT_SETTINGS]);
      expect(RATE_LIMIT_DEFAULTS).toEqual({
        RATE_LIMIT_SIGN_IN: "5/900",
        RATE_LIMIT_MFA_CODE: "5/900",
        RATE_LIMIT_PASSWORD_RESET_EMAIL: "3/3600",
        RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP: "20/3600",
        RATE_LIMIT_VERIFICATION_EMAIL: "3/3600",
        RATE_LIMIT_SIGN_UP_PER_IP: "60/3600",
        RATE_LIMIT_UPLOAD: "1000/86400",
        RATE_LIMIT_INVITATION: "50/86400",
      });
      expect(Object.isFrozen(RATE_LIMIT_DEFAULTS)).toBe(true);
    });

    it("takes the defaults when unset, and any count/seconds in range, in every environment", () => {
      for (const NODE_ENV of ["development", "test", "production"]) {
        expect(serverEnvSchema.parse({ ...base, NODE_ENV })).toMatchObject(RATE_LIMIT_DEFAULTS);
        for (const value of ["1/1", "99999/999999", "10/60"]) {
          const all = Object.fromEntries(RATE_LIMIT_SETTINGS.map((name) => [name, value]));
          expect(serverEnvSchema.parse({ ...base, NODE_ENV, ...all })).toMatchObject(all);
        }
      }
    });

    it("refuses each setting out of form or range, by a message that repeats no value", () => {
      const bad = ["", "0/900", "5/0", "5", "off", "5/900/3600", " 5/900", "5 /900", "05/900", "5/0900", "100000/1"];
      for (const value of [...bad, "1/1000000", "5.0/900", "-5/900", "5/-900", "1e3/900", "0x5/900", "\uff15/900"]) {
        expect(isRateLimitValue(value)).toBe(false);
        for (const name of RATE_LIMIT_SETTINGS) {
          const line = `${name}: ${name} must be count/seconds: 1 to 99999 hits in 1 to 999999 seconds`;
          expect(issuesOf({ [name]: value })).toEqual([line]);
        }
      }
    });

    it("takes the trusted entries of X-Forwarded-For as text from 1 to 5, and none by default", () => {
      expect(serverEnvSchema.parse({ ...base, NODE_ENV: "production" }).FORWARDED_FOR_TRUSTED_ENTRIES).toBeUndefined();
      for (const value of ["1", "2", "3", "4", "5"]) {
        expect(serverEnvSchema.parse({ ...base, FORWARDED_FOR_TRUSTED_ENTRIES: value })).toMatchObject({
          FORWARDED_FOR_TRUSTED_ENTRIES: value,
        });
      }
      const line = "FORWARDED_FOR_TRUSTED_ENTRIES: FORWARDED_FOR_TRUSTED_ENTRIES must be a whole number from 1 to 5";
      for (const value of ["", "0", "6", "10", "01", " 2", "2 ", "2.0", "-1", "two", "\uff12"]) {
        expect(issuesOf({ FORWARDED_FOR_TRUSTED_ENTRIES: value })).toEqual([line]);
      }
    });
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED in production, whatever it holds, and leaves it alone elsewhere", () => {
    const line = "NODE_TLS_REJECT_UNAUTHORIZED: NODE_TLS_REJECT_UNAUTHORIZED must not be set in production: " +
      "Node.js would let a connection skip checking the server's certificate";
    for (const value of ["0", "1", "false", " "]) {
      const switched = { ...base, NODE_TLS_REJECT_UNAUTHORIZED: value };
      const result = serverEnvSchema.safeParse({ ...switched, NODE_ENV: "production" });
      const issues = result.success ? [] : result.error.issues;
      expect(issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([line]);
      for (const NODE_ENV of ["development", "test"]) {
        expect(serverEnvSchema.safeParse({ ...switched, NODE_ENV }).success).toBe(true);
      }
    }
    const empty = { ...base, NODE_ENV: "production", NODE_TLS_REJECT_UNAUTHORIZED: "" };
    expect(serverEnvSchema.safeParse(empty).success).toBe(true);
  });

  it("coerces numeric poll settings", () => {
    const env = serverEnvSchema.parse({ ...base, WAVESPEED_POLL_INITIAL_MS: "500" });
    expect(env.WAVESPEED_POLL_INITIAL_MS).toBe(500);
  });
});

describe("isClamAvHost", () => {
  it("takes a DNS name, an IPv4 address or an unbracketed IPv6 address, and nothing that carries more", () => {
    const hosts = ["clamav", "clamav.internal", "a-b.c", "127.0.0.1", "10.0.0.7", "::1", "fd00::7", "2001:db8::1"];
    for (const host of hosts) expect(isClamAvHost(host)).toBe(true);
    const others = [
      ...["", " ", "clamav:3310", "tcp://clamav", "clamav/scan", "user@clamav", "clam av", "clamav "],
      ...["-clamav", "clamav-", "clamav..internal", "[::1]", "[::1]:3310", "fe80::1%eth0", "1:2", ":::"],
      `${"a".repeat(64)}.internal`,
      `${"a.".repeat(127)}ab`,
    ];
    for (const host of others) expect(isClamAvHost(host)).toBe(false);
    for (const value of [...hosts, ...others]) expect(isNetworkHost(value)).toBe(isClamAvHost(value));
  });
});

describe("the shared port, name and mode rules", () => {
  it("takes a port in plain digits from 1 to 65535, ClamAV's by the same rule", () => {
    const ports = ["1", "25", "465", "587", "3310", "65535", "", "0", "65536", "0587", " 587", "587 ", "+587", "5e2"];
    for (const port of ports.slice(0, 6)) expect(isNetworkPort(port)).toBe(true);
    for (const port of ports.slice(6)) expect(isNetworkPort(port)).toBe(false);
    for (const port of ports) expect(isClamAvPort(port)).toBe(isNetworkPort(port));
  });

  it("takes a DNS name, and no IP address, nothing an address could be read from, port or space", () => {
    for (const name of ["smtp.example.com", "mail", "xn--eckwd4c7c.example", "123.example.com", "0xa.example"]) {
      expect(isDnsName(name)).toBe(true);
    }
    const addressLike = ["127.1", "0127.0.0.1", "1.2.3.4.5", "2130706433", "mail.123", "0x7f000001", "1.0X1", "a.0x"];
    for (const value of ["", "127.0.0.1", "10.0.0.7", "::1", "fd00::7", "[::1]", "smtp.example.com:587", "a b", "-a"]) {
      expect(isDnsName(value)).toBe(false);
    }
    // A number in the last label, in digits or hex: no top-level domain is, and a URL parser reads an address.
    for (const value of addressLike) {
      expect(isDnsName(value)).toBe(false);
    }
  });

  it("takes the two encryption modes, exactly as written", () => {
    expect(["implicit", "starttls"].every(isSmtpTlsMode)).toBe(true);
    for (const value of ["", "none", "tls", "ssl", "Implicit", "STARTTLS", " starttls"]) {
      expect(isSmtpTlsMode(value)).toBe(false);
    }
  });
});

describe("loadServerEnv", () => {
  afterEach(() => resetServerEnvCache());

  const messageOf = (source: Record<string, string>): string => {
    try {
      loadServerEnv(source);
    } catch (error) {
      return error instanceof Error ? error.message : "";
    }
    return "";
  };

  it("names each invalid variable and what is wrong with it, and repeats none of their values", () => {
    // Every setting that holds a secret, an address or a path, each invalid and each carrying a marker.
    const invalid = {
      NODE_ENV: "production",
      DATABASE_URL: "marker-not-an-address",
      SESSION_SECRET: "marker-short",
      HEALTHCHECK_API_TOKEN: "marker-tiny",
      STORAGE_SIGNING_SECRET: "marker-brief",
      SHARED_STORAGE_DIR: "marker/relative",
      EMAIL_OUTBOX_DIR: "marker/relative",
      APP_BASE_URL: "http://marker.example.com/path",
      GOOGLE_CLOUD_STORAGE_BUCKET: "marker_Bad",
      GOOGLE_CLOUD_STORAGE_ENDPOINT: "http://marker.example.com/path",
      NODE_DEBUG: "marker,https",
      MFA_SECRET_KEY: "marker-not-hex",
      VIDEO_PROVIDER: "wavespeed",
      WAVESPEED_API_KEY: "",
      WAVESPEED_API_BASE_URL: "marker-not-an-address",
      WAVESPEED_VIDEO_MODEL_ID: "marker/another-model",
      WAVESPEED_WEBHOOK_SECRET: "",
      SMTP_HOST: "marker-host:25",
      SMTP_PORT: "marker",
      SMTP_TLS: "marker",
      SMTP_USER: "marker-user",
      SMTP_PASSWORD: "marker-password",
      SMTP_EHLO_NAME: "marker name",
      EMAIL_FROM: "marker <x@example.com>",
      NODE_TLS_REJECT_UNAUTHORIZED: "marker",
      RATE_LIMIT_SIGN_IN: "marker/900",
      RATE_LIMIT_MFA_CODE: "5/marker",
      RATE_LIMIT_PASSWORD_RESET_EMAIL: "marker",
      RATE_LIMIT_PASSWORD_RESET_EMAIL_PER_IP: "20/3600 marker",
      RATE_LIMIT_VERIFICATION_EMAIL: "marker 3/3600",
      RATE_LIMIT_SIGN_UP_PER_IP: "60/marker",
      RATE_LIMIT_UPLOAD: "marker/86400",
      RATE_LIMIT_INVITATION: "50/marker",
      FORWARDED_FOR_TRUSTED_ENTRIES: "marker",
    };
    // The login is valid beside a host, so it has no line of its own, and still must not be repeated.
    const valid = new Set(["NODE_ENV", "VIDEO_PROVIDER", "SMTP_USER", "SMTP_PASSWORD"]);
    const message = messageOf(invalid);
    expect(message).toMatch(/^Invalid server environment configuration:\n {2}- /);
    for (const name of Object.keys(invalid).filter((name) => !valid.has(name))) {
      expect(message).toContain(`  - ${name}: `);
    }
    expect(message).not.toContain("marker");
  });

  it("names the SMTP login when it is set without a host, and repeats neither value", () => {
    const message = messageOf({ ...base, SMTP_USER: "marker-user", SMTP_PASSWORD: "marker-password" });
    expect(message).toContain("  - SMTP_USER: SMTP_HOST is required when SMTP_USER is set");
    expect(message).toContain("  - SMTP_PASSWORD: SMTP_HOST is required when SMTP_PASSWORD is set");
    expect(message).not.toContain("marker");
  });

  it("repeats a value only where the setting takes one of a fixed list of words", () => {
    const message = messageOf({ ...base, NODE_ENV: "staging", LOG_LEVEL: "loud" });
    expect(message).toContain("  - NODE_ENV: Invalid enum value.");
    expect(message).toContain("received 'staging'");
    expect(message).toContain("received 'loud'");
  });
});
