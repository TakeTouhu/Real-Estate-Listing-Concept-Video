import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Gaxios } from "gaxios";

/**
 * The options Node.js 22 gives its own global agents: a connection is kept for
 * the next request, the one freed last is used first, and one left idle for 5
 * seconds is let go. The idle limit is the agent's own setting, and it ends no
 * request (ADR-0158 Decision 6).
 */
const CONNECTIONS = { keepAlive: true, scheduling: "lifo", timeout: 5_000 } as const;

/**
 * The connections every request of the adapter is sent on, the store's and the
 * credential's, shared in the process as Node.js's own are. They are the
 * adapter's own: gaxios sends a request given an agent straight to its origin,
 * never through a proxy a variable names, and Node.js's own proxy settings
 * reach only its global agents (ADR-0158 Decision 6).
 */
export const googleCloudStorageAgents = {
  http: new HttpAgent(CONNECTIONS),
  https: new HttpsAgent(CONNECTIONS),
} as const;

/** The adapter's client: every status is read by the caller, nothing is asked twice, and no redirect is followed. */
export function googleCloudStorageClient(): Gaxios {
  return new Gaxios({
    retry: false,
    validateStatus: () => true,
    redirect: "manual",
    agent: (url: URL) => (url.protocol === "https:" ? googleCloudStorageAgents.https : googleCloudStorageAgents.http),
  });
}
