import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly base?: Record<string, unknown>;
  /** Sink for emitted lines. Defaults to console. Injectable for tests. */
  readonly sink?: (line: string) => void;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Minimal, dependency-free structured JSON logger. Every emitted record is
 * passed through {@link redact} so secrets and signed URLs cannot leak, even
 * if a caller accidentally includes them in `fields`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const base = options.base ?? {};
  const sink = options.sink ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());

  function emit(entry: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entry] < LEVEL_ORDER[level]) return;
    const record = {
      level: entry,
      time: now().toISOString(),
      message,
      ...(redact({ ...base, ...(fields ?? {}) }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  }

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (bindings) =>
      createLogger({ level, base: { ...base, ...bindings }, sink, now }),
  };
}
