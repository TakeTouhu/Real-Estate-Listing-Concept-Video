import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  EMAIL_KINDS,
  EMAIL_SUBJECT_MAX_LENGTH,
  EMAIL_TEXT_MAX_LENGTH,
  isDeliverableEmailAddress,
  outgoingEmail,
  type EmailKind,
} from "./outgoing-email";

/**
 * The one place an email is made (ADR-0126): one plain recipient, a one-line
 * subject and a plain-text body, or a refusal that names neither.
 */

const VALID = {
  kind: "EMAIL_VERIFICATION" as EmailKind,
  to: "owner@example.test",
  subject: "メールアドレスの確認",
  text: "次のリンクを開いてください。\nhttps://app.example.test/verify",
};

function refusal(input: Partial<typeof VALID>): AppError {
  try {
    outgoingEmail({ ...VALID, ...input });
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the recipient", () => {
  it.each([
    "owner@example.test",
    "a@b.co",
    "first.last+tag@mail.example.co.jp",
    "o'brien@example.test",
    "x_y-z@sub-domain.example.test",
    "123@456.example",
    "user@xn--eckwd4c7c.xn--zckzah",
    `${"a".repeat(64)}@example.test`,
    `a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(60)}`,
  ])("accepts %s", (address) => {
    expect(isDeliverableEmailAddress(address)).toBe(true);
  });

  it.each([
    ["no @", "owner.example.test"],
    ["two @", "a@b@example.test"],
    ["an empty local part", "@example.test"],
    ["an empty domain", "owner@"],
    ["a one-label domain", "owner@localhost"],
    ["a space", "own er@example.test"],
    ["a header after a line break", "owner@example.test\r\nBcc: x@example.test"],
    ["a line feed", "owner@example.test\nx"],
    ["a list", "a@example.test,b@example.test"],
    ["a line break in the local part", "own\r\ner@example.test"],
    ["a header after the domain", "owner@example.test\r\nX-Injected: 1"],
    ["a carriage return alone", "owner\r@example.test"],
    ["a comma in the local part", "a,b@example.test"],
    ["a semicolon in the local part", "a;b@example.test"],
    ["a bracket in the local part", "a<b@example.test"],
    ["a display name", "Owner <owner@example.test>"],
    ["a quoted local part", '"owner"@example.test'],
    ["a leading dot", ".owner@example.test"],
    ["a trailing dot in the local part", "owner.@example.test"],
    ["two dots in a row", "own..er@example.test"],
    ["a domain label starting with a hyphen", "owner@-example.test"],
    ["a domain label ending with a hyphen", "owner@example-.test"],
    ["a trailing dot in the domain", "owner@example.test."],
    ["an empty domain label", "owner@example..test"],
    ["a domain label of 64 characters", `owner@${"b".repeat(64)}.test`],
    ["a non-ASCII local part", "所有者@example.test"],
    ["a non-ASCII domain", "owner@例え.テスト"],
    ["a local part of 65 characters", `${"a".repeat(65)}@example.test`],
    ["an address of 255 characters", `a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(61)}`],
  ])("refuses %s", (_reason, address) => {
    expect(isDeliverableEmailAddress(address)).toBe(false);
    expect(refusal({ to: address }).message).toBe("The email's recipient is not an address mail can be sent to");
  });

  it("is normalized as the product stores an address", () => {
    expect(outgoingEmail({ ...VALID, to: "  Owner@Example.TEST " }).to).toBe("owner@example.test");
    expect(isDeliverableEmailAddress("  Owner@Example.TEST ")).toBe(true);
  });
});

describe("the subject", () => {
  it("may be Japanese and as long as the limit", () => {
    const subject = "確".repeat(EMAIL_SUBJECT_MAX_LENGTH);
    expect(outgoingEmail({ ...VALID, subject }).subject).toBe(subject);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(outgoingEmail({ ...VALID, subject: "😀".repeat(EMAIL_SUBJECT_MAX_LENGTH) }).subject).toHaveLength(400);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["over the limit", "a".repeat(EMAIL_SUBJECT_MAX_LENGTH + 1)],
  ])("refuses one %s", (_reason, subject) => {
    expect(refusal({ subject }).message).toBe(
      `The email's subject must be 1 to ${EMAIL_SUBJECT_MAX_LENGTH} characters`,
    );
  });

  it.each([
    ["a carriage return and a header", "Hello\r\nBcc: x@example.test"],
    ["a line feed", "Hello\nthere"],
    ["a tab", "Hello\tthere"],
    ["a NUL", "Hello\u0000"],
    ["DEL", "Hello\u007f"],
    ["a C1 control", "Hello\u0085"],
    ["a line separator", "Hello\u2028there"],
    ["a paragraph separator", "Hello\u2029there"],
  ])("refuses one with %s", (_reason, subject) => {
    expect(refusal({ subject }).message).toBe("The email's subject must be one line with no control characters");
  });
});

describe("the text", () => {
  it("breaks lines with a line feed, and may be as long as the limit", () => {
    const text = `${"あ".repeat(EMAIL_TEXT_MAX_LENGTH - 2)}\n\n`;
    expect(outgoingEmail({ ...VALID, text }).text).toBe(text);
  });

  it.each([
    ["empty", ""],
    ["blank", " \n "],
    ["over the limit", "a".repeat(EMAIL_TEXT_MAX_LENGTH + 1)],
  ])("refuses one %s", (_reason, text) => {
    expect(refusal({ text }).message).toBe(`The email's text must be 1 to ${EMAIL_TEXT_MAX_LENGTH} characters`);
  });

  it.each([
    ["a carriage return", "line one\r\nline two"],
    ["a tab", "a\tb"],
    ["a NUL", "a\u0000b"],
    ["an escape", "a\u001b[31mb"],
    ["DEL", "a\u007fb"],
    ["a C1 control", "a\u009bb"],
  ])("refuses one with %s", (_reason, text) => {
    expect(refusal({ text }).message).toBe(
      'The email\'s text must break lines with "\\n" and hold no other control character',
    );
  });
});

describe("the email", () => {
  it.each(EMAIL_KINDS)("is made for the kind %s", (kind) => {
    expect(outgoingEmail({ ...VALID, kind })).toEqual({ ...VALID, kind });
  });

  it.each([
    ["recipient", { to: 7 }],
    ["subject", { subject: null }],
    ["text", { text: ["a"] }],
  ])("refuses a %s that is not text", (_field, change) => {
    expect(refusal(change as unknown as Partial<typeof VALID>).message).toBe(
      "The email's recipient, subject and text must each be text",
    );
  });

  it("refuses a kind the product does not send", () => {
    expect(refusal({ kind: "NEWSLETTER" as EmailKind }).message).toBe("The product sends no email of this kind");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(outgoingEmail(VALID))).toBe(true);
  });

  it("is refused with VALIDATION_FAILED, naming neither the address nor the text", () => {
    const error = refusal({ to: "secret-person@", text: "token-abc" });
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).not.toContain("secret-person");
    const textError = refusal({ text: "token-abc\r" });
    expect(textError.message).not.toContain("token-abc");
  });
});
