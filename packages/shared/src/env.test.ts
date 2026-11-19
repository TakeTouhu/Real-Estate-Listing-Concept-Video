import { afterEach, describe, expect, it } from "vitest";
import {
  isCloudStorageBucketName,
  isGoogleApiAddress,
  loadServerEnv,
  resetServerEnvCache,
  serverEnvSchema,
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
      "the web app would keep objects in the bucket, and the worker look for them in the folder";
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

    it("refuses a bucket beside the shared folder, which the worker reads", () => {
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

  it("coerces numeric poll settings", () => {
    const env = serverEnvSchema.parse({ ...base, WAVESPEED_POLL_INITIAL_MS: "500" });
    expect(env.WAVESPEED_POLL_INITIAL_MS).toBe(500);
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
    };
    const message = messageOf(invalid);
    expect(message).toMatch(/^Invalid server environment configuration:\n {2}- /);
    for (const name of Object.keys(invalid).filter((name) => name !== "NODE_ENV" && name !== "VIDEO_PROVIDER")) {
      expect(message).toContain(`  - ${name}: `);
    }
    expect(message).not.toContain("marker");
  });

  it("repeats a value only where the setting takes one of a fixed list of words", () => {
    const message = messageOf({ ...base, NODE_ENV: "staging", LOG_LEVEL: "loud" });
    expect(message).toContain("  - NODE_ENV: Invalid enum value.");
    expect(message).toContain("received 'staging'");
    expect(message).toContain("received 'loud'");
  });
});
