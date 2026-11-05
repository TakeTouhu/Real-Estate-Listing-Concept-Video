import { AppError } from "@app/shared";

/**
 * The name a downloaded object is saved under (ADR-0118). A signed download
 * link may carry one; the route then serves the object as an attachment under
 * that name rather than showing it in the browser.
 */

/**
 * The longest such name, in UTF-8 bytes: within the 255 bytes most file
 * systems allow a file's name.
 */
export const ATTACHMENT_FILENAME_MAX_BYTES = 240;

/**
 * What no such name holds: a control, an invisible format character, a line
 * or paragraph separator, half of a surrogate pair, or a character a file
 * system or the header reserves. The zero-width joiner and non-joiner are
 * kept: emoji sequences and several scripts are written with them, and
 * neither reorders text as a direction control does.
 */
const UNSAFE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\\/:*?"<>|]|(?![\u200c\u200d])\p{Cf}/u;

/** A dot or white space at a name's start or end: a hidden file, or a name a file system trims. */
const LOOSE_END = /^[\s.]|[\s.]$/u;

/** The text with each character no such name holds replaced. */
export function replaceUnsafeFilenameCharacters(text: string, replacement: string): string {
  return text.replace(new RegExp(UNSAFE.source, "gu"), replacement);
}

/** The bytes a name takes in UTF-8. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * `true` when a signed link may carry the name: some characters, none of them
 * unsafe, neither end a dot or white space, in at most
 * {@link ATTACHMENT_FILENAME_MAX_BYTES} bytes. The verifier ignores a token
 * whose name is not.
 */
export function isAttachmentFilename(name: string): boolean {
  return (
    name.length > 0 &&
    !UNSAFE.test(name) &&
    !LOOSE_END.test(name) &&
    utf8ByteLength(name) <= ATTACHMENT_FILENAME_MAX_BYTES
  );
}

/**
 * Throws unless a signed link may carry the name. The signer calls this before
 * it signs one. Every name is made by the application, so reaching it is a
 * defect in the caller: an internal error, whose message names no name.
 */
export function assertAttachmentFilename(name: string): void {
  if (!isAttachmentFilename(name)) {
    throw new AppError("INTERNAL_ERROR", "A download's file name must be safe to send");
  }
}
