import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISCLOSURE_LAYER_ASSETS } from "@app/domain";
import { serverEnvSchema } from "@app/shared";

/**
 * The rules every container image's recipe keeps (RD-10a, ADR-0175), read as
 * text: a pinned base and one digest for all, no build argument, no timer, no
 * proxy, secret or setting baked in, a numeric non-root user, an ignore file
 * that keeps secrets and outputs out of the build context, and a workflow that
 * builds each image and pushes none. A later image adds its Dockerfile here.
 */
const REPO_ROOT = join(__dirname, "..");
const DOCKERFILES = ["apps/web/Dockerfile", "apps/worker/Dockerfile"];
const WORKFLOW = ".github/workflows/ci.yml";
const DIGEST = "sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6";

/** An outside image: repository, tag and index digest. */
const PINNED = /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;
/** Proxies, secrets, and the names the repository bans or production refuses. */
const BANNED_ENV = new RegExp(
  [
    "PROXY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_KEY$",
    "^GCS_|S3_BUCKET|^AWS_|^R2_|^AZURE_STORAGE|^FAL_KEY$|^FFPROBE_PATH$|^FX_API_",
    "^NODE_DEBUG$|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^OPENSSL_CONF$",
    "^GOOGLE_APPLICATION_CREDENTIALS$|^GCE_METADATA_HOST$|^STORAGE_EMULATOR_HOST$",
  ].join("|"),
  "i",
);
/** No setting the app reads is baked in; `NODE_ENV` is the image's own, which `server.js` fixes anyway. */
const SETTINGS = Object.keys(serverEnvSchema.innerType().shape).filter((name) => name !== "NODE_ENV");
/** Every line of the ignore file: a later edit may add a line, never drop one. */
const REQUIRED_IGNORES = [
  "**/.git",
  ".github",
  "**/.claude",
  "docs",
  ".pnpm-store",
  "**/dist",
  "**/out",
  "**/.env",
  "**/.env.*",
  "**/node_modules",
  "**/.next",
  "**/coverage",
  "**/.vitest",
  "**/playwright-report",
  "**/test-results",
  "**/.e2e",
  "**/.dev-storage",
  "**/.dev-outbox",
  "**/.dev-provider",
  "**/*.tsbuildinfo",
  "**/next-env.d.ts",
  "**/*.log",
];

const raw = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf8");

/**
 * Each instruction on one line, as Docker reads the file: comment and blank
 * lines go first, also inside a continued instruction, and only then are the
 * lines that end in a backslash joined, so a comment never continues.
 */
function instructions(file: string): string[] {
  return raw(file)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n")
    .replace(/\\[ \t]*\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "));
}

const keyword = (line: string): string => (line.split(" ")[0] ?? "").toUpperCase();
const ofKind = (lines: string[], kind: string): string[] => lines.filter((l) => keyword(l) === kind);

/** The instructions from the last `FROM` on: the stage that becomes the image. */
function finalStage(file: string): string[] {
  const all = instructions(file);
  const last = all.map(keyword).lastIndexOf("FROM");
  return all.slice(last);
}

/** The names an `ENV` instruction sets: the legacy `name value` form if its first word has no `=`. */
function envNames(line: string): string[] {
  const rest = line.slice("ENV ".length);
  const first = rest.split(" ")[0] ?? "";
  if (!first.includes("=")) return [first];
  return [...rest.matchAll(/(?:^|\s)([^\s=]+)=/g)].map((m) => m[1] ?? "");
}

describe.each(DOCKERFILES)("%s", (file) => {
  it("starts with check=error=true and has no syntax or escape directive", () => {
    expect(raw(file).split(/\r?\n/)[0]).toBe("# check=error=true");
    expect(/^\s*#\s*syntax\s*=/im.test(raw(file))).toBe(false);
    expect(/^\s*#\s*escape\s*=/im.test(raw(file))).toBe(false);
  });

  it("pins every outside image, in FROM, COPY --from and a mount's from=, by tag and index digest", () => {
    const stages: string[] = [];
    for (const line of instructions(file)) {
      if (keyword(line) === "FROM") {
        const match = /^FROM (\S+)(?: AS (\S+))?$/i.exec(line);
        const image = match?.[1] ?? "";
        const ok = stages.includes(image) || PINNED.test(image);
        expect(`${line}: ${ok}`).toBe(`${line}: true`);
        if (match?.[2] !== undefined) stages.push(match[2]);
        continue;
      }
      for (const [, image = ""] of line.matchAll(/(?:^|[\s,])(?:--)?from=([^\s,]+)/gi)) {
        const ok = stages.includes(image) || PINNED.test(image);
        expect(`${line}: ${ok}`).toBe(`${line}: true`);
      }
    }
  });

  it("takes no ARG, ADD, ONBUILD, HEALTHCHECK or here-document, and gives no file another owner or mode", () => {
    const all = instructions(file);
    for (const kind of ["ARG", "ADD", "ONBUILD", "HEALTHCHECK"]) expect(ofKind(all, kind)).toEqual([]);
    expect(all.filter((l) => l.includes("<<"))).toEqual([]);
    expect(all.filter((l) => /--ch(?:own|mod)\b/.test(l))).toEqual([]);
    expect(ofKind(all, "RUN").filter((l) => /\bch(?:own|mod)\b/.test(l))).toEqual([]);
  });

  it("names no proxy in any instruction, and sets no secret, banned name or setting in ENV", () => {
    expect(instructions(file).filter((l) => /proxy/i.test(l))).toEqual([]);
    for (const name of ofKind(instructions(file), "ENV").flatMap(envNames)) {
      const banned = BANNED_ENV.test(name) || SETTINGS.includes(name);
      expect(`${name}: ${banned}`).toBe(`${name}: false`);
    }
  });

  it("runs the image's own stage as a numeric, non-root user and group", () => {
    expect(ofKind(finalStage(file), "USER").at(-1)).toMatch(/^USER [1-9]\d*:[1-9]\d*$/);
  });

  it("has its own ignore file, which leaves secrets, dependencies and outputs out", () => {
    const ignores = raw(`${file}.dockerignore`)
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const pattern of REQUIRED_IGNORES) {
      expect(`${pattern}: ${ignores.includes(pattern)}`).toBe(`${pattern}: true`);
    }
    expect(ignores.filter((line) => line.startsWith("!"))).toEqual([]);
  });
});

/** A step of an image's job: its scalar fields, its `with:` and its `run:` text. */
interface Step {
  readonly fields: Map<string, string>;
  readonly with: Map<string, string>;
}

interface Job {
  readonly keys: Map<string, string>;
  readonly permissions: Map<string, string>;
  readonly env: Map<string, string>;
  readonly steps: Step[];
  /** Lines the reader does not know: any of them fails the guard. */
  readonly unknown: string[];
  readonly first: number;
  /** The line after the job's last. */
  last: number;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const STEP_KEYS = ["name", "uses", "with", "run", "if", "timeout-minutes"];
const BLOCK = /^[|>]-?$/;

/**
 * Reads one job of the workflow in the plain block style it is written in, and
 * nothing more: a flow mapping, an anchor, a quoted key, a duplicate key or a
 * key it does not know lands in `unknown`, so an unusual shape fails rather
 * than slipping past.
 */
function readJob(ci: string, name: string): Job {
  const lines = ci.split(/\r?\n/);
  const first = lines.indexOf(`  ${name}:`);
  const job: Job = {
    keys: new Map(),
    permissions: new Map(),
    env: new Map(),
    steps: [],
    unknown: first < 0 ? [`no job ${name}`] : [],
    first,
    last: lines.length,
  };
  let section = "";
  let step: Step | undefined;
  let inWith = false;
  let scalar: { readonly key: string; readonly folded: boolean; readonly text: string[] } | undefined;
  const put = (map: Map<string, string>, key: string, value: string, line: string): void => {
    if (map.has(key)) job.unknown.push(line);
    map.set(key, value);
  };
  const close = (): void => {
    if (scalar === undefined || step === undefined) return;
    const text = scalar.folded ? scalar.text.map((l) => l.trim()).join(" ") : scalar.text.join("\n");
    put(step.fields, scalar.key, text.trim(), scalar.key);
    scalar = undefined;
  };
  for (let i = first + 1; first >= 0 && i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const indent = indentOf(line);
    const text = line.trim();
    if (scalar !== undefined && (text === "" || indent >= 10)) {
      scalar.text.push(line.slice(10));
      continue;
    }
    close();
    if (text === "" || text.startsWith("#")) continue;
    if (indent <= 2) {
      job.last = i;
      break;
    }
    const isItem = indent === 6 && section === "steps" && text.startsWith("- ");
    const body = isItem ? text.slice(2) : text;
    const pair = /^([a-z][\w-]*): ?(.*)$/i.exec(body);
    const key = pair?.[1] ?? "";
    const value = pair?.[2] ?? "";
    if (pair === null) {
      job.unknown.push(line);
    } else if (indent === 4) {
      put(job.keys, key, value, line);
      section = value === "" ? key : "";
      if (section !== "" && !["permissions", "env", "steps"].includes(section)) job.unknown.push(line);
    } else if (indent === 6 && (section === "permissions" || section === "env") && value !== "") {
      put(section === "env" ? job.env : job.permissions, key, value, line);
    } else if (isItem || (indent === 8 && step !== undefined)) {
      if (isItem) {
        step = { fields: new Map(), with: new Map() };
        job.steps.push(step);
      }
      const current = job.steps.at(-1);
      inWith = key === "with" && value === "";
      if (current === undefined || !STEP_KEYS.includes(key)) job.unknown.push(line);
      else if (BLOCK.test(value)) scalar = { key, folded: value.startsWith(">"), text: [] };
      else put(current.fields, key, value, line);
    } else if (indent === 10 && inWith && step !== undefined && value !== "") {
      put(step.with, key, value, line);
    } else {
      job.unknown.push(line);
    }
  }
  close();
  return job;
}

/** A `run:` text's commands, one per line, with continued lines joined and spaces collapsed. */
const commands = (run: string): string[] =>
  run
    .replace(/\\[ \t]*\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "));

/** The only Docker commands the job may run; the build is held word for word below. */
const DOCKER_COMMANDS = ["run", "exec", "logs", "rm", "image inspect", "buildx build"];
/** A stand-in job's commands besides: its networks, read as two words like `image` and `buildx` (ADR-0178). */
const STAND_IN_COMMANDS = [...DOCKER_COMMANDS, "network create", "network connect", "network rm"];
const BUILD = new RegExp(
  [
    "^docker buildx build --provenance=false --load --platform linux/amd64 -f (\\S+)(?: --target ([\\w-]+))?",
    ' --label "org\\.opencontainers\\.image\\.revision=\\$REVISION" --tag [\\w.-]+:ci \\.$',
  ].join(""),
);
/** Anything that would push, log in, pass a secret or argument, cache, schedule or proxy, anywhere in the file. */
const BANNED_WORKFLOW = new RegExp(
  [
    "--push\\b|push\\s*=\\s*true|type\\s*=\\s*registry|--secret\\b|--cache-(?:to|from)\\b|--build-arg\\b|--output\\b",
    "\\b(?:skopeo|crane|oras|regctl)\\b|secrets\\s*[.[]|github\\.token|GITHUB_TOKEN|\\bschedule\\b|\\bcron\\b|_proxy",
  ].join("|"),
  "i",
);

/**
 * Each image's job, what it builds in order (the Dockerfile and a `--target`,
 * empty for the last stage) and its steps run whatever happened before them.
 */
const IMAGE_JOBS = [
  { name: "web-image", builds: [["apps/web/Dockerfile", ""]], guarded: [["Stop the server", "always()"]] },
  {
    name: "worker-image",
    builds: [
      ["apps/worker/Dockerfile", "media-test"],
      ["apps/worker/Dockerfile", ""],
    ],
    guarded: [],
  },
];

/**
 * Each job that runs an image against stand-ins (ADR-0178, amending ADR-0175
 * Decision 1): what it builds, the actions it uses in order, its steps run
 * whatever happened before them, and each container and network word for word.
 */
const STAND_IN_JOBS = [
  {
    name: "production-mode",
    builds: [["apps/web/Dockerfile", ""]],
    actions: ["actions/checkout@v4", "pnpm/action-setup@v4", "actions/setup-node@v4"],
    guarded: [["Stop the stand-ins", "always()"]],
    runs: [
      ["--name db --network rd11-edge -p 127.0.0.1:5432:5432", '--env-file "$dir/pg.env" "$PG_IMAGE"'],
      [
        '--name gcs --network rd11-edge -p 127.0.0.1:4480:8000 -v "$dir/gcs:/run/rd11/tls:ro" -e FAKE_GCS_SCHEME=both',
        "-e FAKE_GCS_PORT=443 -e FAKE_GCS_PORT_HTTP=8000 -e FAKE_GCS_BACKEND=memory -e FAKE_GCS_LOG_LEVEL=warn",
        "-e FAKE_GCS_CERT_LOCATION=/run/rd11/tls/cert.pem",
        '-e FAKE_GCS_PRIVATE_KEY_LOCATION=/run/rd11/tls/key.pem "$GCS_IMAGE"',
      ],
      [
        '--name mailpit --network rd11-edge -p 127.0.0.1:8025:8025 -v "$dir/mail:/run/rd11/tls:ro"',
        "-e MP_SMTP_TLS_CERT=/run/rd11/tls/cert.pem -e MP_SMTP_TLS_KEY=/run/rd11/tls/key.pem",
        "-e MP_SMTP_REQUIRE_STARTTLS=true -e MP_SMTP_AUTH_ACCEPT_ANY=true",
        '-e MP_DISABLE_VERSION_CHECK=true "$MAILPIT_IMAGE"',
      ],
      [
        "--name clamav --network rd11-int --ip 172.30.11.13 --network-alias clamav.rd11.test",
        '-e CLAMAV_NO_FRESHCLAMD=true -e CLAMAV_NO_MILTERD=true "$CLAMAV_IMAGE"',
      ],
      [
        "--name metadata --network rd11-int --ip 172.30.11.11 --network-alias metadata.google.internal",
        '--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --env-file "$dir/metadata.env"',
        '-v "$GITHUB_WORKSPACE/tests/production:/srv/rd11:ro" "$NODE_IMAGE" node /srv/rd11/metadata-server.mjs',
      ],
      [
        "--name web --network rd11-int --read-only --cap-drop ALL --security-opt no-new-privileges",
        '--env-file "$dir/web.env" -v "$dir/ca.pem:/run/rd11/ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/run/rd11/ca.pem',
        "vtavision-web:ci",
      ],
      [
        "--name front --network rd11-edge -p 127.0.0.1:8443:8443 --user 1000:1000 --read-only --cap-drop ALL",
        '--security-opt no-new-privileges -v "$dir/app:/run/rd11/tls:ro"',
        '-v "$GITHUB_WORKSPACE/tests/production:/srv/rd11:ro" "$NODE_IMAGE" node /srv/rd11/tls-front.mjs',
      ],
    ].map((words) => ["docker run -d", ...words].join(" ")),
    networks: [
      "create --internal --subnet 172.30.11.0/24 rd11-int",
      "create rd11-edge",
      "connect --ip 172.30.11.12 --alias db.rd11.test rd11-int db",
      "connect --ip 172.30.11.10 --alias storage.googleapis.com rd11-int gcs",
      "connect --ip 172.30.11.14 --alias mail.rd11.test rd11-int mailpit",
      "connect --ip 172.30.11.15 rd11-int front",
      "rm rd11-int rd11-edge || true",
    ].map((words) => `docker network ${words}`),
  },
];
/** What would widen trust, turn a check off, point the store elsewhere or reach the host, anywhere in such a job. */
const BANNED_STAND_IN = new RegExp(
  [
    "NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS|SSL_CERT_|GOOGLE_CLOUD_STORAGE_ENDPOINT|--insecure|\\s-k\\b",
    "--no-check-certificate|rejectUnauthorized|createRequire",
    "--privileged|docker\\.sock|--(?:network|net)[= ]host|--cap-add|--entrypoint|services:",
  ].join("|"),
);
/** `-k` alone or among other one-letter flags, in a command that asks over the network. */
const INSECURE_FLAG = /(?:^|\s)-[A-Za-z]*k[A-Za-z]*(?=\s|$)/;
/** The only places such a job names Google's store: its leaf, its alias inside the job's network, its lookup in web. */
const GOOGLE_NAMED = [
  "gcs:storage.googleapis.com",
  "--alias storage.googleapis.com",
  "docker exec web getent hosts storage.googleapis.com",
];
/** A stand-in run's options that take a value, then those that take none; any other option is refused. */
const RUN_OPTIONS = ["--name", "--network", "-p", "-v", "-e", "--env-file", "--ip", "--network-alias", "--user"]
  .concat(["--cap-drop", "--security-opt"]);
const RUN_FLAGS = ["-d", "--read-only"];

/** What a `docker run` runs: the first word after its options, and the words after it; undefined on another option. */
function ranImage(command: string): { readonly image: string; readonly rest: string } | undefined {
  const words = command.split(" ").slice(2);
  let i = 0;
  while (words[i]?.startsWith("-") === true) {
    const word = words[i] ?? "";
    if (RUN_OPTIONS.includes(word)) i += 2;
    else if (RUN_FLAGS.includes(word)) i += 1;
    else return undefined;
  }
  return { image: words[i] ?? "", rest: words.slice(i + 1).join(" ") };
}

/** Each Docker command in a job's steps, with its sub-command: two words for `image`, `buildx` and `network`. */
function dockerCommands(job: Job): { readonly command: string; readonly sub: string }[] {
  const found: { command: string; sub: string }[] = [];
  for (const command of job.steps.flatMap((s) => commands(s.fields.get("run") ?? ""))) {
    for (const [, one = "", two = ""] of command.matchAll(/\bdocker\s+(\S+)(?:\s+(\S+))?/g)) {
      found.push({ command, sub: ["image", "buildx", "network"].includes(one) ? `${one} ${two}` : one });
    }
  }
  return found;
}

/** What a job builds, each build held to the one guarded command. */
function builds(job: Job): string[][] {
  const built: string[][] = [];
  for (const { command, sub } of dockerCommands(job)) {
    if (sub !== "buildx build") continue;
    const build = BUILD.exec(command);
    expect(`${command}: ${build !== null}`).toBe(`${command}: true`);
    if (build !== null) built.push([build[1] ?? "", build[2] ?? ""]);
  }
  return built;
}

describe("the images together", () => {
  it("use one base digest", () => {
    const digests = new Set(
      DOCKERFILES.flatMap((file) =>
        instructions(file).flatMap((line) => [...line.matchAll(/@(sha256:[0-9a-f]{64})/g)].map((m) => m[1])),
      ),
    );
    expect([...digests]).toEqual([DIGEST]);
  });

  it("have no root .dockerignore, which a reader might edit while BuildKit reads another", () => {
    expect(existsSync(join(REPO_ROOT, ".dockerignore"))).toBe(false);
  });

  it.each(IMAGE_JOBS)("are built in the $name job, which reads, builds and runs, and nothing else", (image) => {
    const ci = raw(WORKFLOW);
    const job = readJob(ci, image.name);
    expect(job.unknown).toEqual([]);
    expect(job.keys.get("runs-on")).toBe("ubuntu-24.04");
    expect(job.keys.get("timeout-minutes")).toBe("30");
    expect([...job.keys.keys()].sort()).toEqual(["env", "permissions", "runs-on", "steps", "timeout-minutes"]);
    expect([...job.permissions]).toEqual([["contents", "read"]]);
    expect([...job.env]).toEqual([["REVISION", "${{ github.sha }}"]]);

    const [checkout, ...rest] = job.steps;
    expect(checkout?.fields.get("uses")).toBe("actions/checkout@v4");
    expect([...(checkout?.with ?? [])]).toEqual([["persist-credentials", "false"]]);
    expect(rest.filter((s) => s.fields.has("uses") || s.with.size > 0)).toEqual([]);
    const guarded = job.steps.filter((s) => s.fields.has("if")).map((s) => [s.fields.get("name"), s.fields.get("if")]);
    expect(guarded).toEqual(image.guarded);

    for (const { command, sub } of dockerCommands(job)) {
      expect(`${command}: ${DOCKER_COMMANDS.includes(sub)}`).toBe(`${command}: true`);
    }
    expect(builds(job)).toEqual(image.builds);
  });

  it.each(STAND_IN_JOBS)("are run against stand-ins in the $name job, as built and held in", (stand) => {
    const ci = raw(WORKFLOW);
    const job = readJob(ci, stand.name);
    const text = ci.split(/\r?\n/).slice(job.first, job.last).join("\n");
    expect(job.unknown).toEqual([]);
    expect(job.keys.get("runs-on")).toBe("ubuntu-24.04");
    expect(job.keys.get("timeout-minutes")).toBe("60");
    expect([...job.keys.keys()].sort()).toEqual(["env", "permissions", "runs-on", "steps", "timeout-minutes"]);
    expect([...job.permissions]).toEqual([["contents", "read"]]);

    // The commit, and every image it runs by tag and index digest: Node.js's is the images' base, and the three
    // stand-ins the storage job runs are the very pins it runs.
    const images = [...job.env].filter(([name]) => name !== "REVISION");
    expect(job.env.get("REVISION")).toBe("${{ github.sha }}");
    const names = ["PG_IMAGE", "GCS_IMAGE", "CLAMAV_IMAGE", "MAILPIT_IMAGE", "NODE_IMAGE"];
    expect(images.map(([name]) => name)).toEqual(names);
    for (const [name, image] of images) expect(`${name}: ${PINNED.test(image)}`).toBe(`${name}: true`);
    expect(job.env.get("NODE_IMAGE")).toBe(`node:22-trixie-slim@${DIGEST}`);
    expect(job.env.get("PG_IMAGE")).toMatch(/^postgres:16\.\d+-trixie@/);
    for (const name of ["GCS_IMAGE", "CLAMAV_IMAGE", "MAILPIT_IMAGE"]) {
      expect(ci.split(/\r?\n/).map((line) => line.trim())).toContain(`image: ${job.env.get(name)}`);
    }

    const [checkout] = job.steps;
    expect([...(checkout?.with ?? [])]).toEqual([["persist-credentials", "false"]]);
    expect(job.steps.flatMap((s) => s.fields.get("uses") ?? [])).toEqual(stand.actions);
    const guarded = job.steps.filter((s) => s.fields.has("if")).map((s) => [s.fields.get("name"), s.fields.get("if")]);
    expect(guarded).toEqual(stand.guarded);
    const bounded = (s: Step): boolean => /^[1-9]\d*$/.test(s.fields.get("timeout-minutes") ?? "");
    const unbounded = job.steps.filter((s) => s.fields.has("run") && !bounded(s));
    expect(unbounded.map((s) => s.fields.get("name"))).toEqual([]);

    const docker = dockerCommands(job);
    for (const { command, sub } of docker) {
      expect(`${command}: ${STAND_IN_COMMANDS.includes(sub)}`).toBe(`${command}: true`);
      // Into a container as it runs, never as another user or with more.
      expect(command).not.toMatch(/\bdocker exec -/);
    }
    expect(builds(job)).toEqual(stand.builds);
    // Every container is the image built here or a pinned one, and each is held word for word: the web image runs
    // as built, with the web-image job's flags, on the internal network alone. So is each network.
    const runs = docker.filter(({ sub }) => sub === "run").map(({ command }) => command);
    for (const command of runs) {
      const ran = ranImage(command) ?? { image: "", rest: "" };
      const pinned = /^"\$([A-Z]+_IMAGE)"$/.exec(ran.image)?.[1];
      const image = ran.image === "vtavision-web:ci" || (pinned !== undefined && job.env.has(pinned));
      const rest = ran.rest === "" || (pinned === "NODE_IMAGE" && /^node \/srv\/rd11\/[\w-]+\.mjs$/.test(ran.rest));
      expect(`${command}: ${image && rest}`).toBe(`${command}: true`);
    }
    expect(runs).toEqual(stand.runs);
    const networks = docker.filter(({ sub }) => sub.startsWith("network ")).map(({ command }) => command);
    expect(networks).toEqual(stand.networks);
    // Each Node.js stand-in runs a file of tests/production: Node.js's built-ins alone, and no timer.
    for (const command of runs.filter((c) => c.includes('"$NODE_IMAGE"'))) {
      const file = / node \/srv\/rd11\/([\w-]+\.mjs)$/.exec(command)?.[1] ?? "none";
      const there = existsSync(join(REPO_ROOT, "tests/production", file));
      expect(`${command}: ${there}`).toBe(`${command}: true`);
      const source = there ? raw(`tests/production/${file}`) : "";
      const imports = source.split("\n").filter((l) => /\bimport\b|\bfrom\b|require/.test(l) && !l.startsWith(" * "));
      expect(imports.filter((l) => !/^import (?:\w+|\{ \w+(?:, \w+)* \}) from "node:[\w/]+";$/.test(l))).toEqual([]);
      expect(source).not.toMatch(/createRequire|process\.binding|set(?:Timeout|Interval)|timers/);
    }

    expect(text.split("\n").filter((line) => BANNED_STAND_IN.test(line))).toEqual([]);
    const all = job.steps.flatMap((s) => commands(s.fields.get("run") ?? ""));
    const asking = all.filter((command) => /\b(?:curl|wget|expect)\b/.test(command));
    expect(asking.filter((command) => INSECURE_FLAG.test(command))).toEqual([]);
    const named = GOOGLE_NAMED.reduce((rest, name) => rest.split(name).join(""), text);
    expect(named).not.toMatch(/googleapis|google\.com|googleusercontent/i);
  });

  it("are every one built by a job, with no docker outside those jobs, and nothing pushed or cached", () => {
    const ci = raw(WORKFLOW);
    const all = [...IMAGE_JOBS, ...STAND_IN_JOBS];
    const built = new Set(all.flatMap((image) => image.builds.map(([file]) => file)));
    expect([...built].sort()).toEqual([...DOCKERFILES].sort());
    const jobs = all.map((image) => readJob(ci, image.name));
    const outside = ci.split(/\r?\n/).filter((_, i) => jobs.every((job) => i < job.first || i >= job.last));
    expect(outside.filter((line) => /docker/i.test(line))).toEqual([]);
    expect(ci.split(/\r?\n/).filter((line) => BANNED_WORKFLOW.test(line))).toEqual([]);
  });
});

describe("the web image", () => {
  const file = "apps/web/Dockerfile";

  it("builds the standalone server once, with NODE_ENV unset, so production sends HSTS", () => {
    expect(raw("apps/web/next.config.mjs")).toMatch(/^\s*output: "standalone",$/m);
    const runs = ofKind(instructions(file), "RUN");
    expect(runs.filter((l) => /\b(?:pnpm|npm|npx|yarn|next)\b[^&|;]*\bbuild\b/.test(l))).toEqual([
      "RUN env -u NODE_ENV pnpm --filter @app/web build",
    ]);
    expect(runs.filter((l) => l.includes("NODE_ENV="))).toEqual([]);
  });

  it("has its smoke check that the image optimizer is off", () => {
    expect(raw("apps/web/next.config.mjs")).toMatch(/^\s*images: \{ unoptimized: true \},$/m);
    const ci = raw(WORKFLOW);
    const job = readJob(ci, "web-image");
    const lines = ci.split(/\r?\n/).slice(job.first, job.last);
    expect(lines.filter((line) => line.includes("/_next/image")).map((line) => line.trim())).toEqual([
      "const image = await fetch(`${base}/_next/image?url=%2Ffavicon.ico&w=64&q=75`);",
      "check(image.status === 404, `/_next/image answers ${image.status}`);",
    ]);
  });

  it("has its smoke check that a redirect is a path, asked through another host name (RD-10b)", () => {
    const ci = raw(WORKFLOW);
    const job = readJob(ci, "web-image");
    const lines = ci.split(/\r?\n/).slice(job.first, job.last).map((line) => line.trim());
    const start = lines.indexOf("const logout = await new Promise((resolve, reject) => {");
    expect(lines.slice(start, start + 9)).toEqual([
      "const logout = await new Promise((resolve, reject) => {",
      'const headers = { host: "app.rd10.test", origin: "https://app.rd10.test" };',
      'request(`${base}/api/auth/logout`, { method: "POST", headers }, resolve).on("error", reject).end();',
      "});",
      "logout.resume();",
      "check(logout.statusCode === 303, `sign-out answers ${logout.statusCode}`);",
      'check(logout.headers.location === "/login", `sign-out\'s Location is ${logout.headers.location}`);',
      'const cookie = String(logout.headers["set-cookie"] ?? "");',
      'check(/^rev_session=;/.test(cookie), "sign-out deletes the session cookie");',
    ]);
    expect(lines.filter((line) => /\blogout\b/.test(line))).toHaveLength(6);
    expect(lines.filter((line) => line.includes("node:http"))).toEqual(['import { request } from "node:http";']);
  });

  it("has its smoke check that an unknown failure leaves one line, with nothing typed or secret", () => {
    const ci = raw(WORKFLOW);
    const job = readJob(ci, "web-image");
    const lines = ci.split(/\r?\n/).slice(job.first, job.last).map((line) => line.trim());
    const start = lines.indexOf('const signIn = await new Promise((resolve, reject) => {');
    expect(lines.slice(start, start + 14)).toEqual([
      'const signIn = await new Promise((resolve, reject) => {',
      'const headers = {',
      'host: "app.rd10.test",',
      'origin: "https://app.rd10.test",',
      '"x-forwarded-for": "203.0.113.7",',
      '"content-type": "application/x-www-form-urlencoded",',
      '};',
      'const typed = "email=rd10-typed%40rd10.test&password=rd10-typed-canary";',
      'request(`${base}/api/auth/login`, { method: "POST", headers }, resolve).on("error", reject).end(typed);',
      '});',
      'signIn.resume();',
      'check(signIn.statusCode === 303, `sign-in answers ${signIn.statusCode}`);',
      'const refused = signIn.headers.location;',
      "check(refused === \"/login?error=Sign+in+failed\", `sign-in's Location is ${refused}`);",
    ]);
    // Read once the server's log is written, never printing a stand-in (ADR-0177).
    const greps = lines.indexOf(
      "line=\"$(grep '\"component\":\"request\"' \"$RUNNER_TEMP/web.log\"" +
        " | grep '\"route\":\"POST /api/auth/login\"')\"",
    );
    expect(greps).toBeGreaterThan(lines.indexOf('docker logs web > "$RUNNER_TEMP/web.log" 2>&1'));
    expect(lines.slice(greps, greps + 18)).toEqual([
      "line=\"$(grep '\"component\":\"request\"' \"$RUNNER_TEMP/web.log\"" +
        " | grep '\"route\":\"POST /api/auth/login\"')\"",
      "test \"$(printf '%s\\n' \"$line\" | grep -c .)\" -eq 1",
      "printf '%s' \"$line\" | grep -q '\"errorName\":\"RateLimiterUnavailable\"'",
      "printf '%s' \"$line\" | grep -q '\"causeName\":\"PrismaClientInitializationError\"'",
      "# Each typed value as sent or as read (rd10-typed%40… and rd10-typed@…), and the client's address.",
      'for sent in rd10-typed 203.0.113.7; do',
      'if grep -qF "$sent" "$RUNNER_TEMP/web.log"; then echo "A value sent reached the log" >&2; exit 1; fi',
      'done',
      'for name in SESSION_SECRET HEALTHCHECK_API_TOKEN STORAGE_SIGNING_SECRET MFA_SECRET_KEY SMTP_PASSWORD; do',
      'value="$(sed -n "s/^$name=//p" "$settings")"; test -n "$value"',
      'if grep -qF "$value" "$RUNNER_TEMP/web.log"; then echo "$name reached the log" >&2; exit 1; fi',
      'done',
      "password=\"$(sed -n 's|^DATABASE_URL=postgresql://rd10:\\([0-9a-f]*\\)@.*|\\1|p' \"$settings\")\"",
      'test -n "$password"',
      'if grep -qF "$password" "$RUNNER_TEMP/web.log"; then',
      'echo "The database password reached the log" >&2',
      'exit 1',
      'fi',
    ]);
  });

  it("installs from the lockfile alone, offline after fetching it", () => {
    const installs = ofKind(instructions(file), "RUN").filter((l) =>
      /\b(?:pnpm|npm|yarn)\b (?:i|install|add|fetch)\b/.test(l),
    );
    expect(installs).toEqual(["RUN pnpm fetch --frozen-lockfile", "RUN pnpm install --frozen-lockfile --offline"]);
  });

  it("refuses a .env that Prisma reads or Next.js copies, and needs Prisma's OpenSSL 3 engine alone", () => {
    const text = instructions(file).join("\n");
    expect(text).toContain("for f in .env packages/database/.env packages/database/prisma/.env apps/web/.env*;");
    expect(text).toContain("-name 'libquery_engine-debian-openssl-3.0.x.so.node' | grep -q . && !");
    expect(text).toContain("-name 'libquery_engine-debian-openssl-1.1.x.so.node' | grep -q . ; } || {");
  });

  it("runs a stage of exactly ADR-0175 Decision 5", () => {
    expect(finalStage(file)).toEqual([
      `FROM node:22-trixie-slim@${DIGEST} AS runtime`,
      [
        "RUN apt-get -o Acquire::Retries=3 update",
        "&& apt-get -o Acquire::Retries=3 install --yes --no-install-recommends ca-certificates",
        "&& rm -rf /var/lib/apt/lists/* && test -s /etc/ssl/certs/ca-certificates.crt",
      ].join(" "),
      [
        "ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_DIR=/etc/ssl/certs",
      ].join(" "),
      "WORKDIR /app",
      "COPY --from=build /repo/apps/web/.next/standalone ./",
      "COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static",
      "USER 1000:1000",
      "EXPOSE 3000",
      'ENTRYPOINT ["/usr/bin/env", "-u", "NEXT_PHASE", "node", "apps/web/server.js"]',
    ]);
    expect(ofKind(instructions(file), "ENTRYPOINT")).toHaveLength(1);
    expect(ofKind(instructions(file), "CMD")).toEqual([]);
  });
});

describe("the worker image", () => {
  const file = "apps/worker/Dockerfile";
  const refusal = "The worker has no production runtime until part 2 (ADR-0151 Decision 4).";
  const lines = (...text: string[]): string => text.join("\n");
  const words = (...text: string[]): string => text.join(" ");

  it("is exactly ADR-0176's three stages: FFmpeg, the media suites on it, and the runtime layer", () => {
    expect(instructions(file)).toEqual([
      `FROM node:22-trixie-slim@${DIGEST} AS ffmpeg`,
      [
        "RUN apt-get -o Acquire::Retries=3 update",
        "&& apt-get -o Acquire::Retries=3 install --yes --no-install-recommends ffmpeg",
        "&& rm -rf /var/lib/apt/lists/*",
      ].join(" "),
      "FROM ffmpeg AS media-test",
      "ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "WORKDIR /repo",
      "RUN corepack enable",
      "COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./",
      "RUN pnpm fetch --frozen-lockfile",
      "COPY . .",
      "RUN pnpm install --frozen-lockfile --offline",
      'CMD ["node_modules/.bin/vitest", "run", "--config", "vitest.media.config.ts"]',
      "FROM ffmpeg AS runtime",
      "COPY assets/disclosure/layer-v1-*.png /app/assets/disclosure/",
      "COPY apps/worker/image/disclosure-layers.sha256 /app/assets/disclosure.sha256",
      "COPY apps/worker/image/check.sh /usr/local/bin/worker-image-check",
      "USER 1000:1000",
      `CMD ["/bin/sh", "-c", "echo '${refusal}' >&2; exit 2"]`,
    ]);
  });

  it("leaves exactly the required lines out of its context, so every media suite reaches the stage", () => {
    const ignores = raw(`${file}.dockerignore`)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(ignores).toEqual(REQUIRED_IGNORES);
  });

  it("checks FFmpeg's series and libx264, then the images, word for word, from a file Git keeps executable", () => {
    expect(statSync(join(REPO_ROOT, "apps/worker/image/check.sh")).mode & 0o111).toBe(0o111);
    const text = raw("apps/worker/image/check.sh").split("\n");
    expect(text.slice(0, 1)).toEqual(["#!/bin/sh"]);
    // Comments may change; every other line is held, so none is piped, loosened or skipped.
    expect(text.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))).toEqual([
      "set -eu",
      'series="7.1"',
      'list="/app/assets/disclosure.sha256"',
      "nl='",
      "'",
      "refuse() {",
      '  echo "worker-image-check: refused: $1" >&2',
      "  exit 1",
      "}",
      "check_series() {",
      '  out=$("$1" -hide_banner -version) || refuse "$1 -version failed"',
      '  first=${out%%"$nl"*}',
      '  echo "$first"',
      '  case "$first" in',
      '    "$1 version $series."* | "$1 version $series-"*) ;;',
      '    *) refuse "$1 is not of the series $series" ;;',
      "  esac",
      "}",
      "check_series ffmpeg",
      "check_series ffprobe",
      'encoders=$(ffmpeg -hide_banner -encoders) || refuse "ffmpeg -encoders failed"',
      'case "$encoders" in',
      '  *"$nl "??????" libx264 "*) echo "libx264: listed" ;;',
      '  *) refuse "ffmpeg lists no libx264 encoder" ;;',
      "esac",
      'sha256sum --check --strict "$list" || refuse "a disclosure image does not match $list"',
      "listed=0",
      "while IFS= read -r line; do",
      "  listed=$((listed + 1))",
      'done < "$list"',
      "found=0",
      "for entry in /app/assets/disclosure/* /app/assets/disclosure/.[!.]* /app/assets/disclosure/..?*; do",
      '  if [ -e "$entry" ] || [ -L "$entry" ]; then found=$((found + 1)); fi',
      "done",
      '[ "$found" -eq "$listed" ] || refuse "/app/assets/disclosure holds $found entries, $list names $listed"',
      'echo "worker-image-check: passed"',
    ]);
  });

  /** A stand-in for `ffmpeg` or `ffprobe`: the first line of `-version`, and `-encoders` with these names. */
  const tool = (name: string, version: string, encoders: readonly string[]): string =>
    lines(
      "#!/bin/sh",
      'case "$2" in',
      `  -version) echo '${name} version ${version} Copyright (c) 2000-2025 the FFmpeg developers' ;;`,
      `  -encoders) printf '%s\\n' 'Encoders:' ' V..... = Video' ' ------' ${encoders
        .map((one) => `' V....D ${one.padEnd(20)} libx264 H.264 / AVC (codec h264)'`)
        .join(" ")} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    );

  interface CheckResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  interface CheckRun {
    readonly ffmpeg?: string;
    readonly ffprobe?: string;
    readonly encoders?: readonly string[];
    readonly change?: (images: string) => void;
  }

  /** check.sh with `/app` moved under a temporary folder, run by `/bin/sh` against stand-in tools. */
  function runCheck(run: CheckRun): CheckResult {
    const root = mkdtempSync(join(tmpdir(), "worker-image-check-"));
    try {
      const ffmpeg = run.ffmpeg ?? "7.1.2-0+deb13u1";
      const encoders = run.encoders ?? ["libx264", "libx264rgb"];
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin/ffmpeg"), tool("ffmpeg", ffmpeg, encoders), { mode: 0o755 });
      writeFileSync(join(root, "bin/ffprobe"), tool("ffprobe", run.ffprobe ?? ffmpeg, []), { mode: 0o755 });
      const images = join(root, "app/assets/disclosure");
      mkdirSync(images, { recursive: true });
      for (const asset of DISCLOSURE_LAYER_ASSETS) {
        copyFileSync(join(REPO_ROOT, "assets/disclosure", asset.fileName), join(images, asset.fileName));
      }
      const moved = (text: string): string => text.replaceAll("/app/", `${root}/app/`);
      const list = raw("apps/worker/image/disclosure-layers.sha256");
      writeFileSync(join(root, "app/assets/disclosure.sha256"), moved(list));
      writeFileSync(join(root, "check.sh"), moved(raw("apps/worker/image/check.sh")));
      run.change?.(images);
      const result = spawnSync("/bin/sh", [join(root, "check.sh")], {
        encoding: "utf8",
        env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("passes FFmpeg 7.1 with libx264 and the six images, run against stand-ins", () => {
    const result = runCheck({});
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "ffmpeg version 7.1.2-0+deb13u1 Copyright (c) 2000-2025 the FFmpeg developers",
      "ffprobe version 7.1.2-0+deb13u1 Copyright (c) 2000-2025 the FFmpeg developers",
      "libx264: listed",
      ...DISCLOSURE_LAYER_ASSETS.map((asset) =>
        expect.stringContaining(`/app/assets/disclosure/${asset.fileName}: OK`),
      ),
      "worker-image-check: passed",
      "",
    ]);
  });

  const first = DISCLOSURE_LAYER_ASSETS[0]?.fileName ?? "";
  it.each<[string, CheckRun, string]>([
    ["FFmpeg 6.1.1", { ffmpeg: "6.1.1-3ubuntu5" }, "ffmpeg is not of the series 7.1"],
    ["FFmpeg 7.10.1", { ffmpeg: "7.10.1" }, "ffmpeg is not of the series 7.1"],
    ["an ffprobe of another series", { ffprobe: "6.1.1" }, "ffprobe is not of the series 7.1"],
    ["libx264rgb alone", { encoders: ["libx264rgb"] }, "ffmpeg lists no libx264 encoder"],
    ["a changed image", { change: (images) => appendFileSync(join(images, first), "\n") }, "does not match"],
    ["a missing image", { change: (images) => rmSync(join(images, first)) }, "does not match"],
    ["a seventh image", { change: (images) => writeFileSync(join(images, "layer-v1-640x360.png"), "") }, "holds 7"],
    ["a dotfile", { change: (images) => writeFileSync(join(images, ".hidden"), "") }, "holds 7 entries"],
  ])("refuses %s with exit code 1, run against stand-ins", (_, run, reason) => {
    const result = runCheck(run);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^worker-image-check: refused: /m);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).not.toContain("worker-image-check: passed");
  });

  it("pins each disclosure image by DISCLOSURE_LAYER_ASSETS, line for line, as the files really are", () => {
    const text = raw("apps/worker/image/disclosure-layers.sha256").split("\n");
    expect(text.at(-1)).toBe("");
    expect(text.slice(0, -1)).toEqual(
      DISCLOSURE_LAYER_ASSETS.map((asset) => `${asset.sha256}  /app/assets/disclosure/${asset.fileName}`),
    );
    for (const asset of DISCLOSURE_LAYER_ASSETS) {
      const bytes = readFileSync(join(REPO_ROOT, "assets/disclosure", asset.fileName));
      expect(`${asset.fileName}: ${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        `${asset.fileName}: ${asset.sha256}`,
      );
    }
    // The image copies `layer-v1-*.png`: exactly the listed files, and only they, match it.
    const names = DISCLOSURE_LAYER_ASSETS.map((asset) => asset.fileName);
    expect(names.filter((name) => !/^layer-v1-[^/]*\.png$/.test(name))).toEqual([]);
    const copied = readdirSync(join(REPO_ROOT, "assets/disclosure")).filter((name) => /^layer-v1-.*\.png$/.test(name));
    expect(copied.sort()).toEqual([...names].sort());
  });

  it("is held step by step, word for word, in the worker-image job", () => {
    const job = readJob(raw(WORKFLOW), "worker-image");
    const build = (target: string, tag: string): string =>
      words(
        "docker buildx build --provenance=false --load --platform linux/amd64 -f apps/worker/Dockerfile",
        ...(target === "" ? [] : [`--target ${target}`]),
        '--label "org.opencontainers.image.revision=$REVISION"',
        `--tag ${tag} .`,
      );
    const layers = "docker image inspect -f '{{range .RootFS.Layers}}{{println .}}{{end}}'";
    const isolated = "docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \\";
    const find = "docker run --rm --network none --read-only --entrypoint find vtavision-worker:ci \\";
    const steps = job.steps.map((s) => [
      s.fields.get("name") ?? "",
      s.fields.get("timeout-minutes") ?? "",
      s.fields.get("run") ?? "",
    ]);
    expect(steps).toEqual([
      ["", "", ""],
      ["Build the media suites' stage", "20", build("media-test", "vtavision-worker-media:ci")],
      [
        "Run the media suites against the image's FFmpeg",
        "15",
        lines(
          "docker run --rm --network none --entrypoint ffmpeg vtavision-worker-media:ci -hide_banner -version",
          "docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges vtavision-worker-media:ci",
        ),
      ],
      ["Build the worker image", "10", build("", "vtavision-worker:ci")],
      [
        "Check that both share the FFmpeg stage",
        "",
        lines(
          `media="$(${layers} vtavision-worker-media:ci)"`,
          `worker="$(${layers} vtavision-worker:ci)"`,
          "shared=\"$(printf '%s\\n' \"$worker\" | grep . | head -n -3)\"",
          "count=\"$(printf '%s\\n' \"$shared\" | grep -c .)\"",
          'test "$count" -ge 2',
          "test \"$(printf '%s\\n' \"$media\" | head -n \"$count\")\" = \"$shared\"",
        ),
      ],
      [
        "Check the image's user, files, entrypoint and environment",
        "",
        lines(
          "test \"$(docker image inspect -f '{{.Config.User}}' vtavision-worker:ci)\" = \"1000:1000\"",
          'test "$(docker run --rm --network none --read-only --entrypoint id vtavision-worker:ci -u)" = "1000"',
          find,
          "  /app /usr/local/bin/worker-image-check -printf '%u:%g %m %p\\n'",
          `loose="$(${find}`,
          '  /app /usr/local/bin/worker-image-check ! -user 0 -o ! -group 0 -o -perm /o=w)"',
          'test -z "$loose"',
          "test \"$(docker image inspect -f '{{json .Config.Entrypoint}}' vtavision-worker:ci)\" = \\",
          "  '[\"docker-entrypoint.sh\"]'",
          "env_json=\"$(docker image inspect -f '{{json .Config.Env}}' vtavision-worker:ci)\"",
          "if printf '%s' \"$env_json\" | grep -qi proxy; then",
          '  echo "The image\'s environment names a proxy." >&2',
          "  exit 1",
          "fi",
          "docker image inspect -f '{{json .Config.Cmd}}' vtavision-worker:ci",
          "docker image inspect -f '{{json .Config.Labels}}' vtavision-worker:ci",
        ),
      ],
      ["Run the image's check", "2", lines(isolated, "  vtavision-worker:ci worker-image-check")],
      [
        "Refuse to run by default",
        "2",
        lines(
          "set +e",
          isolated,
          '  vtavision-worker:ci > "$RUNNER_TEMP/refused.log" 2>&1',
          "code=$?",
          "set -e",
          'cat "$RUNNER_TEMP/refused.log"',
          'test "$code" -eq 2',
          `grep -qF "${refusal}" "$RUNNER_TEMP/refused.log"`,
        ),
      ],
      [
        "Print what the image holds",
        "",
        lines(
          "docker run --rm --network none --read-only --entrypoint dpkg-query vtavision-worker:ci \\",
          "  -W -f '${Package}\\t${Version}\\n'",
          "docker run --rm --network none --read-only --entrypoint node vtavision-worker:ci --version",
          "docker image inspect -f '{{.Size}} bytes' vtavision-worker:ci",
        ),
      ],
    ]);
  });
});
