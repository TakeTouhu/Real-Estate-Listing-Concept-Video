import { DELIVERABLE_OUTPUT_CONTENT_TYPE, isDeliverableOutputKey, type ObjectByteRange } from "@app/domain";

/**
 * How the signed download route reads what it serves (ADR-0115): the one byte
 * range a request asks for, the content type of the object it names, and how a
 * download is named (ADR-0118).
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

/** Not an RFC 8187 `attr-char`, though `encodeURIComponent` leaves it as it is. */
const NOT_ATTR_CHAR = /['()*]/g;

/**
 * Not printable ASCII; or a quote or backslash, which would end or escape the
 * quoted name; or a `%`, which a browser may read as an escape in it.
 */
const NOT_PLAIN = /[^\x20-\x7e]|["%\\]/gu;

/**
 * The `Content-Disposition` of an object served as an attachment, saved under
 * `filename` (RFC 6266): the name itself as UTF-8 (RFC 8187), which every
 * current browser reads, and for one that reads only the plain form, the same
 * name with each character it cannot carry as `_`.
 *
 * The plain form is safe whatever the name. The name is one a signed token
 * carried, which `isAttachmentFilename` checked, so it is also well formed, as
 * `encodeURIComponent` needs, and holds no quote, backslash, control or line
 * break that could end the header or a value early.
 */
export function attachmentDisposition(filename: string): string {
  const plain = filename.replace(NOT_PLAIN, "_");
  const encoded = encodeURIComponent(filename).replace(
    NOT_ATTR_CHAR,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}
