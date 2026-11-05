import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  ATTACHMENT_FILENAME_MAX_BYTES,
  assertAttachmentFilename,
  isAttachmentFilename,
  replaceUnsafeFilenameCharacters,
  utf8ByteLength,
} from "./attachment-filename";

/**
 * The name a downloaded object is saved under (ADR-0118): what a signed link
 * may carry, so nothing in it can end the header it is sent in, name another
 * folder, or hide what it says.
 */

/** Every kind of character no such name holds, one of each. */
const UNSAFE = [
  "\u0000",
  "\t",
  "\n",
  "\r",
  "\u007f",
  "\u0085",
  // Invisible format characters: a zero-width space, a right-to-left override, a byte-order mark, a
  // direction isolate, a soft hyphen.
  "\u200b",
  "\u202e",
  "\ufeff",
  "\u2066",
  "\u00ad",
  "\u2028",
  "\u2029",
  // Half of a surrogate pair.
  "\ud800",
  "\udc00",
  "\\",
  "/",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
];

describe("a download's file name", () => {
  it("may hold any other character, in up to 240 bytes", () => {
    expect(ATTACHMENT_FILENAME_MAX_BYTES).toBe(240);
    for (const name of [
      "Harbour View.mp4",
      "渋谷区 3LDK マンション.mp4",
      "Café ☕ 😀.mp4",
      "50% off; 'quoted' (1), [2] {3} & #4 = ok!.mp4",
      // The joiners an emoji sequence and Persian are written with.
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467} home.mp4",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.mp4",
      "v1.2 final.mp4",
      "a",
      "a".repeat(240),
      "日".repeat(80),
      "😀".repeat(60),
    ]) {
      expect(isAttachmentFilename(name)).toBe(true);
      expect(() => assertAttachmentFilename(name)).not.toThrow();
    }
  });

  it("holds none of the unsafe characters, anywhere, nor nothing, nor more than 240 bytes", () => {
    for (const character of UNSAFE) {
      for (const name of [`${character}a.mp4`, `a${character}.mp4`, `a.mp4${character}`, character]) {
        expect(isAttachmentFilename(name)).toBe(false);
      }
    }
    for (const name of ["", "a".repeat(241), "日".repeat(80) + "a", "😀".repeat(60) + "a"]) {
      expect(isAttachmentFilename(name)).toBe(false);
    }
  });

  it("neither starts nor ends with a dot or white space", () => {
    for (const name of [".mp4", ".", "..", " ", "a.", "a ", " a.mp4", "a.mp4\u3000", "\u00a0a.mp4"]) {
      expect(isAttachmentFilename(name)).toBe(false);
    }
  });

  it("is refused as a defect, in words that do not repeat it", () => {
    const error = (() => {
      try {
        assertAttachmentFilename('secret "name"\r\n');
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INTERNAL_ERROR");
    expect((error as AppError).message).not.toContain("secret");
  });

  it("is made safe by replacing each unsafe character, and only those", () => {
    expect(replaceUnsafeFilenameCharacters(UNSAFE.join("x"), "_")).toBe(UNSAFE.map(() => "_").join("x"));
    expect(replaceUnsafeFilenameCharacters('1F/2F: "Lobby"', "-")).toBe("1F-2F- -Lobby-");
    // A whole surrogate pair is a character like any other, and the joiners stay.
    expect(replaceUnsafeFilenameCharacters("渋谷 😀 Café.", "_")).toBe("渋谷 😀 Café.");
    expect(replaceUnsafeFilenameCharacters("a\u200cb\u200dc\u200bd", "_")).toBe("a\u200cb\u200dc_d");
  });

  it("is measured in UTF-8 bytes", () => {
    expect(["a", "é", "日", "😀", ""].map(utf8ByteLength)).toEqual([1, 2, 3, 4, 0]);
  });
});
