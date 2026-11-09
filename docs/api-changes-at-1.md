# API Changes — AT-1

The product sends email through a port, with a development outbox
(ADR-0126). **No migration, no route and no page.** One optional environment
variable is added, refused in production, and read by nothing yet.

## HTTP

No change.

## Environment

| Variable | Shape | Effect |
| --- | --- | --- |
| `EMAIL_OUTBOX_DIR` | optional; an absolute path; refused when `NODE_ENV=production` | none yet; from AT-3, the folder the web app writes its emails to instead of sending them |

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `EmailSender` | `send(email: OutgoingEmail): Promise<void>`; resolves once accepted, rejects when not |
| `outgoingEmail({ kind, to, subject, text })` | the one way to make an `OutgoingEmail` (branded, frozen); throws `VALIDATION_FAILED`, naming neither the address nor the text, for an unknown kind, an address mail cannot be sent to, a subject that is blank, over 200 characters or holds a control character or line break, or a body that is blank, over 10,000 characters or holds a control character other than `\n`; normalizes the recipient |
| `isDeliverableEmailAddress(address)` | whether an address, normalized, is one plain ASCII address: dot-atom local part of at most 64 characters, two or more DNS labels, at most 254 characters |
| `EMAIL_KINDS` | `EMAIL_VERIFICATION`, `PASSWORD_RESET`, `INVITATION` |
| `EMAIL_ADDRESS_MAX_LENGTH`, `EMAIL_LOCAL_PART_MAX_LENGTH`, `EMAIL_SUBJECT_MAX_LENGTH`, `EMAIL_TEXT_MAX_LENGTH` | 254, 64, 200, 10,000 |

### Added: `@app/storage`

| Export | Shape |
| --- | --- |
| `createDevelopmentEmailOutbox({ folder, nodeEnv?, now? })` | an `EmailSender` writing each message to its own file in an absolute folder, made private to its user if missing; throws `NonProductionAdapterError` when the given or the process's `NODE_ENV` is `production`, and `CONFIGURATION_ERROR` for a relative folder or one it cannot open (a code, never the path); `send` checks the message again and fails with `INTERNAL_ERROR` and a code when it cannot write it, leaving no file |
| `readDevelopmentEmailOutbox(folder)` | every message, oldest first, as `{ id, kind, to, subject, text, sentAt, file }`; none for a folder not made yet; fails, naming the file, on a message file the outbox did not write |
| `DEVELOPMENT_EMAIL_OUTBOX_FORMAT` | `"vtavision-development-email/1"`, the `format` of every message file |

### Unchanged on purpose

Sign-up, sign-in, invitations and every page: nothing sends an email yet.
