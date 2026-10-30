# API Changes — GS-9c

The development pipeline command (ADR-0108). **No migration; no route, no page
and no environment variable.** A person or a test runs it on a development
machine, with the test provider only; it is refused in production.

## HTTP

No change.

## Command line

### Added: `pnpm --filter @app/worker pipeline`

```bash
pnpm --filter @app/worker pipeline --provider-folder <absolute path> \
  [--limit <1 to 25>] [--max-cycles <1 to 1000>]
```

| Option | Meaning |
| --- | --- |
| `--provider-folder` | required: the test provider's own folder for its clips, absolute |
| `--limit` | items each step takes per pass; 10 if omitted |
| `--max-cycles` | cycles one run may take; 50 if omitted |

Needs `DATABASE_URL`, `VIDEO_PROVIDER=fake`, `SHARED_STORAGE_DIR` and the
server environment's other variables; `DATABASE_URL` must name a database on
this machine. Prints one line per cycle and one for the run, counts only. Exit
status: 0 nothing more to do now, 1 stopped or a step reported a failure, 2
refused before any step ran.

## Internal API

### Added: `apps/worker`, `src/development-pipeline/command.ts`

| Item | What it is |
| --- | --- |
| `parsePipelineArguments(argv)` | the options above, validated; an error names the option or the kind of mistake, never echoes what was typed |
| `refuseRemoteDatabase(databaseUrl)` | throws `CONFIGURATION_ERROR` unless the address names `localhost`, `127.0.0.1` or `[::1]` (a `host` parameter only as a socket path); never prints it |
| `refuseForeignAttempts(prisma)` | throws `CONFIGURATION_ERROR` when any scene attempt names a provider other than `fake`; reads one count |
| `PipelinePasses` | the methods the command calls, taken from the assembly's `DevelopmentPipeline` |
| `PIPELINE_ORDER` | the twelve steps of a cycle, in order |
| `runDevelopmentPipeline(steps, { limit, maxCycles }, onCycle?)` | runs cycles until cycles that change nothing have read both windows through, a step throws, the submission stops or the limit is reached; counts every outcome as a change, a failure or neither; returns `{ cycles, stop, totals }` |
| `pipelineExitCode(report)` | 0 or 1, as above |
| `formatPipelineCycle`, `formatPipelineReport` | the printed lines |
| `USAGE`, `MAX_PIPELINE_LIMIT` (25), `MAX_PIPELINE_CYCLES` (1000) | the usage text and the options' ceilings |

### Added: `apps/worker`, `src/development-pipeline/cli.ts`

The entry point: parses, loads the environment, checks the database's address,
assembles, checks what the database holds, runs, prints and disconnects. It is
the worker's `pipeline` script.

### Changed: static tests

| Item | Change |
| --- | --- |
| Dormancy tests of media validation, media recovery, scene delivery, composition execution, provider output, managed output and fal's status adapter | admit `apps/worker/src/development-pipeline/command.ts` by name for the call of a step's pass, and for nothing else; ADR-0108 Decision 8 lists them |
| `apps/worker/src/development-pipeline/dormancy.test.ts` | the folder's four files; only the command runs a pass, only the entry point reads the command line, only the `pipeline` script names the folder, and neither the root's scripts nor CI run it; `node:timers`, `scheduler.wait` and `Atomics.wait` banned with the other timers |
