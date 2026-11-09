export {
  EMAIL_ADDRESS_MAX_LENGTH,
  EMAIL_KINDS,
  EMAIL_LOCAL_PART_MAX_LENGTH,
  EMAIL_SUBJECT_MAX_LENGTH,
  EMAIL_TEXT_MAX_LENGTH,
  isDeliverableEmailAddress,
  outgoingEmail,
} from "./outgoing-email";
export type { EmailKind, OutgoingEmail } from "./outgoing-email";
export type { EmailSender } from "./ports";
