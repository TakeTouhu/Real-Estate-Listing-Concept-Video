/**
 * The production-mode job's metadata server (ADR-0178 Decision 4), named
 * `metadata.google.internal` on its internal network. Only the token path,
 * asked with `Metadata-Flavor: Google`, answers `200` with that header and this
 * run's token, `rd11-fake-<32 hex>`; anything else `404`. Each request logs one
 * line: its path, whether the flavor was Google's, whether `Authorization`
 * came; never a header's value. Node.js built-ins only, run by CI.
 */
import { createServer } from "node:http";
import process from "node:process";

const TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
const hex = process.env.RD11_METADATA_TOKEN ?? "";
if (!/^[0-9a-f]{32}$/.test(hex)) {
  process.stderr.write("RD11_METADATA_TOKEN must be 32 lowercase hex characters\n");
  process.exit(1);
}
const body = JSON.stringify({ access_token: `rd11-fake-${hex}`, expires_in: 3600, token_type: "Bearer" });

const server = createServer((request, answer) => {
  // The target as sent, up to any query: no parse that could throw on an odd target.
  const path = (request.url ?? "/").split("?")[0];
  const sent = request.headers["metadata-flavor"];
  const flavor = sent === undefined ? null : sent === "Google" ? "Google" : "other";
  const authorization = request.headers.authorization !== undefined;
  process.stdout.write(`${JSON.stringify({ path, flavor, authorization })}\n`);
  request.resume();
  if (request.method === "GET" && path === TOKEN_PATH && flavor === "Google") {
    answer.writeHead(200, { "Metadata-Flavor": "Google", "Content-Type": "application/json" }).end(body);
  } else {
    answer.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
  }
});
server.listen(Number(process.env.METADATA_PORT ?? "80"), "0.0.0.0");
