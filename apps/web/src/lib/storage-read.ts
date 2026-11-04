import { DELIVERABLE_OUTPUT_CONTENT_TYPE, isDeliverableOutputKey, type ObjectByteRange } from "@app/domain";

/**
 * How the signed download route reads what it serves (ADR-0115): the one byte
 * range a request asks for, and the content type of the object it names.
 */

const RANGE = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/**
 * The single byte range a `Range` header asks for, or `null` to serve the
 * whole object: no header, another unit, several ranges, or a range that is not
 * well formed. A server may always ignore a range it does not serve (RFC 9110,
 * section 14.2), and a player asks for one at a time.
 */
export function parseRangeHeader(header: string | null): ObjectByteRange | null {
  if (header === null) return null;
  const match = RANGE.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  const start = first === "" ? null : Number(first);
  const end = last === "" ? null : Number(last);
  for (const offset of [start, end]) {
    if (offset !== null && !Number.isSafeInteger(offset)) return null;
  }
  if (start === null) return end === null ? null : { kind: "LAST", length: end };
  if (end !== null && end < start) return null;
  return { kind: "FROM", start, end };
}

/**
 * The content type an object is served with. A customer's video is named by
 * its key's shape, since its key has no extension; a photo by its extension.
 * Anything else is served as bytes, never sniffed.
 */
export function storageContentType(key: string): string {
  if (isDeliverableOutputKey(key)) return DELIVERABLE_OUTPUT_CONTENT_TYPE;
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".jpg")) return "image/jpeg";
  return "application/octet-stream";
}
