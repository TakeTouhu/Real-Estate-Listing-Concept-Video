import { describe, expect, it } from "vitest";
import { clientAddressKey, type ClientAddress, type ClientAddressUnavailable } from "./client-address";

/** The client-address key (ADR-0170): each row is a header, how many entries are trusted, and the answer. */
const keyOf = (header: string | null, trusted: number | undefined): ClientAddress =>
  clientAddressKey(new Headers(header === null ? {} : { "x-forwarded-for": header }), trusted);

const key = (text: string): ClientAddress => ({ kind: "key", key: text });
const none = (reason: ClientAddressUnavailable): ClientAddress => ({ kind: "none", reason });

/** The balancer's own entry, which a Google load balancer writes last. */
const LB = "34.120.0.1";

describe("clientAddressKey", () => {
  it.each<[string | null, number | undefined, ClientAddress]>([
    // The cases measured for the design (ip-and-http.md, section 1.6).
    [null, 1, none("MISSING")],
    [`203.0.113.7, ${LB}`, 2, key("v4:203.0.113.7")],
    [`1.1.1.1, 203.0.113.7, ${LB}`, 2, key("v4:203.0.113.7")],
    ["203.0.113.7", 2, none("SHORT_CHAIN")],
    [`2001:DB8:aa:bb:1:2:3:4, ${LB}`, 2, key("v6:2001:db8:aa:bb::/64")],
    [`2001:db8:aa:bb:ffff::9, ${LB}`, 2, key("v6:2001:db8:aa:bb::/64")],
    // Only ::ffff:0:0/96 is folded: ffff in the sixth group behind a prefix, or the translated form, stays a /64.
    [`2001:db8:aa:bb::ffff:c633:6404, ${LB}`, 2, key("v6:2001:db8:aa:bb::/64")],
    [`2001:db8:aa:bb:0:ffff:198.51.100.4, ${LB}`, 2, key("v6:2001:db8:aa:bb::/64")],
    [`::ffff:0:198.51.100.4, ${LB}`, 2, key("v6:0:0:0:0::/64")],
    [`::ffff:198.51.100.4, ${LB}`, 2, key("v4:198.51.100.4")],
    [`::ffff:c633:6404, ${LB}`, 2, key("v4:198.51.100.4")],
    [`203.0.113.7:5555, ${LB}`, 2, none("MALFORMED")],
    [`[2001:db8::1], ${LB}`, 2, none("MALFORMED")],
    [`fe80::1%eth0, ${LB}`, 2, none("MALFORMED")],
    [`unknown, ${LB}`, 2, none("MALFORMED")],
    [`, ${LB}`, 2, none("MALFORMED")],
    [`203.0.113.7, ${LB}`, 0, none("NOT_CONFIGURED")],
    [null, 0, none("NOT_CONFIGURED")],
    // Unset is the same as 0: no entry is trusted.
    [`203.0.113.7, ${LB}`, undefined, none("NOT_CONFIGURED")],
    // One trusted entry: the right-most, here the only one.
    ["203.0.113.7", 1, key("v4:203.0.113.7")],
    [`198.51.100.4, 203.0.113.7`, 1, key("v4:203.0.113.7")],
    // As many as the setting allows (5), with the client left of them; the setting refuses more.
    [`192.0.2.1, 203.0.113.7, 10.0.0.1, 10.0.0.2, 10.0.0.3, ${LB}`, 5, key("v4:203.0.113.7")],
    [`10.0.0.1, 10.0.0.2, 10.0.0.3, ${LB}`, 5, none("SHORT_CHAIN")],
    // Spaces around entries are not part of them.
    [`   203.0.113.7  ,${LB}   `, 2, key("v4:203.0.113.7")],
    ["", 1, none("MALFORMED")],
    // The hex IPv4-mapped form in capitals, and other IPv6 forms.
    [`::FFFF:C633:6404, ${LB}`, 2, key("v4:198.51.100.4")],
    [`2001:0DB8:00AA:00BB:0000:0000:0000:0001, ${LB}`, 2, key("v6:2001:db8:aa:bb::/64")],
    [`::1, ${LB}`, 2, key("v6:0:0:0:0::/64")],
    [`::, ${LB}`, 2, key("v6:0:0:0:0::/64")],
    [`2001:db8::, ${LB}`, 2, key("v6:2001:db8:0:0::/64")],
    [`64:ff9b::198.51.100.4, ${LB}`, 2, key("v6:64:ff9b:0:0::/64")],
    [`0:0:0:0:0:ffff:198.51.100.4, ${LB}`, 2, key("v4:198.51.100.4")],
    [`203.0.113.07, ${LB}`, 2, none("MALFORMED")],
    [`203.0.113.7.5, ${LB}`, 2, none("MALFORMED")],
  ])("reads %j, trusting %j entries, as %j", (header, trusted, expected) => {
    expect(keyOf(header, trusted)).toEqual(expected);
  });

  it("reads only the entry the setting names, so an earlier forged one changes nothing", () => {
    const forged = `${Array.from({ length: 50 }, (_, i) => `192.0.2.${i}`).join(", ")}, 203.0.113.7, ${LB}`;
    expect(keyOf(forged, 2)).toEqual(key("v4:203.0.113.7"));
    expect(keyOf(`unknown, [::1]:80, 203.0.113.7, ${LB}`, 2)).toEqual(key("v4:203.0.113.7"));
  });

  it("reads two header lines as one list, as Headers joins them", () => {
    const headers = new Headers();
    headers.append("x-forwarded-for", "203.0.113.7");
    headers.append("x-forwarded-for", LB);
    expect(clientAddressKey(headers, 2)).toEqual(key("v4:203.0.113.7"));
  });
});
