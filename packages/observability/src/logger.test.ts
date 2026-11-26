import { describe, expect, it } from "vitest";
import { createLogger, type LoggerOptions } from "./logger";
import { REDACTED } from "./redact";

const TIME = "2026-11-26T01:34:18.803Z";

/** A logger whose lines are kept as written, at a fixed time. */
function capture(options: Omit<LoggerOptions, "sink" | "now"> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ ...options, sink: (line) => lines.push(line), now: () => new Date(TIME) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

/** Every key Cloud Logging reads from a JSON line into the entry, with `level`, the name before. */
const RESERVED = [
  "severity",
  "level",
  "message",
  "time",
  "timestamp",
  "timestampSeconds",
  "timestampNanos",
  "httpRequest",
  "logging.googleapis.com/trace",
  "logging.googleapis.com/labels",
  "logging.googleapis.com/x",
];
const injected = Object.fromEntries(RESERVED.map((key) => [key, "from-a-field"]));

describe("createLogger", () => {
  it("names each level by Cloud Logging's exact upper-case severity", () => {
    const { logger, parsed } = capture({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(parsed().map((line) => line.severity)).toEqual(["DEBUG", "INFO", "WARNING", "ERROR"]);
    expect(parsed().every((line) => !("level" in line))).toBe(true);
  });

  it("starts each line with severity, time and message, then the fields in the caller's order", () => {
    const { logger, lines } = capture({ base: { component: "readiness" } });
    logger.warn("A readiness probe did not answer", { probe: "database", code: "P1001" });
    expect(lines).toEqual([
      `{"severity":"WARNING","time":"${TIME}","message":"A readiness probe did not answer",` +
        `"component":"readiness","probe":"database","code":"P1001"}`,
    ]);
  });

  it("keeps the caller's order when a reserved key sits between two fields", () => {
    const { logger, lines } = capture();
    logger.info("m", { probe: "database", severity: "x", code: "P1001", time: "y", route: "r" });
    expect(lines[0]).toContain('"message":"m","probe":"database","code":"P1001","route":"r"}');
  });

  it.each([
    ["fields", (options: LoggerOptions) => createLogger(options), injected],
    ["base", (options: LoggerOptions) => createLogger({ ...options, base: injected }), {}],
    ["a child binding", (options: LoggerOptions) => createLogger(options).child(injected), {}],
  ] as const)("drops every reserved key from %s, keeping its own severity, time and message", (_, make, fields) => {
    const lines: string[] = [];
    const logger = make({ sink: (line) => lines.push(line), now: () => new Date(TIME) });
    logger.error("the logger's own message", { ...fields, component: "request" });
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      severity: "ERROR",
      time: TIME,
      message: "the logger's own message",
      component: "request",
    });
  });

  it("drops every reserved key from base, a child, its child and fields at once", () => {
    const lines: string[] = [];
    const root = createLogger({
      base: { ...injected, b1: 1 },
      sink: (line) => lines.push(line),
      now: () => new Date(TIME),
    });
    root.child({ ...injected, c1: 2 }).child({ ...injected, c2: 3 }).warn("own", { ...injected, f1: 4 });
    expect(lines).toEqual([`{"severity":"WARNING","time":"${TIME}","message":"own","b1":1,"c1":2,"c2":3,"f1":4}`]);
  });

  it("keeps the rate limiter's code, action and dimension together, as CI counts them", () => {
    const { logger, lines } = capture({ base: { component: "rate-limit" } });
    logger.warn("refused", { code: "RATE_LIMITED", severity: "x", action: "SIGN_IN", dimension: "client" });
    expect(lines[0]).toContain('"code":"RATE_LIMITED","action":"SIGN_IN","dimension":"client"');
  });

  it("keeps a key that only looks like a reserved one", () => {
    const { logger, parsed } = capture();
    logger.info("m", { Severity: "a", messageId: "b", log: "c", "logging.googleapis.com": "d", levels: "e" });
    expect(parsed()[0]).toMatchObject({ Severity: "a", messageId: "b", log: "c", "logging.googleapis.com": "d" });
    expect(parsed()[0]).toMatchObject({ levels: "e", severity: "INFO" });
  });

  it("still filters by the threshold", () => {
    const { logger, parsed } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(parsed().map((line) => line.message)).toEqual(["w", "e"]);
    const { logger: byDefault, parsed: atInfo } = capture();
    byDefault.debug("d");
    byDefault.info("i");
    expect(atInfo().map((line) => line.severity)).toEqual(["INFO"]);
  });

  it("writes one JSON line per call, with no line break inside it", () => {
    const { logger, lines } = capture();
    logger.info("first\nsecond", { note: "a\nb" });
    logger.warn("third");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });

  it("passes a message that is itself a URL through redact, and leaves a plain message as written", () => {
    const { logger, parsed } = capture();
    logger.info("https://storage.example.com/o/key?X-Goog-Signature=abc");
    logger.info("https://user:pw@h.test/a");
    logger.info("Fetched https://h.test/a?sig=1 once");
    expect(parsed().map((line) => line.message)).toEqual([
      `https://storage.example.com/o/key?${REDACTED}`,
      "https://h.test/a",
      "Fetched https://h.test/a?sig=1 once",
    ]);
    expect(Object.keys(parsed()[0] ?? {})).toEqual(["severity", "time", "message"]);
  });

  it("still passes the fields, base and bindings through redact", () => {
    const { logger, parsed } = capture({ base: { apiKey: "sk-base" } });
    logger.child({ webhookSecret: "shh" }).info("m", {
      link: "https://storage.example.com/o/key?X-Goog-Signature=abc",
      nested: { accessToken: "t", safe: "ok" },
    });
    expect(parsed()[0]).toEqual({
      severity: "INFO",
      time: TIME,
      message: "m",
      apiKey: REDACTED,
      webhookSecret: REDACTED,
      link: `https://storage.example.com/o/key?${REDACTED}`,
      nested: { accessToken: REDACTED, safe: "ok" },
    });
  });
});
