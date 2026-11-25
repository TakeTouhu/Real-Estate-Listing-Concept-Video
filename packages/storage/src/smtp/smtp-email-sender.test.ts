import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createServer as createTlsServer } from "node:tls";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outgoingEmail, type OutgoingEmail } from "@app/domain";
import { AppError } from "@app/shared";
import { createSmtpEmailSender, smtpFailureCode, type SmtpEmailSenderOptions } from "./smtp-email-sender";

/** A certificate authority, and a server certificate it signed for `mail.rd6.test`, made for this run alone. */
let pki: { readonly ca: string; readonly otherCa: string; readonly key: string; readonly cert: string };
let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "rd6-smtp-"));
  const at = (name: string): string => join(folder, name);
  const openssl = (...args: string[]): void => {
    execFileSync("openssl", args, { cwd: folder, stdio: "ignore" });
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  for (const name of ["ca", "other-ca"]) {
    const subject = ["-subj", `/CN=${name}.rd6.test`];
    openssl("req", "-x509", ...ec, "-keyout", at(`${name}.key`), "-out", at(`${name}.pem`), "-days", "1", ...subject);
  }
  writeFileSync(at("ext.cnf"), "subjectAltName=DNS:mail.rd6.test\n");
  openssl("req", ...ec, "-keyout", at("server.key"), "-out", at("server.csr"), "-subj", "/CN=mail.rd6.test");
  openssl("x509", "-req", "-in", at("server.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"),
    "-CAcreateserial", "-out", at("server.pem"), "-days", "1", "-extfile", at("ext.cnf"));
  pki = {
    ca: readFileSync(at("ca.pem"), "utf8"),
    otherCa: readFileSync(at("other-ca.pem"), "utf8"),
    key: readFileSync(at("server.key"), "utf8"),
    cert: readFileSync(at("server.pem"), "utf8"),
  };
}, 30_000);

afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** One line the stand-in read, and whether it came over TLS. */
interface Heard {
  readonly line: string;
  readonly overTls: boolean;
}

interface StandIn {
  readonly port: number;
  /** Every command line read, in order, on every connection. */
  readonly heard: Heard[];
  /** Each message's bytes as they came, dot-stuffing included, up to its final dot. */
  readonly messages: string[];
  connections(): number;
  close(): Promise<void>;
}

interface Behaviour {
  /** TLS from the first byte; otherwise plain until STARTTLS. */
  readonly implicit?: boolean;
  /** Whether EHLO offers STARTTLS on a plain connection. */
  readonly offerStartTls?: boolean;
  /** Whether EHLO offers AUTH. */
  readonly offerAuth?: boolean;
  /** A reply to send instead of the usual one, `"SILENT"` for none, or `"DESTROY"` to drop the connection. */
  readonly onCommand?: (line: string) => string | undefined;
  /** The reply to the final dot, or `"DESTROY"`. */
  readonly afterData?: string;
}

/** A stand-in SMTP server on 127.0.0.1 that speaks just enough for the adapter, and records what it heard. */
async function standIn(behaviour: Behaviour = {}): Promise<StandIn> {
  const heard: Heard[] = [];
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const converse = (raw: Socket, overTlsAtStart: boolean): void => {
    let socket: Socket = raw;
    let overTls = overTlsAtStart;
    let buffer = "";
    let data: string | null = null;
    const say = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (data !== null) {
          data += buffer;
          buffer = "";
          const end = data.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push(data.slice(2, end + 2));
          buffer = data.slice(end + 5);
          data = null;
          if (behaviour.afterData === "DESTROY") return void socket.destroy();
          say(behaviour.afterData ?? "250 2.0.0 queued");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        heard.push({ line, overTls });
        const custom = behaviour.onCommand?.(line);
        if (custom === "SILENT") continue;
        if (custom === "DESTROY") return void socket.destroy();
        if (custom !== undefined) {
          say(custom);
          continue;
        }
        const verb = line.split(" ")[0]?.toUpperCase();
        if (verb === "EHLO") {
          const offers = ["mail.rd6.test", ...(behaviour.offerAuth === false ? [] : ["AUTH PLAIN LOGIN"]), "8BITMIME"];
          if (!overTls && behaviour.offerStartTls !== false) offers.push("STARTTLS");
          offers.forEach((offer, i) => say(`250${i === offers.length - 1 ? " " : "-"}${offer}`));
        } else if (verb === "STARTTLS" && !overTls && behaviour.offerStartTls !== false) {
          say("220 2.0.0 ready");
          socket.off("data", onData);
          const secured = new TLSSocket(socket, { isServer: true, key: pki.key, cert: pki.cert });
          secured.on("error", () => undefined);
          sockets.add(secured);
          socket = secured;
          overTls = true;
          buffer = "";
          secured.on("data", onData);
        } else if (verb === "AUTH") say("235 2.7.0 accepted");
        else if (verb === "MAIL" || verb === "RCPT") say("250 2.1.0 ok");
        else if (verb === "DATA") {
          say("354 go ahead");
          data = "\r\n";
        } else if (verb === "QUIT") {
          say("221 2.0.0 bye");
          socket.end();
        } else say("502 5.5.1 not here");
      }
    };
    socket.on("data", onData);
    say("220 mail.rd6.test ESMTP");
  };

  const accept = (socket: Socket, overTls: boolean): void => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    converse(socket, overTls);
  };
  const server = behaviour.implicit
    ? createTlsServer({ key: pki.key, cert: pki.cert }, (socket) => accept(socket, true))
    : createServer((socket) => accept(socket, false));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    heard,
    messages,
    connections: () => connections,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

const PASSWORD = "pw-7f3a9c-not-a-secret";

const options = (port: number, overrides: Partial<SmtpEmailSenderOptions> = {}): SmtpEmailSenderOptions => ({
  host: "127.0.0.1",
  port,
  tls: "starttls",
  servername: "mail.rd6.test",
  user: "sender",
  password: PASSWORD,
  from: "noreply@rd6.test",
  ehloName: "app.rd6.test",
  ca: pki.ca,
  limitsMs: { connection: 2_000, greeting: 2_000, idle: 2_000 },
  ...overrides,
});

const email = (overrides: Partial<{ subject: string; text: string }> = {}): OutgoingEmail =>
  outgoingEmail({
    kind: "EMAIL_VERIFICATION",
    to: "Owner@Example.test",
    subject: "メールアドレスの確認",
    text: "こちらのリンクを開いてください。\n.\n.先頭の点\nhttps://app.rd6.test/verify?token=abc",
    ...overrides,
  });

/** What a send rejected with, as `code: message`, or `null` when it was accepted. */
async function outcome(send: Promise<void>): Promise<string | null> {
  try {
    await send;
    return null;
  } catch (error) {
    return error instanceof AppError ? `${error.code}: ${error.message}` : `not an AppError: ${String(error)}`;
  }
}

const verbs = (server: StandIn): string[] => server.heard.map(({ line }) => line.split(/[ :]/)[0] ?? "");

describe("createSmtpEmailSender", () => {
  it("hands one email over STARTTLS, logging in only once encrypted, to the one recipient", async () => {
    const server = await standIn();
    try {
      expect(await outcome(createSmtpEmailSender(options(server.port)).send(email()))).toBeNull();
      expect(server.heard.filter(({ overTls }) => !overTls).map(({ line }) => line)).toEqual([
        "EHLO app.rd6.test",
        "STARTTLS",
      ]);
      expect(server.heard.filter(({ line }) => /^(AUTH|MAIL|RCPT|DATA)/.test(line)).every((h) => h.overTls)).toBe(
        true,
      );
      expect(server.heard.filter(({ line }) => line.startsWith("MAIL")).map(({ line }) => line)).toEqual([
        "MAIL FROM:<noreply@rd6.test>",
      ]);
      expect(server.heard.filter(({ line }) => line.startsWith("RCPT")).map(({ line }) => line)).toEqual([
        "RCPT TO:<owner@example.test>",
      ]);
      expect(server.messages).toHaveLength(1);
      const message = server.messages[0] ?? "";
      // Seven-bit, with short lines, its dots stuffed, and only the headers the adapter writes.
      const sevenBit = [...message].every((c) => c === "\t" || c === "\n" || c === "\r" || (c >= " " && c <= "~"));
      expect(sevenBit).toBe(true);
      expect(message.split("\r\n").every((line) => line.length <= 998)).toBe(true);
      expect(message.split("\r\n")).toContain("..");
      expect(message).toMatch(/^From: noreply@rd6\.test$/m);
      expect(message).toMatch(/^To: owner@example\.test$/m);
      expect(message).toMatch(/^Subject: =\?UTF-8\?/m);
      expect(message).not.toMatch(/^(Cc|Bcc|X-Mailer|Reply-To):/im);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("hands one email over TLS from the first byte", async () => {
    const server = await standIn({ implicit: true });
    try {
      expect(await outcome(createSmtpEmailSender(options(server.port, { tls: "implicit" })).send(email()))).toBeNull();
      expect(server.heard.every(({ overTls }) => overTls)).toBe(true);
      expect(server.messages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("stops before logging in when the server offers no STARTTLS", async () => {
    const server = await standIn({ offerStartTls: false });
    try {
      expect(await outcome(createSmtpEmailSender(options(server.port)).send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ETLS)",
      );
      expect(verbs(server)).not.toContain("AUTH");
      expect(verbs(server)).not.toContain("MAIL");
    } finally {
      await server.close();
    }
  });

  it("checks the server's certificate even when the process's environment says not to", async () => {
    const server = await standIn();
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const sender = createSmtpEmailSender(options(server.port, { ca: pki.otherCa }));
      expect(await outcome(sender.send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ESOCKET)",
      );
      expect(verbs(server)).toEqual(["EHLO", "STARTTLS"]);
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
      await server.close();
    }
  });

  it("refuses a certificate for another name, before logging in", async () => {
    const server = await standIn();
    try {
      const sender = createSmtpEmailSender(options(server.port, { servername: "other.rd6.test" }));
      expect(await outcome(sender.send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ESOCKET)",
      );
      expect(verbs(server)).toEqual(["EHLO", "STARTTLS"]);
    } finally {
      await server.close();
    }
  });

  it("speaks TLS from the first byte only when told to, and never falls back to plain", async () => {
    const plain = await standIn();
    const implicit = await standIn({ implicit: true });
    try {
      // TLS to a server that greets in plain text fails at once; STARTTLS to a TLS port waits for a greeting.
      expect(await outcome(createSmtpEmailSender(options(plain.port, { tls: "implicit" })).send(email()))).toMatch(
        /^PROVIDER_ERROR: The email was not accepted for delivery \((ESOCKET|ECONNECTION)\)$/,
      );
      const starttls = createSmtpEmailSender(options(implicit.port, { limitsMs: { greeting: 300 } }));
      expect(await outcome(starttls.send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ETIMEDOUT)",
      );
      // The plain server reads the TLS hello's random bytes as text: only an SMTP command would count.
      const commands = (server: StandIn) =>
        server.heard.filter(({ line }) => /^(EHLO|HELO|AUTH|MAIL|RCPT|DATA)\b/.test(line));
      expect(commands(plain)).toEqual([]);
      expect(plain.messages).toEqual([]);
      expect(commands(implicit)).toEqual([]);
      expect(implicit.messages).toEqual([]);
    } finally {
      await plain.close();
      await implicit.close();
    }
  });

  it("logs in even when the server does not offer it, before naming anyone", async () => {
    const server = await standIn({ offerAuth: false });
    try {
      expect(await outcome(createSmtpEmailSender(options(server.port)).send(email()))).toBeNull();
      expect(verbs(server).slice(0, 7)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
      expect(server.messages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("names no recipient when the server refuses one, quoting it", async () => {
    const server = await standIn({
      onCommand: (line) => (line.startsWith("RCPT") ? `550 5.1.1 ${line.slice(8)} unknown` : undefined),
    });
    try {
      let thrown: unknown;
      try {
        await createSmtpEmailSender(options(server.port)).send(email());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).message).toBe("The email was not accepted for delivery (EENVELOPE)");
      expect(inspect(thrown, { showHidden: true, depth: 5 })).not.toContain("owner@example.test");
      expect(server.messages).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("checks the email again and sends nothing for one a cast let through", async () => {
    const server = await standIn();
    try {
      const forged = { ...email(), subject: "Hello\r\nBcc: someone@example.test" } as OutgoingEmail;
      expect(await outcome(createSmtpEmailSender(options(server.port)).send(forged))).toBe(
        "VALIDATION_FAILED: The email's subject must be one line with no control characters",
      );
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("rejects with a fixed message that never repeats the server's reply, the password or the recipient", async () => {
    const marker = "MARKER-reply-text";
    const server = await standIn({
      onCommand: (line) => (line.startsWith("AUTH") ? `535 5.7.8 ${marker} for ${line}` : undefined),
    });
    try {
      let thrown: unknown;
      try {
        await createSmtpEmailSender(options(server.port)).send(email());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      const error = thrown as AppError;
      expect(`${error.code}: ${error.message}`).toBe("PROVIDER_ERROR: The email was not accepted for delivery (EAUTH)");
      expect(error.cause).toBeUndefined();
      const own = Object.getOwnPropertyNames(error).sort();
      expect(own).toEqual(["code", "details", "httpStatus", "message", "name", "stack"]);
      const auth = server.heard.find(({ line }) => line.startsWith("AUTH"))?.line.split(" ").pop() ?? "";
      expect(auth).not.toBe("");
      for (const shown of [String(error), JSON.stringify(error), inspect(error, { depth: 5 }), error.stack ?? ""]) {
        for (const secret of [marker, PASSWORD, auth, "owner@example.test"]) expect(shown).not.toContain(secret);
      }
    } finally {
      await server.close();
    }
  });

  it("sends once: a connection dropped after the final dot rejects, and nothing is tried again", async () => {
    const server = await standIn({ afterData: "DESTROY" });
    try {
      expect(await outcome(createSmtpEmailSender(options(server.port)).send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ECONNECTION)",
      );
      expect(server.messages).toHaveLength(1);
      expect(verbs(server).filter((verb) => verb === "MAIL")).toHaveLength(1);
      expect(server.connections()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("gives up on a server that goes quiet, by the connection's idle limit", async () => {
    const server = await standIn({ onCommand: (line) => (line.startsWith("MAIL") ? "SILENT" : undefined) });
    try {
      const started = performance.now();
      const sender = createSmtpEmailSender(options(server.port, { limitsMs: { idle: 300 } }));
      expect(await outcome(sender.send(email()))).toBe(
        "PROVIDER_ERROR: The email was not accepted for delivery (ETIMEDOUT)",
      );
      // Far below any other limit in force here, so the 300 ms idle limit is the one that ended it.
      expect(performance.now() - started).toBeLessThan(1_900);
    } finally {
      await server.close();
    }
  });

  it("refuses settings it cannot use, repeating none of them, and connects to nothing", async () => {
    const server = await standIn();
    const refusal = (overrides: Partial<SmtpEmailSenderOptions>): string | null => {
      try {
        createSmtpEmailSender({ ...options(server.port), ...overrides });
      } catch (error) {
        return error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      }
      return null;
    };
    try {
      for (const host of ["", "mail:587", "smtp://mail", "user@mail", "mail host", "[::1]"]) {
        expect(refusal({ host })).toBe(
          "CONFIGURATION_ERROR: The SMTP host must be a DNS name or an IP address, with no port",
        );
      }
      for (const port of [0, 65_536, 587.5, Number.NaN]) {
        expect(refusal({ port })).toBe("CONFIGURATION_ERROR: The SMTP port must be a whole number from 1 to 65535");
      }
      expect(refusal({ tls: "none" as "starttls" })).toBe(
        'CONFIGURATION_ERROR: The SMTP encryption must be "implicit" or "starttls"',
      );
      // A name a resolver may read as an address, such as 127.1, is no certificate name (ADR-0167).
      for (const servername of [undefined, "10.0.0.7", "mail:587", "127.1"]) {
        expect(refusal({ host: "10.0.0.7", servername })).toBe(
          "CONFIGURATION_ERROR: The SMTP certificate name must be a DNS name, given for an IP host",
        );
      }
      for (const [user, password] of [["", PASSWORD], ["sender", ""]]) {
        expect(refusal({ user, password })).toBe("CONFIGURATION_ERROR: The SMTP user and password must each be given");
      }
      for (const from of ["", "Sender <noreply@rd6.test>", "NoReply@rd6.test", " noreply@rd6.test", "noreply"]) {
        expect(refusal({ from })).toBe(
          "CONFIGURATION_ERROR: The sender's address must be one plain address, in lower case",
        );
      }
      for (const ehloName of ["", "127.0.0.1", "127.1", "app\r\nRCPT TO:<x@y.z>", "app name"]) {
        expect(refusal({ ehloName })).toBe("CONFIGURATION_ERROR: The SMTP EHLO name must be a DNS name");
      }
      for (const idle of [0, 1.5, 2_147_483_648]) {
        expect(refusal({ limitsMs: { idle } })).toBe(
          "CONFIGURATION_ERROR: The SMTP limits must be whole numbers of milliseconds",
        );
      }
      // A DNS host is its own certificate name.
      expect(refusal({ host: "smtp.rd6.test", servername: undefined })).toBeNull();
      await new Promise((done) => setTimeout(done, 50));
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("smtpFailureCode", () => {
  it("passes on a listed code and nothing else", () => {
    expect(smtpFailureCode(Object.assign(new Error("x"), { code: "EAUTH" }))).toBe("EAUTH");
    for (const error of [new Error("EAUTH"), { code: "ECONNREFUSED" }, { code: 7 }, null, "EAUTH", undefined]) {
      expect(smtpFailureCode(error)).toBe("UNKNOWN");
    }
  });
});

describe("the adapter's source", () => {
  const text = readFileSync(join(__dirname, "smtp-email-sender.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("pins every setting that keeps the password, the email and the log safe (ADR-0166)", () => {
    for (const pinned of [
      "requireTLS: !implicit,",
      "secure: implicit,",
      "ignoreTLS: false,",
      "opportunisticTLS: false,",
      "rejectUnauthorized: true,",
      'minVersion: "TLSv1.2",',
      "pool: false,",
      "logger: false,",
      "debug: false,",
      "disableFileAccess: true,",
      "disableUrlAccess: true,",
      "forceAuth: true,",
      "envelope: { from, to: [checked.to] },",
    ]) {
      expect(text).toContain(pinned);
    }
    expect(text.match(/createTransport\(/g)).toHaveLength(1);
    expect(text).not.toMatch(/cause:|\bcc:|bcc:|replyTo|headers:|attachments|html:/i);
  });
});

describe("who builds it", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

  function sources(dir: string): { name: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return ["node_modules", ".next"].includes(entry.name) ? [] : sources(full);
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
      const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      return [{ name: full.slice(REPO_ROOT.length + 1), text }];
    });
  }

  it("is built by nothing in the apps yet, and the mail library is loaded by the adapter alone (ADR-0166)", () => {
    const files = [...sources(join(REPO_ROOT, "apps")), ...sources(join(REPO_ROOT, "packages"))];
    expect(files.map(({ name }) => name)).toContain("apps/web/src/lib/adapters.ts");
    const naming = files.filter(({ text }) => /createSmtpEmailSender|@app\/storage\/smtp|smtp-email-sender/.test(text));
    expect(naming.map(({ name }) => name).sort()).toEqual([
      "packages/storage/src/smtp/index.ts",
      "packages/storage/src/smtp/smtp-email-sender.ts",
    ]);
    const loading = files.filter(({ text }) => /["']nodemailer["']/.test(text));
    expect(loading.map(({ name }) => name)).toEqual(["packages/storage/src/smtp/smtp-email-sender.ts"]);
    // Not through the barrel, which the worker and the upload routes load.
    const barrel = files.find(({ name }) => name === "packages/storage/src/index.ts");
    expect(barrel?.text).toBeDefined();
    expect(barrel?.text).not.toMatch(/\.\/smtp/);
  });
});
