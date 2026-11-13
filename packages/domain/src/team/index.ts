/**
 * An organization's team as its members see it (AT-5, ADR-0134): who belongs
 * to it, who is invited, and its seats; and its groups (AT-9a, ADR-0141). The
 * roles, the role-assignment ceiling, the invitations and the groups
 * themselves live in `identity`.
 */
export * from "./seats";
export * from "./members-overview";
export * from "./groups-overview";
