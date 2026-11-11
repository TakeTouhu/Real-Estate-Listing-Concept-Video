/**
 * An organization's team as its members see it (AT-5, ADR-0134): who belongs
 * to it, who is invited, and its seats. The roles, the role-assignment ceiling
 * and the invitations themselves live in `identity`.
 */
export * from "./seats";
export * from "./members-overview";
