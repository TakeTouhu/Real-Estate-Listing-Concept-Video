import { afterEach, describe, expect, it } from "vitest";
import { loadServerEnv, resetServerEnvCache, serverEnvSchema } from "./env";

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
