import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "@app/shared";

/**
 * The rules every container image's recipe keeps (RD-10a, ADR-0175), read as
 * text: a pinned base and one digest for all, no build argument, no timer, no
 * proxy, secret or setting baked in, a numeric non-root user, an ignore file
 * that keeps secrets and outputs out of the build context, and a workflow that
 * builds each image and pushes none. A later image adds its Dockerfile here.
 */
const REPO_ROOT = join(__dirname, "..");
const DOCKERFILES = ["apps/web/Dockerfile"];
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

/** A step of the `web-image` job: its scalar fields, its `with:` and its `run:` text. */
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
const BUILD = new RegExp(
  [
    "^docker buildx build --provenance=false --load --platform linux/amd64 -f (\\S+)",
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

  it("are each built in the web-image job, which reads, builds and runs, and nothing else", () => {
    const ci = raw(WORKFLOW);
    const job = readJob(ci, "web-image");
    expect(job.unknown).toEqual([]);
    expect([...job.keys.keys()].sort()).toEqual(["env", "permissions", "runs-on", "steps", "timeout-minutes"]);
    expect([...job.permissions]).toEqual([["contents", "read"]]);
    expect([...job.env]).toEqual([["REVISION", "${{ github.sha }}"]]);

    const [checkout, ...rest] = job.steps;
    expect(checkout?.fields.get("uses")).toBe("actions/checkout@v4");
    expect([...(checkout?.with ?? [])]).toEqual([["persist-credentials", "false"]]);
    expect(rest.filter((s) => s.fields.has("uses") || s.with.size > 0)).toEqual([]);
    const guarded = job.steps.filter((s) => s.fields.has("if")).map((s) => [s.fields.get("name"), s.fields.get("if")]);
    expect(guarded).toEqual([["Stop the server", "always()"]]);

    const built: string[] = [];
    for (const command of job.steps.flatMap((s) => commands(s.fields.get("run") ?? ""))) {
      for (const [, one = "", two = ""] of command.matchAll(/\bdocker\s+(\S+)(?:\s+(\S+))?/g)) {
        const sub = one === "image" || one === "buildx" ? `${one} ${two}` : one;
        expect(`${command}: ${DOCKER_COMMANDS.includes(sub)}`).toBe(`${command}: true`);
        if (sub !== "buildx build") continue;
        const file = BUILD.exec(command)?.[1];
        expect(`${command}: ${file !== undefined}`).toBe(`${command}: true`);
        if (file !== undefined) built.push(file);
      }
    }
    expect(built.sort()).toEqual([...DOCKERFILES].sort());

    const outside = ci.split(/\r?\n/).filter((_, i) => i < job.first || i >= job.last);
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
