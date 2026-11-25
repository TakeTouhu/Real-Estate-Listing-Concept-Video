import { get } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

/** Mailpit is always on this machine: no setting can point the suite, or its reads of the API, anywhere else. */
export const MAILPIT_HOST = "127.0.0.1";
/** The name in the certificate Mailpit makes for itself (`MP_SMTP_TLS_CERT=sans:mail.rd6.test`). */
export const MAILPIT_CERTIFICATE_NAME = "mail.rd6.test";

function portFrom(name: string, what: string, example: number): number {
  const raw = process.env[name];
  const port = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Set ${name} to ${what} on this machine, e.g. ${example}`);
  }
  return port;
}

/**
 * Mailpit's SMTP port, from `MAILPIT_TEST_SMTP_PORT`, and its HTTP API's, from `MAILPIT_TEST_API_PORT`. A run
 * without them fails, so CI cannot pass a suite it did not run.
 */
export const mailpitSmtpPort = (): number => portFrom("MAILPIT_TEST_SMTP_PORT", "Mailpit's SMTP port", 1025);
export const mailpitApiPort = (): number => portFrom("MAILPIT_TEST_API_PORT", "Mailpit's API port", 8025);

/** The next whole SMTP reply on `socket`: its lines, up to the one whose code is followed by a space. */
function reply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onClose = (): void => reject(new Error("Mailpit closed the connection mid-reply"));
    const onData = (chunk: Buffer): void => {
      text += chunk.toString("latin1");
      if (/(?:^|\r\n)\d{3} [^\r\n]*\r\n$/.test(text)) {
        socket.off("data", onData).off("error", reject).off("close", onClose);
        resolve(text);
      }
    };
    socket.on("data", onData).once("error", reject).once("close", onClose);
  });
}

/**
 * The certificate Mailpit made for itself, as PEM, read over STARTTLS, so the suite can trust it and nothing else.
 * It is read here without being checked, which is what makes it the one to pin: every send then checks it, and the
 * name in it, as against any server.
 */
export async function mailpitCertificate(port: number): Promise<string> {
  const socket = connectTcp({ host: MAILPIT_HOST, port });
  try {
    if (!(await reply(socket)).startsWith("220")) throw new Error("Mailpit did not greet");
    socket.write("EHLO certificate.rd6.test\r\n");
    if (!/(?:^|\r\n)250[- ]STARTTLS\r\n/.test(await reply(socket))) throw new Error("Mailpit offered no STARTTLS");
    socket.write("STARTTLS\r\n");
    if (!(await reply(socket)).startsWith("220")) throw new Error("Mailpit refused STARTTLS");
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const secure = connectTls({ socket, servername: MAILPIT_CERTIFICATE_NAME, rejectUnauthorized: false }, () => {
        resolve(secure.getPeerCertificate().raw);
        secure.end();
      });
      secure.once("error", reject);
    });
    const lines = raw.toString("base64").match(/.{1,64}/g) ?? [];
    return ["-----BEGIN CERTIFICATE-----", ...lines, "-----END CERTIFICATE-----", ""].join("\n");
  } finally {
    socket.destroy();
  }
}

function readJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get({ host: MAILPIT_HOST, port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Mailpit's API answered ${response.statusCode}`);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).once("error", reject);
  });
}

interface MailpitAddress {
  readonly Name: string;
  readonly Address: string;
}

/** The parts of one stored message the suite reads (Mailpit's `/api/v1/message/{ID}`). */
export interface MailpitMessage {
  readonly ID: string;
  readonly From: MailpitAddress;
  readonly To: readonly MailpitAddress[];
  readonly Cc: readonly MailpitAddress[] | null;
  readonly Bcc: readonly MailpitAddress[] | null;
  readonly ReplyTo: readonly MailpitAddress[] | null;
  readonly Subject: string;
  readonly Text: string;
  readonly HTML: string;
  readonly Attachments: readonly unknown[];
}

/** Every message Mailpit holds for `address`, each read in full, through its API on this machine. */
export async function messagesTo(apiPort: number, address: string): Promise<MailpitMessage[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const found = (await readJson(apiPort, `/api/v1/search?query=${query}`)) as { messages: { ID: string }[] };
  return Promise.all(
    found.messages.map(async ({ ID }) => (await readJson(apiPort, `/api/v1/message/${ID}`)) as MailpitMessage),
  );
}

/** The message exactly as Mailpit received it, headers and encoded body. */
export function rawMessage(apiPort: number, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get({ host: MAILPIT_HOST, port: apiPort, path: `/api/v1/message/${id}/raw` }, (response) => {
      let body = "";
      response.setEncoding("latin1");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode === 200) resolve(body);
        else reject(new Error(`Mailpit's API answered ${response.statusCode}`));
      });
    }).once("error", reject);
  });
}
