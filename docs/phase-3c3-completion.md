# Phase 3C-3 Completion Report — Prompt compilation and moderation

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3c3-hga252`
Base: `main` at `d7ede3a3ecd2d4ae0bf13c9ea0d19149f06ca2b9` (merged Phase 3C-2b)

Pure prompt compilation, the `PromptModerator` port, and an offline default
moderator. No repositories, no `StoryboardService`, no HTTP, no UI, no
database/schema/migration change, no provider integration, no Phase 4 work.
**Every changed file is under `packages/domain/src/storyboard/`.**

## Milestone size — over the target, reported not absorbed

| File | Changed code lines |
| --- | --- |
| `prompt.test.ts` | 232 |
| `moderation.ts` | 152 |
| `moderation.test.ts` | 134 |
| `prompt.ts` | 116 |
| `index.ts` | 2 |
| **Total** | **636** — 270 production + 366 tests |

Estimated ~530 before implementation, against a ~500 target — so I proceeded
rather than proposing a split, and the actual came in **27% over the target**
and 20% over my own estimate. Where it went:

- **`prompt.test.ts` 232 against ~150.** The injection contract is five attack
  shapes × four assertions each (text confined, preservation intact, system
  negatives intact, scene facts intact), and the sanitization contract needs a
  marker test, a both-fields test, and a no-logging test.
- **`moderation.ts` 152 against ~130.** Five rules with their patterns, the
  polarity machinery, and the fixed message table.

Nothing in the approved scope was dropped to reduce the count. If a strict ~500
matters more than the coverage, the reviewable subset to defer is the
five-shape injection table (~45 lines) and the no-logging test (~12) — but I
would rather keep them, since they are the executable form of the contract.

## The seven refinements, as implemented

### 1. Offline moderator is an explicit-violation detector

Five documented-rule patterns, each traceable to a stated product rule, plus
polarity. Its doc comment says in as many words that it is **not** the injection
defence, **not** semantic moderation, and will **not** grow a general blacklist.
**False negatives are accepted and proven**: a test asserts that "populate the
scene with a cheerful couple" passes, so the limitation is executable rather
than a comment.

### 2. Both user-authored fields are moderated

`prompt` and `negativePrompt` both go through the moderator, once each. Findings
are `{ field, code }` — the field is identified, the text never is.

### 3. Polarity avoids false positives

"do not add people", "don't add any furniture", "no added windows", and "avoid
making the room look bigger" are all allowed. The same phrases without negation
are flagged. Inverted for preservation verbs, so "do not preserve the original
walls" is caught as `DEFEATS_PRESERVATION`. That is the whole heuristic — 32
characters of look-back and one negation pattern.

### 4. System and user negatives stay structurally separate

```ts
negativeConstraints: {
  system: readonly string[],   // system-authored
  user: string | null,         // untrusted
}
```

A test asserts the user's text never appears in the system list.

### 5. Injection is contained, not detected

Five attack shapes — "ignore previous instructions…", a fake `SYSTEM:` prefix,
a JSON payload claiming `"preservation": []`, a fake end-of-prompt delimiter,
and text impersonating a preservation rule — each land verbatim in
`userCustomization` while preservation, system negatives, and scene facts come
through untouched. **Nothing is detected or stripped**; the text is simply data
in a field no constraint is read from.

### 6. Rejections are sanitized and terminal

`VALIDATION_FAILED` with `details: { findings: [{ field, code }] }` and a fixed
message. A marker string planted in a rejected prompt appears nowhere in the
serialized error. The moderator is called exactly once per non-empty field, and
a rejection triggers no retry — both asserted.

### 7. ADR-0014

`docs/decisions/0014-preservation-first-prompt-structure-and-moderation-boundary.md`
records structural separation as the primary mechanism, user text as untrusted
data, the offline moderator as a deterministic placeholder, coded findings, and
terminal rejection. It also records the obligation this places on Phase 4:
rendering must preserve the separation.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **399/399** in 32 files (34 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| `packages/database/` diff | **zero** |
| `apps/` diff | **zero** |
| Prisma schema + migrations diff | **zero** |

### Test matrix (34 cases)

| Area | Cases |
| --- | --- |
| Documented rules | each of the four prohibitions flagged by a clear case; multiple violations return multiple codes; an ordinary creative prompt allowed |
| Polarity | four negated phrasings allowed; the same phrase unnegated flagged; two preservation-defeating negatives caught; a prompt *asking* for preservation allowed |
| Verdict shape | field named; no offending text in the serialized verdict; a fixed sentence exists per code; deterministic; adapter named |
| Acknowledged limits | a paraphrase passes — recorded as a passing test |
| Preservation | all four rules in every compilation, including with no user text; mutating a returned prompt cannot affect the next call |
| Separation | five parts in their own fields; user negative never in the system list; scene facts free of user text; null room type not guessed |
| Injection | five attack shapes confined to their field with preservation, system negatives, and scene facts intact; same for the negative field |
| Moderation calls | once per non-empty field, in order; absent field not moderated; no retry after rejection |
| Sanitization | marker absent from message and details; findings from both fields reported without merging text; nothing written to console |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ADR | **New** — ADR-0014 |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md` |
| Open decisions | Updated — `docs/decisions/TODO.md`, two new entries |
| ER diagram, migration notes, architecture diagram, API summary, sequence diagram | **Unchanged** — nothing persists, transacts, or is exposed |

## Known limitations

- **The offline moderator misses paraphrase.** By design and by passing test.
  It catches explicit violations only; a real vendor behind the same port is the
  fix, recorded in TODO.
- **Nothing calls these functions yet.** `StoryboardService` (3C-4) is the first
  consumer.
- **Phase 4 must not flatten `CompiledPrompt`.** The separation is only as good
  as the renderer that consumes it; ADR-0014 states the obligation, but no code
  enforces it yet because no renderer exists.
- Profanity, competitor-name, and advertising-law rules remain unstated business
  rules, recorded rather than invented.
- Remote publication of all fifteen `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
