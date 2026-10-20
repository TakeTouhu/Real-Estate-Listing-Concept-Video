# Completion — the AI-generated disclosure (Mode A) and the Clean Master

Branch: `claude/project-thread-az06z2`
ADRs: `docs/decisions/0071-ai-disclosure-layer.md` (DS-1)
Plan: `/mnt/project-files/cto/disclosure-proposal.md`, approved by the product
owner on 2026-10-20

The product owner approved building the AI-generated disclosure's Mode A
(ADR-0052 Decision 8) and the overlay-free Clean Master (ADR-0052 Decision 17)
as a series of pull requests, before anything can deliver a video:

1. **DS-1**: the disclosure layer v1, its look decided and its images
   committed.
2. **DS-2**: FFmpeg in CI, and a real encode with the disclosure laid over a
   synthetic clip.
3. **DS-3**: the disclosure mode on the generation job and each deliverable
   version, frozen at admission, Mode A only.
4. **DS-4**: the Clean Master record and its private storage location, refused
   by every download path.
5. **DS-5**: composition makes the Clean Master, then the customer's video from
   it.
6. **DS-6**: publication requires the disclosure of the job's mode and a Clean
   Master, and that the measured video matches its planned size and length.

Each extends this record. The disclosure is not a Roadmap phase, so it receives
no `phase-N-complete` tag.

## DS-1 — the disclosure layer v1

Base: `e424d04` (PR #93 merge commit on `main`).
ADR: `docs/decisions/0071-ai-disclosure-layer.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `0f2ec41` | the domain table, the renderer and its command, the font, the six images, their tests, ADR-0071 and the documentation |
| `7844e81` | the shadow without the blur that changed nothing, and the re-render test comparing colour (both found by the mutation pass, below) |
| this commit | this record |

The exact head SHA is reported with the pull request.

### What DS-1 does

- **The exact text, once.** `AI_DISCLOSURE_TEXT` in `@app/domain` is
  「本コンテンツは生成AIを使用して作成しています。」, character for character.
- **Mode A's geometry for every size composition can produce.**
  `disclosureLayout` puts the text bottom-right, 3% of the width in from the
  right and 3% of the height up from the bottom, at 1.25% of the height and
  never under 12 pixels (ADR-0071 Decision 2).
- **The look the product owner chose on 2026-10-20**, option C on the decision
  card: white at 70% over a faint black shadow, the same letters one pixel
  down and right at 60%; no box; and the 12-pixel minimum, which changes only the
  720p landscape and square frames from 9 pixels to 12.
- **Six committed images**, one transparent PNG the size of each raster
  composition profile v1 produces, with the text already in place, so the
  composer will lay it over the video at the origin. Each is pinned by SHA-256
  in `DISCLOSURE_LAYER_ASSETS`, and a size outside the table has none
  (Decision 1).
- **The font that drew them**, Noto Sans JP Regular cut down to the sentence's
  characters, 10 KB, with its licence and provenance (Decision 3), and the
  command that renders them again, run by hand only.

Nothing anyone can notice changes. No composition, validation, publication,
schema, page or worker reads the layer (Decision 5); DS-3 to DS-6 put it into a
video.

### Rendering the images, and checking them

```mermaid
sequenceDiagram
  autonumber
  participant D as Developer
  participant C as render-disclosure-layers
  participant T as @app/domain table
  participant S as sharp (Pango)
  participant A as assets/disclosure
  participant V as Vitest

  D->>C: pnpm --filter @app/storage render-disclosure-layers
  loop each of the six sizes
    C->>T: disclosureLayout(width, height)
    C->>S: the sentence, white and black, at the text height, from the bundled font
    S-->>C: glyphs cropped to their ink
    C->>C: the black glyphs offset 1 px, at 60%; the white ones at 70%
    C->>C: both onto a transparent frame, bottom-right inside the margins
    C->>A: layer-v1-WxH.png
    C-->>D: its SHA-256, for the table
  end
  V->>A: each committed image
  V->>T: its pinned SHA-256 and its layout
  V->>V: size, alpha, ink inside the margins, nothing opaque
  V->>S: render it again from the bundled font
  V->>V: the ink in exactly the same rectangle, colour and alpha within 16 of 255
```

### Verification

Measured locally (PostgreSQL 16, configured like CI) on `7844e81`; the commit
after it adds this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5732 / 5732**, 200 files (was 5685, 197 files, on `e424d04`) |
| `pnpm test:db` | **1439 / 1439**, 53 files (unchanged: DS-1 touches no database code) |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 29 migrations, up to date (no new migration) |
| the font and the images, reproduced | the subset cut again from the npm tarball's font is byte-identical; the command run again wrote six byte-identical images |

New tests (47 unit):
- **the table** (`ai-disclosure.test.ts`, 14): the sentence and its 24
  characters; the text height and both margins for each of the six sizes,
  and that those sizes are exactly the ones composition profile v1 resolves;
  1.25% with a half rounded up and the 12-pixel minimum at its edges
  (1080 → 14, 1040 → 13, 959 → 12, 1000 → 13, 100 → 12); margins on their own
  axis; the opacities, shadow and layer key pinned; one image per size, named
  for it, with a distinct checksum; a size outside the table, or transposed,
  has none;
- **shape** (`disclosure-shape.test.ts`, 2): the renderer is called only from
  the command; neither application, the managed-output code, composition,
  validation nor the database package names the layer;
- **the images** (`render-disclosure-layer.test.ts`, 31): the bundled font is
  the pinned subset; for each image, the committed file is the one the table
  pins, it is the frame's size with an alpha channel, its ink sits
  bottom-right inside the margins (allowing the shadow's pixel), is the text
  height to three pixels taller, and is more than twenty times as wide as it
  is tall; white is at most 70% opaque, black at most 60%, their overlap at
  most 88%; and rendering it again puts the ink in the same rectangle, with
  no pixel's colour or opacity more than 16 of 255 apart.

### Mutation ledger

**35 mutants, all killed, 0 broken, 0 anchor-missing**, in the second of two
passes, on the code of `7844e81`. Each mutant weakens one guarantee at an anchor
that occurs exactly once, and runs against the suites listed for it until one
fails:

- **domain**: the disclosure table and shape tests (16);
- **storage**: the committed images' tests (31).

Every mutated file was restored and re-hashed, and all 903 files were
byte-identical after each pass.

**The first pass, on `0f2ec41`, left three mutants alive**, and two of them
were real:

- *The shadow not softened* changed no pixel. sharp's `blur(0.5)` builds a
  Gaussian kernel and drops every tap below its minimum amplitude, 0.2; at
  σ 0.5 the nearest neighbour's weight is e⁻² ≈ 0.14, so only the centre
  remained and the blur did nothing. The sample frames the product owner
  chose from were made the same way, so the shadow they saw, and the one
  committed, is the letters in black one pixel down and right, unblurred.
  `7844e81` removes the blur and the padding it needed, and ADR-0071 and the
  table now describe the shadow as it is; the six images re-render byte for
  byte the same.
- *The text drawn grey* passed, because the re-render test compared opacity
  only. It now compares each pixel's colour, weighted by its opacity, as well:
  grey instead of white is 36 apart, over the tolerance of 16.
- *The text drawn at 96 dpi* changed nothing either: Pango sizes a font given
  in pixels without the resolution (checked at 72, 96 and 300 dpi, identical).
  `7844e81` drops the option, so the mutant has nothing left to change.

The second pass dropped those three (L05, R08 and R10 in the first pass) and
added three on the renderer as it now is: R08, a new mutant under the old
number, R13 and R14. L03 and L04 were re-anchored on the shorter shadow
constant.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| T01 | text | the sentence loses its final full stop | `ai-disclosure.ts` | 1 of 16 (domain) |
| T02 | text | a different word for generative AI | `ai-disclosure.ts` | 1 of 16 (domain) |
| G01 | size | the text 1.2% of the height | `ai-disclosure.ts` | 5 of 16 (domain) |
| G02 | minimum | no 12-pixel minimum | `ai-disclosure.ts` | 3 of 16 (domain) |
| G03 | minimum | a 9-pixel minimum, as approved before the product owner's choice | `ai-disclosure.ts` | 3 of 16 (domain) |
| G04 | minimum | the minimum read as a maximum | `ai-disclosure.ts` | 7 of 16 (domain) |
| G05 | rounding | a half rounded down | `ai-disclosure.ts` | 3 of 16 (domain) |
| G06 | margin | the right margin taken from the height | `ai-disclosure.ts` | 5 of 16 (domain) |
| G07 | margin | the bottom margin taken from the width | `ai-disclosure.ts` | 5 of 16 (domain) |
| G08 | margin | a 2% margin | `ai-disclosure.ts` | 7 of 16 (domain) |
| L01 | opacity | the text at 80% | `ai-disclosure.ts` | 1 of 16 (domain) |
| L02 | opacity | the text opaque | `ai-disclosure.ts` | 1 of 16 (domain) |
| L03 | shadow | the shadow at 90% | `ai-disclosure.ts` | 1 of 16 (domain) |
| L04 | shadow | the shadow two pixels out | `ai-disclosure.ts` | 1 of 16 (domain) |
| L06 | version | the look's identity not versioned | `ai-disclosure.ts` | 1 of 16 (domain) |
| I01 | checksum | one image's checksum not the committed file's | `ai-disclosure.ts` | 1 of 31 (storage) |
| I02 | table | two sizes share one image | `ai-disclosure.ts` | 1 of 16 (domain) |
| I03 | lookup | the image found by width alone | `ai-disclosure.ts` | 1 of 16 (domain) |
| I04 | lookup | an unknown size given the first image | `ai-disclosure.ts` | 1 of 16 (domain) |
| I05 | lookup | a transposed size accepted | `ai-disclosure.ts` | 1 of 16 (domain) |
| R01 | place | the text against the right edge | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R02 | place | the text against the bottom edge | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R03 | place | the text bottom-left | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R04 | shadow | the shadow cast up and left | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R05 | opacity | the text drawn opaque | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R06 | shadow | the shadow drawn opaque | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R07 | shadow | no shadow at all | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R08 | shadow | the shadow directly under the text | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R09 | size | the text drawn two pixels larger | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R11 | colour | the text drawn grey | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R13 | colour | the shadow drawn grey | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R14 | order | the shadow laid over the text | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| R12 | font | the text drawn in the machine's own sans-serif | `render-disclosure-layer.ts` | 6 of 31 (storage) |
| S01 | dormant | composition reads the image table | `profile.ts` | 1 of 16 (domain) |
| S02 | dormant | the worker renders the layer itself | `index.ts` | 1 of 16 (domain) |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: a new row for the disclosure layer v1, which no composition draws yet |
| Entity-relationship diagram | Not applicable: DS-1 adds no table, column or relation |
| Critical sequence diagram | this section, *Rendering the images, and checking them* |
| OpenAPI / API change summary | `docs/api-changes-ds-1.md`: no route or page; the domain and storage exports, the command and the files |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-1*: no migration, nothing changes at deploy |
| Completion report | this file |

Also updated: `docs/local-setup.md` (rendering the images again),
`docs/Roadmap.md`, `docs/decisions/TODO.md` (the disclosure item, in progress)
and `assets/disclosure/README.md` (provenance). ADR-0052, the approved product
contract, is unchanged: ADR-0071 Decision 2 records the two additions the
product owner chose.

### Activation status

Nothing paid or scheduled is activated. DS-1 adds constants, images, a font and
a command run by hand: no worker, scheduler, credential, environment variable
or payment integration, and its one new development dependency (`tsx`, the
version `apps/ops` already uses) runs only that command. Paid Provider
Activation, production credentials, the production scheduler and live Stripe
charges remain BLOCKED.

### Known limitations

- **No video carries the disclosure yet.** That is DS-3 to DS-6, and until
  DS-6 publication does not require it. Nothing can deliver a video today, so
  no customer receives one without it.
- **Only the six sizes composition profile v1 produces have an image.** A new
  size needs a new image, rendered and reviewed, before it can be composed.
- **The re-render test allows an edge's opacity to differ by up to 16 of 255**,
  in case a different build of the text renderer shades it differently; it
  pins the text's position exactly. CI and local development use the same
  prebuilt libvips, so they render identically today.
- **Mode B (shown for a limited time) and Mode C (omitted)** are not built;
  ADR-0071 Decision 6 says how Mode B will reuse the same image.
- **The text on a busy, mid-grey background** is legible but faint, as the
  product owner saw on the sample frames; that is the look chosen.

### Remaining work

DS-1 waits for the product owner's yes before merge. DS-2 (FFmpeg in CI) comes
next, after it.
