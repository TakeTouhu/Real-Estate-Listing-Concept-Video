# API Changes — PT-6d

`zod` goes from 3.25.76 to 4.6.7 in `packages/shared`, its one
dependent. Production readiness, part 2, approved by the product owner
on 2026-11-26. **No migration, no new setting and no ADR**; no route,
answer or stored value changes. Only the environment schema
(`packages/shared/src/env.ts`) imports `zod`; the web app bundles it
into its server chunks through `@app/shared`, and the worker reads the
same schema.

## Why

`pnpm audit --prod` on 2026-11-26, on the base (`main @ 4c5bbbc`) and
with `zod` 4.6.7:

| `pnpm audit --prod` | Critical | High | Moderate | Total |
| --- | --- | --- | --- | --- |
| before | 0 | 3 | 5 | 8 |
| `zod` 4.6.7 | 0 | 2 | 5 | 7 |

`zod` 3.25.76 held one high advisory (GHSA-mrhx-c7xc-m3w5, memory
exhaustion while validating oversized constrained collections), fixed
in 4.6.6. The lockfile now holds one `zod`, 4.6.7, which
`tests/dependency-overrides.test.ts` holds; the bump changed nothing
else in it. Still open, as after PT-6c: `postcss` 8.4.31, which `next`
pins (two high, two moderate), and `next`'s three moderates, which do
not apply here (`docs/api-changes-next-15-5-28.md`).

## What changes in `env.ts`

Each change keeps what the schema takes, what it returns and the
words of every refusal the schema writes itself.

- `ZodIssueCode.custom`, deprecated in `zod` 4, becomes the literal
  `"custom"` in each `addIssue`.
- `LOG_PRETTY`'s default is the text `"false"`. `zod` 4's `default`
  returns its value without parsing it, so it would return the text,
  not `false`; `prefault` parses it as `zod` 3's `default` did.
- `z.string().url()` is deprecated, and `zod` 4's address check trims
  the value and drops its tabs and line breaks before returning it, so
  `" https://app.example.com"` would come back changed, and an address
  wrapped in a no-break space, which the URL parser refuses, would be
  taken. The four address settings now use `absoluteUrl`, a string
  taken when `new URL` parses it, as `zod` 3 asked, kept as written,
  refused with `zod` 3's words, `Invalid url`, which `env.test.ts`
  holds. It does not ask `URL.canParse`: on Node 22.23.4, once called
  often, that refuses a host such as `münchen.example` that `new URL`
  takes, and `env.test.ts` holds the address taken after 100,000
  such calls.
- `z.enum` becomes `oneOf`, a `z.enum` whose refusal keeps `zod` 3's
  words, which `env.test.ts` holds: `Invalid enum value. Expected
  'development' | 'test' | 'production', received 'staging'`. `zod`
  4's own, `Invalid option: expected one of
  "development"|"test"|"production"`, repeats no value and lists
  `LOG_PRETTY`'s words as `"0"|"1"|"true"|"false"`.
- The tests read the schema's settings as `serverEnvSchema.shape`:
  `superRefine` no longer wraps the object, so `innerType()` is gone
  (`env.test.ts`, `tests/container-images.test.ts`). The fal dormancy
  test looks for `VIDEO_PROVIDER: oneOf(["fake", "wavespeed"])` where
  it looked for the `z.enum`.

The five number settings (`SESSION_TTL_SECONDS`,
`USER_SESSION_TTL_SECONDS` and the three `WAVESPEED_POLL_*_MS`) keep
`z.coerce.number().int().positive()`; what that changes is below.

## How it was measured

A script outside the repository ran `loadServerEnv` over 3,646
environments, of fake values only, against the unchanged `env.ts` with
`zod` 3.25.76 and against the changed one with 4.6.7, and compared
each result: the parsed value with its keys in order, or the thrown
message. For each setting, in development and in production: unset,
empty, blank, padded, Unicode and 300 characters, plus per kind 46
addresses (database URLs with credentials, http(s), none or another
scheme, `localhost:3000`, spaces, tabs, line breaks, no-break spaces,
an IDN), 28 numbers (`0`, `-1`, `1.5`, `abc`, `" 7 "`, `1e3`, `""`,
`Infinity`, 2^53 and beyond, hex, binary), each listed word in upper
case and padded, and the other settings' own good and bad forms. 34
cross-field cases ran alone and beside each of 16 field refusals. V8
coverage of `env.ts` under the corpus: every line, every function and
every `addIssue` and refinement; the three uncovered branches are a
cached result, an issue with no path and an address that does not
parse reaching `isGoogleApiAddress`, which the schema never sends it.

Result: 3,148 identical (858 taken, 2,290 refused alike); none refused
before is taken now; no taken value differs. Of the 498 others, 302
are refused alike, in `zod`'s own words, which changed:

| Before (`zod` 3) | After (`zod` 4) | When |
| --- | --- | --- |
| `Required` | `Invalid input: expected string, received undefined` | a secret unset |
| `String must contain at least 1 character(s)` | `Too small: expected string to have >=1 characters` | `SHARED_STORAGE_DIR`, `EMAIL_OUTBOX_DIR`, `WAVESPEED_API_KEY`, `WAVESPEED_VIDEO_MODEL_ID` or `WAVESPEED_WEBHOOK_SECRET` empty |
| `Number must be greater than 0` | `Too small: expected number to be >0` | a number setting 0 or below, or empty |
| `Expected number, received nan` | `Invalid input: expected number, received NaN` | not a number |
| `Expected integer, received float` | `Invalid input: expected int, received number` | a fraction |
| `Expected integer, received float` | `Invalid input: expected number, received Infinity` | `Infinity` or `1e400` |

Each line still starts with the setting's name; none repeats a written
value, except `Infinity` and `-Infinity` themselves. No test held these
words, so `zod` 4's are kept. Where the words stayed, some issue
`code`s changed: `invalid_enum_value` is `invalid_value` (`oneOf`),
and `invalid_string` is `custom` (`absoluteUrl`) or `invalid_format`
(`MFA_SECRET_KEY`). `serverEnvSchema` is exported, but nothing in the
repository reads an issue's `code`; `loadServerEnv` prints only the
path and the message. The other 196:

- **132**: refused alike, with fewer lines. In `zod` 4 a fraction or
  an infinity in a number setting skips the cross-field checks (each
  other setting is still checked), so the cross-field refusals (and,
  for a negative one, the "above 0" one) are listed only once it is
  fixed; `zod` 3 listed them at once. The start is refused either way.
  `-Infinity` now reads `received -Infinity`.
- **38**: taken before, refused now: a number setting of 2^53
  (9,007,199,254,740,992) or more, refused as `Too big: expected int
  to be <=9007199254740991`. `zod` 3's taking them was a defect: past
  2^53 a JavaScript number cannot hold every whole number, so
  `9007199254740993` was read as `9007199254740992`, a value nobody
  wrote. `zod` 4 refuses every whole number past
  `Number.MAX_SAFE_INTEGER`, the exact `1e16` too. Each setting is a
  lifetime or an interval in seconds or milliseconds, whose default is
  at most 604,800.
- **26**: refused before, now with one more line: the same `1e16`
  beside a cross-field refusal.

Not in the corpus, and found in review: a number setting of -2^53 or
below is refused with one more line, `Too small: expected int to be
>=-9007199254740991`, beside `Too small: expected number to be >0`;
`zod` 3 wrote only `Number must be greater than 0`.

`env.test.ts` adds the default of `LOG_PRETTY`, an address kept as
written and one wrapped in no-break spaces refused, a host with a
Latin-1 letter taken after `URL.canParse` has run often, the words of
a `LOG_PRETTY` refusal and the safe-integer bound.

## What was not measured

The corpus is synthetic and runs under Vitest, not under the built web
app's server chunks or the worker's start; the production build, the
unit suite, typecheck and lint ran, and the browser and database
suites did not run here. No deployed environment exists to compare.
Nothing measured whether a real value past 2^53 is set anywhere.
