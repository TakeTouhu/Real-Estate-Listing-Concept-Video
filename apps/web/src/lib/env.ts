import { loadServerEnv, type ServerEnv } from "@app/shared";

/**
 * Server-only environment accessor. This module (and everything it exposes)
 * must never be imported by a Client Component — doing so would risk bundling
 * secrets like WAVESPEED_API_KEY into browser code. All consumers are route
 * handlers and server components running in the Node.js runtime.
 */
let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  return (cached ??= loadServerEnv());
}
