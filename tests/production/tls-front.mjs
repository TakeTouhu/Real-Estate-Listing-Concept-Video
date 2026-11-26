/**
 * The production-mode job's TLS front (ADR-0178 Decision 6), standing in for
 * the load balancer: it serves this run's `app.rd11.test` leaf and streams each
 * request to the web container's http and back, keeping `Host`, appending the
 * peer to `X-Forwarded-For`, setting `X-Forwarded-Proto: https`, sending a
 * chunked body on chunked, and copying the status and every header but
 * hop-by-hop ones and those `Connection` names. It logs an error's code alone.
 * Node.js built-ins only, run by CI on the pinned Node.js image.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import process from "node:process";
import { pipeline } from "node:stream";
import { URL } from "node:url";

const upstream = new URL(process.env.FRONT_UPSTREAM ?? "http://web:3000");
const port = Number(process.env.FRONT_PORT ?? "8443");
const tls = process.env.FRONT_TLS ?? "/run/rd11/tls";
/** Headers that belong to one connection, never forwarded (RFC 9110 section 7.6.1). */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const logCode = (error) => {
  process.stderr.write(`${JSON.stringify({ front: "error", code: error?.code ?? "UNKNOWN" })}\n`);
};

/** A raw header list, `[name, value, ...]`, without hop-by-hop names, those `Connection` names (never `Host`)
 * or those `drop` names. */
function kept(raw, drop = []) {
  const named = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === "connection") named.push(...raw[i + 1].toLowerCase().split(",").map((n) => n.trim()));
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    const listed = named.includes(name) && name !== "host";
    if (!HOP.has(name) && !listed && !drop.includes(name)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

const server = createServer(
  { cert: readFileSync(`${tls}/cert.pem`), key: readFileSync(`${tls}/key.pem`) },
  (incoming, answer) => {
    const peer = incoming.socket.remoteAddress ?? "";
    const before = incoming.headers["x-forwarded-for"];
    const headers = kept(incoming.rawHeaders, ["x-forwarded-for", "x-forwarded-proto"]);
    headers.push("X-Forwarded-For", before === undefined ? peer : `${before}, ${peer}`);
    headers.push("X-Forwarded-Proto", "https");
    // Framed again, for a method Node.js would otherwise send with no length.
    if (incoming.headers["transfer-encoding"] !== undefined) headers.push("Transfer-Encoding", "chunked");
    const out = request(
      { host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers },
      (reply) => {
        answer.writeHead(reply.statusCode ?? 502, kept(reply.rawHeaders));
        pipeline(reply, answer, (error) => error && logCode(error));
      },
    );
    // The pipeline below logs the error's code once.
    out.on("error", () => {
      if (!answer.headersSent) answer.writeHead(502).end();
      else answer.destroy();
    });
    pipeline(incoming, out, (error) => error && logCode(error));
  },
);
server.on("tlsClientError", logCode);
server.listen(port, "0.0.0.0");
