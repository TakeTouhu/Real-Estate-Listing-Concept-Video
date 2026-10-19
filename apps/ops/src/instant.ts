/** An instant with an explicit offset, so nobody's local time zone decides it (ADR-0066, ADR-0069). */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The instant `value` names, or `null`. Each field is checked against the
 * calendar first, because `Date` silently rolls 30 February over into March.
 */
export function parseInstant(value: string): Date | null {
  const match = INSTANT.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second = 0, offsetHours = 0, offsetMinutes = 0] = match
    .slice(1)
    .map((field) => (field === undefined ? undefined : Number(field)));
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined) {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
