/**
 * An organization's team as its members see it (AT-5, ADR-0134): who belongs
 * to it, who is invited, and its seats; its groups (AT-9a, ADR-0141); and what
 * each member may do, and why (AT-11a, ADR-0146). The roles, the
 * role-assignment ceiling, the invitations, the groups and the grants
 * themselves live in `identity`.
 */
export * from "./seats";
export * from "./members-overview";
export * from "./groups-overview";
export * from "./member-permissions";
