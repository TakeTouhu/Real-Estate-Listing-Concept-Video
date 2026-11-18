import type { Gaxios, GaxiosResponse } from "gaxios";

/** The metadata server, as Cloud Run names it. Never read from the environment (ADR-0158 Decision 1). */
export const METADATA_SERVER_ORIGIN = "http://metadata.google.internal";

const TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * The milliseconds the request for a token is given to be answered in full. A
 * setting of gaxios's own, which keeps the deadline; none is written here
 * (ADR-0158 Decision 4).
 */
export const GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS = 3_000;

/**
 * How long before its end a token is asked for again: less than the five
 * minutes in which the metadata server hands back the token it already holds,
 * so each new request brings a new token. Compared with the clock, it ends
 * nothing (ADR-0158 Decision 3).
 */
export const GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS = 240_000;

/** RFC 6750's b64token: nothing a header could be split by. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The token of the service account the process runs as, for Cloud Storage's requests. */
export interface AccessToken {
  /**
   * A token to send now, or `null` when none can be had. Nothing the metadata
   * server or the network does makes it reject; only a clock that throws can.
   */
  get(): Promise<string | null>;
  /** Forgets `token` if it is the one held: the store answered it `401`. */
  drop(token: string): void;
}

interface Held {
  readonly token: string;
  readonly renewAt: number;
  readonly endsAt: number;
}

/** The token an answer holds, timed from when it was asked for, or `null` when the answer is not one. */
function heldFrom(answer: GaxiosResponse<unknown>, askedAt: number): Held | null {
  // Anything else answering, such as a proxy, does not say this.
  if (answer.status !== 200 || answer.headers.get("metadata-flavor") !== "Google") return null;
  const parsed: unknown = typeof answer.data === "string" ? JSON.parse(answer.data) : null;
  if (typeof parsed !== "object" || parsed === null) return null;
  const { access_token: token, token_type: type, expires_in: seconds } = parsed as Record<string, unknown>;
  if (
    typeof token !== "string" ||
    !BEARER_TOKEN.test(token) ||
    typeof type !== "string" ||
    type.toLowerCase() !== "bearer" ||
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  ) {
    return null;
  }
  const endsAt = askedAt + seconds * 1000;
  // A token shorter-lived than twice the margin is kept for half its life.
  return { token, endsAt, renewAt: endsAt - Math.min(GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS, (seconds * 1000) / 2) };
}

/**
 * The metadata server's token, asked for when a request first needs one and
 * again once it is due, one request at a time, never through a proxy (the
 * client's agents), never followed elsewhere, and never asked again on
 * failure. A token that is due is still sent while it lasts if its renewal
 * fails (ADR-0158).
 */
export function metadataAccessToken(http: Gaxios, origin: string, now: () => Date): AccessToken {
  const url = `${origin}${TOKEN_PATH}`;
  let held: Held | undefined;
  let asking: Promise<Held | null> | undefined;

  const ask = async (): Promise<Held | null> => {
    try {
      const askedAt = now().getTime();
      const answer = await http.request<unknown>({
        url,
        headers: { "metadata-flavor": "Google" },
        responseType: "text",
        timeout: GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS,
      });
      return heldFrom(answer, askedAt);
    } catch {
      // A transport's error carries the request it failed; nothing of it is kept.
      return null;
    }
  };

  return {
    async get() {
      if (held !== undefined && now().getTime() < held.renewAt) return held.token;
      asking ??= ask().then((fresh) => {
        asking = undefined;
        if (fresh !== null) held = fresh;
        return fresh;
      });
      const fresh = await asking;
      if (fresh !== null) return fresh.token;
      return held !== undefined && now().getTime() < held.endsAt ? held.token : null;
    },
    drop(token) {
      if (held?.token === token) held = undefined;
    },
  };
}
