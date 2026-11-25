import { isIP } from "node:net";

/** Why a request has no client-address key (ADR-0170). Each is logged by its code alone (RD-7d). */
export type ClientAddressUnavailable = "NOT_CONFIGURED" | "MISSING" | "SHORT_CHAIN" | "MALFORMED";

/** A request's client-address key, or why it has none. */
export type ClientAddress =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "none"; readonly reason: ClientAddressUnavailable };

const none = (reason: ClientAddressUnavailable): ClientAddress => ({ kind: "none", reason });

/** An IPv6 address's eight groups, as numbers. `address` is one `isIP` reads as IPv6, so it has no zone. */
function ipv6Groups(address: string): number[] {
  let text = address;
  // A dotted IPv4 tail is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const groupsOf = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

/**
 * The key a request's client address is counted by (ADR-0170): the entry of
 * `X-Forwarded-For` that many from its right end as `trustedEntries`, the
 * ones our own infrastructure writes. Only a bare IP address is taken: an
 * IPv4 address as written, an IPv4-mapped IPv6 address as its IPv4 address,
 * and any other IPv6 address by its /64. Nothing else is guessed at, and no
 * request shares a key for want of one. It logs nothing.
 */
export function clientAddressKey(headers: Pick<Headers, "get">, trustedEntries: number | undefined): ClientAddress {
  if (trustedEntries === undefined || !Number.isSafeInteger(trustedEntries) || trustedEntries < 1) {
    return none("NOT_CONFIGURED");
  }
  const header = headers.get("x-forwarded-for");
  if (header === null) return none("MISSING");
  const entries = header.split(",").map((entry) => entry.trim());
  if (entries.length < trustedEntries) return none("SHORT_CHAIN");
  const entry = entries[entries.length - trustedEntries] ?? "";
  // A zone names an interface of the sender's own machine.
  if (entry.includes("%")) return none("MALFORMED");
  const version = isIP(entry);
  if (version === 4) return { kind: "key", key: `v4:${entry}` };
  if (version !== 6) return none("MALFORMED");
  const groups = ipv6Groups(entry);
  const [g6 = 0, g7 = 0] = groups.slice(6);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { kind: "key", key: `v4:${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}` };
  }
  return { kind: "key", key: `v6:${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64` };
}
