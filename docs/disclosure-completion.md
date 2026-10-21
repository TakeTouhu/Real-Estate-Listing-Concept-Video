# Completion — the AI-generated disclosure (Mode A) and the Clean Master

Branch: `claude/project-thread-az06z2`
ADRs: `docs/decisions/0071-ai-disclosure-layer.md` (DS-1),
`docs/decisions/0072-real-ffmpeg-media-suites.md` (DS-2),
`docs/decisions/0073-disclosure-mode-frozen-at-admission.md` (DS-3),
`docs/decisions/0074-clean-master-record-and-internal-location.md` (DS-4),
`docs/decisions/0075-clean-master-encode-and-disclosure-overlay.md` (DS-5a),
`docs/decisions/0076-clean-master-store-and-inspection.md` (DS-5b-1)
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
   it, in three pull requests: DS-5a, the composer's two encodes; DS-5b-1, the
   master's store and the inspector that checks it; and DS-5b-2, composition
   running all of them.
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
| `eac4cab` | this record |
| `26d485b` | the bundled font renamed to its own family, on a wrong diagnosis of CI's failure (below); reverted in `d517fdc` |
| `4e36412` | this record, for `26d485b` |
| `d517fdc` | the images drawn under their own font configuration, which fixes CI (below); the rename reverted; the command writing only into `--out`; exact margins and no colour in the image tests; the ADR's ink height (the last three from the review, below) |
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
  characters, 10 KB, with its licence and provenance, and the font
  configuration they are drawn under, which loads no installed font and turns
  hinting and sub-pixel colour off (Decision 3). The command that renders them
  again writes into another directory and says whether each is the committed
  image; it is run by hand only.

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
  participant S as sharp (Pango, fontconfig)
  participant O as --out directory
  participant A as assets/disclosure
  participant V as Vitest

  D->>C: pnpm --filter @app/storage render-disclosure-layers --out dir
  C->>C: refuse no --out, or assets/disclosure (exit 2)
  C->>C: FONTCONFIG_FILE = assets/disclosure/fonts.conf, before any text is drawn
  loop each of the six sizes
    C->>T: disclosureLayout(width, height)
    C->>S: the sentence, white and black, at the text height, from the bundled font
    S-->>C: glyphs cropped to their ink, unhinted, grey levels only
    C->>C: the black glyphs offset 1 px, at 60%; the white ones at 70%
    C->>C: both onto a transparent frame, the text ending on the margins
    C->>O: layer-v1-WxH.png
    C-->>D: its SHA-256, and whether it is the committed image
  end
  C-->>D: exit 0 if all six are, else 1
  V->>V: FONTCONFIG_FILE = fonts.conf, before any text is drawn
  V->>A: each committed image
  V->>T: its pinned SHA-256 and its layout
  V->>V: size, alpha, ink exactly on the margins, nothing opaque, no colour
  V->>S: render it again from the bundled font
  V->>V: the ink in exactly the same rectangle, colour and alpha within 16 of 255
```

### Verification

Measured locally (PostgreSQL 16, configured like CI) on `d517fdc`.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5741 / 5741**, 200 files (was 5685, 197 files, on `e424d04`) |
| `pnpm test:db` | **1439 / 1439**, 53 files (unchanged) |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 29 migrations, up to date (no new migration) |
| the font and the images, reproduced | the subset cut again from the npm tarball's font is byte-identical; the command wrote six images, each "is the committed image", exit 0, both with this machine's own font settings and with a stock Ubuntu configuration (below) |
| the command's refusals | without `--out`, and with `--out assets/disclosure`, it wrote nothing and exited 2 |

New tests (56 unit):
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
- **the font and its configuration** (`render-disclosure-layer.test.ts`, 4):
  the bundled font is the pinned subset and holds the family the renderer asks
  for; the configuration loads no installed font (no `dir`, `include` or
  `cachedir`) and assigns anti-aliasing, no hinting, no sub-pixel colour and
  no LCD filter; the renderer refuses to draw under any other;
- **the images** (`render-disclosure-layer.test.ts`, 36): for each image, the
  committed file is the one the table pins; it is the frame's size with an
  alpha channel; its ink ends exactly one pixel (the shadow) inside the right
  and bottom margins, is the text height plus the shadow's row, or one row
  more, and is more than twenty times as wide as it is tall; white is at most
  70% opaque, black at most 60%, their overlap at most 88%; it has no coloured
  pixel; and rendering it again under the bundled configuration has no
  coloured pixel, puts the ink in the same rectangle and has no pixel's colour
  or opacity more than 16 of 255 apart.

### Mutation ledger

**39 mutants, all killed, 0 broken, 0 anchor-missing**, in the third pass, on
the code of `d517fdc`. Each mutant weakens one guarantee at an anchor that
occurs exactly once, and runs against the suites listed for it until one fails:

- **domain**: the disclosure table and shape tests (16);
- **storage**: the font, configuration and image tests (40).

Every mutated file was restored and re-hashed, and all 905 files were
byte-identical after the pass.

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

**The second pass, on `7844e81`, killed all 35** after dropping those three
(L05, R08 and R10 in the first pass) and adding R08 (a new mutant under the
old number), R13 and R14.

**The third pass is on the font configuration fix** (below, under CI). It adds
four mutants and drops one:

- **R16** removes the renderer's refusal to draw under another configuration;
  the refusal test catches it.
- **C01** and **C02** give the bundled configuration stock Ubuntu's slight
  hinting and its red-and-blue sub-pixel drawing, the two settings that made
  CI's images differ; the configuration test and all six re-render tests
  catch each.
- **C03** makes the configuration load the machine's own. The bundled settings
  still apply after it, so on this machine the images do not change; the
  configuration test catches it by refusing any `include`.
- **R12** (the machine's own sans-serif) is now caught only by the test that
  the bundled font holds the family the renderer asks for. Under the bundled
  configuration no installed font is loaded, so any family name resolves to
  the bundled font and draws the same image; the name is checked so that the
  renderer still asks for the font it means if the configuration changes.
- **R15**, which asked for the font by a name an installed font can share, was
  run on `26d485b` against the rename (killed, 7 of 32) and went with the
  rename's revert.

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
| I01 | checksum | one image's checksum not the committed file's | `ai-disclosure.ts` | 1 of 40 (storage) |
| I02 | table | two sizes share one image | `ai-disclosure.ts` | 1 of 16 (domain) |
| I03 | lookup | the image found by width alone | `ai-disclosure.ts` | 1 of 16 (domain) |
| I04 | lookup | an unknown size given the first image | `ai-disclosure.ts` | 1 of 16 (domain) |
| I05 | lookup | a transposed size accepted | `ai-disclosure.ts` | 1 of 16 (domain) |
| R01 | place | the text against the right edge | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R02 | place | the text against the bottom edge | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R03 | place | the text bottom-left | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R04 | shadow | the shadow cast up and left | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R05 | opacity | the text drawn opaque | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R06 | shadow | the shadow drawn opaque | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R07 | shadow | no shadow at all | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R08 | shadow | the shadow directly under the text | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R09 | size | the text drawn two pixels larger | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R11 | colour | the text drawn grey | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R13 | colour | the shadow drawn grey | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R14 | order | the shadow laid over the text | `render-disclosure-layer.ts` | 6 of 40 (storage) |
| R12 | font | the text drawn in the machine's own sans-serif | `render-disclosure-layer.ts` | 1 of 40 (storage) |
| R16 | config | the renderer draws under whatever configuration the process has | `render-disclosure-layer.ts` | 1 of 40 (storage) |
| C01 | config | the configuration hints the text slightly, as stock Ubuntu does | `fonts.conf` | 7 of 40 (storage) |
| C02 | config | the configuration draws red and blue sub-pixel fringes | `fonts.conf` | 7 of 40 (storage) |
| C03 | config | the configuration loads the machine's own fonts and settings | `fonts.conf` | 1 of 40 (storage) |
| S01 | dormant | composition reads the image table | `profile.ts` | 1 of 16 (domain) |
| S02 | dormant | the worker renders the layer itself | `index.ts` | 1 of 16 (domain) |

### CI on the pull request

**CI on `eac4cab` failed the six re-render tests** (job `verify`, runs
39350689100 and 39350735148): the sentence came out a pixel narrower than the
committed images, and pixels inside it differed by up to 179 of 255. Every
other test passed.

**A first diagnosis was wrong.** Pango, given the family "Noto Sans JP" and the
bundled file, draws an installed font of that name instead, if the machine has
one; installing a decoy locally failed the same six tests. `26d485b` renamed
the bundled font's family, but CI failed again with exactly the same numbers
(run 39351634377), so the font drawn had not been the problem. `d517fdc`
reverts the rename.

**The cause is the machine's font settings.** fontconfig decides how text is
hinted and anti-aliased from the machine's configuration:

- stock Ubuntu, as on the runner, hints slightly and adds RGB sub-pixel
  fringes (`10-hinting-slight.conf`, `10-sub-pixel-rgb.conf`,
  `11-lcdfilter-default.conf`, shipped by `fontconfig-config`);
- the sandbox the images were drawn in has a local file,
  `12-unhinted-grayscale.conf`, that no package owns, forcing unhinted
  grayscale anti-aliasing.

Asking this machine's fontconfig for slight hinting alone draws the sentence
266 pixels wide instead of 267, as CI did. The independent review (below)
reproduced CI's numbers exactly by rendering under a copy of `/etc/fonts`
without the two local files: the ink a pixel to the left, differences of 177
to 185, and 1,180 to 2,958 coloured pixels per image.

**The fix** draws the images under a configuration of their own,
`assets/disclosure/fonts.conf` (ADR-0071 Decision 3). It loads no installed
font and assigns the settings the committed images were drawn with, so they
stand unchanged. The renderer refuses to draw unless `FONTCONFIG_FILE` names
it; the command and the test set it before the first text is drawn. Under the
review's stock configuration, the test file passes (40 of 40) and the command
reports all six images "is the committed image"; the renderer handed the stock
configuration instead draws a different 1280×720 image.

**CI on `d517fdc` passed**, every job of both runs (39352650006 and
39352653711).

### Review

The automated code review did not run on the pull request: it had reached its
usage limit. An independent review of the whole diff (`e424d04..eac4cab`)
traced the text, the geometry, the committed images, the font and its licence,
the paths, the bundle and the lockfile, and found:

1. **Blocking: the renderer depends on the machine's font settings.** This is
   CI's failure; the review reproduced it and proposed the fix `d517fdc` makes
   (above).
2. **The command wrote over the committed images**, which the README says
   never to do, and `local-setup.md` told developers to run it. It now writes
   only into `--out`, refuses `assets/disclosure`, and says whether each image
   is the committed one.
3. **ADR-0071 said the ink is the font's pixel size tall**; at 12 pixels it is
   13 rows. Reworded.
4. **This record said the re-render test compared opacity only**, and that CI
   and this machine render identically. Corrected under *Known limitations*.
5. **The margin test allowed two pixels either way**, so it could not catch a
   one-pixel error. The ink must now end exactly one pixel (the shadow) inside
   the margins, and a new test refuses any coloured pixel.

It also noted that the exact re-render will trip on an upgrade of sharp,
libvips or Pango (another package in the lockfile already resolves sharp
0.34.5), recorded as a known limitation.

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
- **The re-render test allows a pixel's colour or opacity to differ by up to
  16 of 255**, in case a different build of the text renderer shades an edge
  differently, and pins the text's position exactly. An upgrade of sharp, its
  libvips or Pango may move a glyph a pixel and fail it; that is meant as a
  tripwire, since images such a build draws would not be the reviewed ones.
  The committed images, not the renderer, are what ships.
- **The font configuration reaches the renderer only through
  `FONTCONFIG_FILE`, read when a process first draws text.** The command sets
  it first thing, and vitest runs the test file in a process of its own. A
  caller that draws text before setting it would be refused only if it left
  the variable unset or different.
- **The command's entry point is not unit-tested.** `src/bin/render-disclosure-layers.ts`
  wires the tested renderer to the file system; it was run by hand (above).
- **Mode B (shown for a limited time) and Mode C (omitted)** are not built;
  ADR-0071 Decision 6 says how Mode B will reuse the same image.
- **The text on a busy, mid-grey background** is legible but faint, as the
  product owner saw on the sample frames; that is the look chosen.

### Remaining work

DS-1 waits for the product owner's yes before merge. DS-2 (FFmpeg in CI) comes
next, after it.

## DS-2 — real FFmpeg in CI

Base: `89f889a` (PR #94 merge commit on `main`; post-merge CI run 616 green).
ADR: `docs/decisions/0072-real-ffmpeg-media-suites.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `64be4cb` | the `media` CI job, `tests/media/` and its configuration, ADR-0072 and the documentation |
| `1933ec3` | the first clip's timestamps start at 3 seconds, so the suite shows the composer's timeline reset matters (found by the mutation pass, below) |
| `8fa1507` | this record |
| this commit | the independent review's findings: coloured backgrounds compared by lightness, clips that change colour partway, clearer failures, and the wording below |

The exact head SHA is reported with the pull request.

### What DS-2 does

- **A `media` CI job** on `ubuntu-24.04` installs the distribution's FFmpeg
  (6.1.1), prints its version and runs `pnpm test:media`. It needs no
  database, secret or network media.
- **The suites** live in `tests/media/` and run only through
  `vitest.media.config.ts`; `pnpm test` excludes them, so a unit run still
  needs no binaries. Without FFmpeg the run fails: the suites cannot make
  their inputs, so Vitest marks each file failed and reports its tests as
  skipped. When a tool fails, the error carries its exit code and its own
  message.
- **The composer and the inspector, on real FFmpeg** (30 tests). For each of
  the six composition profile v1 sizes, the dormant composer encodes two
  clips. The first is 16:9 at 25 fps with a tone, its timestamps starting at
  3 seconds, blue turning green at 1.6 seconds, and given 1.5 of its 2
  seconds. The second is 9:16 at 24 fps, red turning yellow for its last two
  frames, and given 2 seconds for its one. The dormant inspector measures the
  frame size, 3,500 ms, one video stream and no audio; `ffprobe` reports
  H.264, `yuv420p`, 30 fps, square pixels and 105 frames. Decoded frames show:
  - each clip whole, letterboxed or pillarboxed and never cropped;
  - the first clip trimmed from its start: frame 44 is still blue;
  - the second clip holding its last frame to the end of its scene: frame 100
    is yellow, where a held first frame or a loop would be red;
  - the cut exactly at frame 45.
- **The disclosure over a real encode** (54 tests). Each of the six committed
  images is laid over a one-second clip of its size, on nine backgrounds:
  mid grey, a near-white floor, a near-black room, and the colours of a blue
  sky, a green garden, red brick, a yellow wall, beige plaster and dark wood.
  The encode uses profile v1's preset, CRF and pixel format, with FFmpeg's
  `overlay` at 0:0 (ADR-0072 Decision 5). A decoded frame's lightness is
  compared with that of the image's straight-alpha blend over the background
  as it decodes, and the rest of the frame in every channel.
- **No application code changes.** The composer, the inspector and the images
  are as they were; the overlay graph is written in the test until DS-5 moves
  it into the composer. One comment in the inspector, which said no test
  needs an `ffprobe` binary, now says which tests do.

### The disclosure through H.264

What the encode does to each image, measured on this machine's FFmpeg 6.1.1
(the same Ubuntu 24.04 package CI installs), in levels of 255, ranging over
the six sizes:

| Background | Mean lightness error where the image has ink | Largest there | The strongest 1% of the text, from the background | Decoded background, from the colour asked for |
| --- | --- | --- | --- | --- |
| mid grey `808080` | 1.34 to 1.42 | 7.5 to 12.5 | 82 to 89 | 0 |
| white floor `f2f2f2` | 1.31 to 1.45 | 8.3 to 14.3 | 137 to 145 | 0 |
| dark room `202020` | 1.50 to 1.62 | 9.5 to 14.6 | 148 to 158 | 1 |
| blue sky `2060c0` | 1.47 to 1.63 | 7.9 to 10.2 | 110 to 118 | 3 |
| green garden `30a040` | 1.39 to 1.52 | 6.3 to 9.8 | 92 to 99 | 3 |
| red brick `c03030` | 1.51 to 1.69 | 9.5 to 16.6 | 108 to 115 | 3 |
| yellow wall `f0e060` | 1.43 to 1.56 | 6.4 to 15.7 | 122 to 127 | 3 |
| beige plaster `d8c8a8` | 1.39 to 1.56 | 7.2 to 10.3 | 113 to 120 | 2 |
| dark wood `6a4a30` | 1.49 to 1.62 | 7.7 to 11.6 | 115 to 123 | 3 |
| **bound** | **3** | **24** | **at least 72** | **6** |

Beyond 16 pixels of the text, nothing changes in any channel (bound 2).

The lightness is what the text's legibility rests on, and H.264's rounding at
CRF 18 moves it by a level or two on average. `yuv420p` keeps lightness at full
resolution and halves the colour in each direction, so a saturated
background's colour spreads into the text's edges. The first version of this
record said that, the images being grey, this changed nothing; over a
saturated colour it does. Per colour channel, the largest error at the text's edges is 36
to 68 levels on the blue, green, red and yellow backgrounds (7 to 10 on
average), 20 to 26 on beige and dark wood, and 8 to 15 on the neutrals. Any
text over colour in this format does the same; the suite bounds the lightness
and leaves the colour at the edges unbounded (Known limitations).

On the white floor, the shadow is what separates the text from the floor, at
least 137 levels below it after the encode. Mid grey remains the weakest
background, as in DS-1.

### Verification

Measured locally (PostgreSQL 16, configured like CI; FFmpeg 6.1.1) on the code
of the review commit, the last in the list above.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5741 / 5741**, 200 files (unchanged: the media suites are not in it) |
| `pnpm test:media` | **84 / 84**, 2 files, about 50 seconds |
| `pnpm test:db` | **1438 / 1439**, 53 files: the one failure is the known race test below |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference (on `1933ec3`; no schema or migration has changed since) |
| `prisma migrate status` | 29 migrations, up to date (no new migration) |

**The database failure is not DS-2's.** "Gives two PROCESSING runners one
history and at most one transfer" is the race test `docs/decisions/TODO.md`
records under *Found in Phase 6F*: a legal interleaving makes its losing runner
answer `OUTPUT_VERIFICATION_REPLAYED`, which the test does not expect. DS-2
does not touch that code. Run alone, it failed 2 of 4 times on `8fa1507`
without the review's changes, as often as with them; on `1933ec3` the full
suite passed, and so did CI.

New tests (84, media only): the composer and inspector in six sizes (30) and
the six images over nine backgrounds (54), as above.

### Mutation ledger

**26 mutants: 24 killed, and 2 that survive only alone, 0 broken, 0
anchor-missing**, in the third pass, on the review commit's code. Each mutant
breaks one thing the composer's or the inspector's arguments claim, or one
property of the overlay method, at an anchor that occurs exactly once. Each
runs against the real-FFmpeg suite **alone**: the unit suite pins every
argument and would kill each of them without showing that the suite catches it.
Every mutated file was restored and re-hashed, and all 910 files were
byte-identical after each pass.

**The first pass, on `64be4cb`, found one gap.** Removing the composer's
timeline reset before the cut changed nothing, because both test clips started
at zero. A clip need not: `1933ec3` starts the first clip's timestamps at 3
seconds, and without the reset the cut no longer falls at frame 45. The first
pass also counted F11 as broken, because a failed setup step skips its tests
rather than failing them; the harness now counts the file's failure.

**The review found two more.** With solid-colour clips, a short clip that loops
(F12) or a long one that keeps its last 1.5 seconds instead of its first (F13)
looks the same as the right answer. Run against the suite as it stood on
`8fa1507`, before the clips changed, both survived; with clips that change
colour partway, both are killed.

**F11, the square-pixel declaration, is load-bearing.** Scaling a clip into a
1080p frame rounds one dimension (607.5 to 608 pixels), FFmpeg adjusts the clip's
pixel shape to compensate, and concat refuses two clips whose pixel shapes
differ. Without `setsar=1` the three 1080p sizes fail to encode at all.

**E01 and E02 survive alone, and that is by design.** The composer drops audio
twice: it maps only the filtered video, and it passes `-an`. Removing `-an`
(E01) leaves no audio mapped; mapping the first clip's audio (E02) is undone by
`-an`. Each mutant is equivalent alone. Both together (E05) put the tone in the
deliverable, and the suite catches it.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| F01 | fit | the clip cropped to fill the frame | `ffmpeg-composer.ts` | 8 of 30 (composer) |
| F02 | fit | the clip stretched to fill the frame | `ffmpeg-composer.ts` | 8 of 30 (composer) |
| F03 | fit | the clip in the top-left corner | `ffmpeg-composer.ts` | 12 of 30 (composer) |
| F04 | fit | white bands instead of black | `ffmpeg-composer.ts` | 8 of 30 (composer) |
| F05 | time | a short clip ends early instead of holding | `ffmpeg-composer.ts` | 18 of 30 (composer) |
| F06 | time | a long clip is not trimmed | `ffmpeg-composer.ts` | 24 of 30 (composer) |
| F07 | time | a long clip is sped up to fit instead of trimmed | `ffmpeg-composer.ts` | 18 of 30 (composer) |
| F08 | rate | 25 frames a second | `ffmpeg-composer.ts` | 24 of 30 (composer) |
| F09 | order | the clips in reverse order | `ffmpeg-composer.ts` | 18 of 30 (composer) |
| F10 | timeline | no timeline reset before the cut | `ffmpeg-composer.ts` | 18 of 30 (composer) |
| F11 | pixels | no square-pixel declaration | `ffmpeg-composer.ts` | setup failed, 15 of 30 not run (composer) |
| F12 | time | a short clip loops instead of holding its last frame | `ffmpeg-composer.ts` | 6 of 30 (composer) |
| F13 | time | a long clip keeps its last seconds instead of its first | `ffmpeg-composer.ts` | 6 of 30 (composer) |
| E01 | audio | audio not explicitly dropped | `ffmpeg-composer.ts` | survived, equivalent alone (below) |
| E02 | audio | the first clip's audio mapped through | `ffmpeg-composer.ts` | survived, equivalent alone (below) |
| E05 | audio | the first clip's audio mapped through and not dropped | `ffmpeg-composer.ts` | 12 of 30 (composer) |
| E03 | format | full-resolution colour (yuv444p) | `ffmpeg-composer.ts` | 6 of 30 (composer) |
| E04 | container | Matroska instead of MP4 | `ffmpeg-composer.ts` | 12 of 30 (composer) |
| P01 | inspector | video streams counted as audio | `ffprobe.ts` | 6 of 30 (composer) |
| P02 | inspector | width and height swapped | `ffprobe.ts` | 4 of 30 (composer) |
| O01 | overlay | the image's transparency ignored | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |
| O02 | overlay | the image laid one pixel to the right | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |
| O03 | overlay | the image scaled 2% larger | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |
| O04 | overlay | the image read as premultiplied | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |
| O05 | overlay | the image at 80% of its opacity | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |
| O06 | overlay | the video encoded at CRF 35 | `disclosure-overlay.media.test.ts` | 54 of 54 (overlay) |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the composer row and the disclosure row note the media suites |
| Entity-relationship diagram | Not applicable: DS-2 adds no table, column or relation |
| Critical sequence diagram | Not applicable: DS-2 adds no runtime flow, only tests and a CI job |
| OpenAPI / API change summary | Not applicable: no route, page, export or command changes |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-2*: no migration, nothing changes at deploy |
| Completion report | this file |

Also updated: `docs/local-setup.md` and `tests/README.md` (running the media
suites), `docs/Roadmap.md` and `docs/decisions/TODO.md` (the disclosure item,
and a new item: choose the worker image's FFmpeg before composition is
activated).

### Activation status

Nothing paid or scheduled is activated. DS-2 adds tests, a test configuration
and a CI job that installs FFmpeg on the runner only: no application code,
worker, scheduler, credential, environment variable or payment integration.
Paid Provider Activation, production credentials, the production scheduler and
live Stripe charges remain BLOCKED.

### Known limitations

- **Only CI and a developer's machine have FFmpeg.** No deployment image
  carries it; choosing that build, and running the media suites against it, is
  a TODO item for when composition is activated.
- **The sources are short, constant-rate and square-pixelled.** A clip with a
  variable frame rate, non-square pixels or a long duration is not exercised.
- **The colour at the text's edges is not bounded.** `yuv420p` halves the
  colour resolution, so over a saturated background the background's colour
  spreads into the text's edges, by up to 68 levels in one channel at a pixel
  (measured on yellow). The suite bounds lightness, which carries legibility,
  and that stays within 17. Any text in a 4:2:0 video does the same; a
  full-colour delivery format would be a product decision, not a fix here.
- **The overlay graph is in the test, not the composer**, until DS-5.
- **The bounds were measured on FFmpeg 6.1.1.** Another FFmpeg or x264 build
  should land well inside them, but the suite is what says so.

### Remaining work

DS-2 waits for the product owner's yes before merge. DS-3 (the disclosure mode
frozen at admission, migration 29) comes next, after it.

## DS-3 — the disclosure mode, frozen at admission

Base: `cb81844` (PR #95 merge commit on `main`; post-merge CI run 621 green).
ADR: `docs/decisions/0073-disclosure-mode-frozen-at-admission.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `a092d89` | migration 29, the mode on the job port and in both repositories, the v2 fingerprint, the tests, ADR-0073 and the documentation |
| `e87b129` | the independent review's findings (below): what a v1 plan's replay does and does not affect, why existing rows are Mode A, the mode type derived from its list, the rollback note |
| this commit | this record |

The exact head SHA is reported with the pull request.

### What DS-3 does

- **Migration 29** creates the enum `DisclosureMode` with one value,
  `THROUGHOUT` (Mode A), and adds a required `disclosureMode` to
  `generation_jobs` and `generation_deliverable_versions`. Existing rows
  become Mode A; the default is dropped in the same migration.
- **Job admission** (`GenerationJobRepository.create`) stores the mode the
  caller names, which the port requires, and returns it on the job. A mode
  not built is answered `DISCLOSURE_MODE_NOT_SUPPORTED` before the transaction
  opens, so nothing is written.
- **Transaction I** copies the locked job's mode onto the version it plans and
  hashes it as the fourth element of the target in
  `sha256:deliverable-input:v2`. A replay recomputes with the version's own
  mode. A plan stored under v1 is never rewritten: replayed, it fails closed
  with `PARTIAL_PLAN_STATE`.
- **`@app/domain`** gains `DisclosureMode`, `DISCLOSURE_MODES`,
  `DEFAULT_DISCLOSURE_MODE` and `isDisclosureMode`
  (`docs/api-changes-ds-3.md`).
- **No state, transition, event, route, page, command or environment
  variable changes.** No route admits a whole-video generation yet, and the
  composition claim, the composer and publication do not read the mode until
  DS-5 and DS-6.

### Verification

Measured locally (PostgreSQL 16, configured like CI) on `a092d89`, and again
on `e87b129` where marked: that commit changes a type's declaration, comments
and documentation only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean (both commits) |
| `pnpm test` | **5751 / 5751**, 202 files (5741 before; 10 new) (both commits) |
| `pnpm test:db` | **1446 / 1446**, 54 files (1439 before; 7 new); on `e87b129`, the two suites the plan touches, 63 / 63 |
| `pnpm build` | succeeded (both commits) |
| `prisma migrate diff` (migrations → schema) | no difference (both commits) |
| `prisma migrate status` | 30 migrations, up to date |

The race test recorded under *Found in Phase 6F* passed in this run.

New tests:

- `packages/domain/src/disclosure/mode.test.ts` (2): Mode A is the only mode
  and the default; the guard accepts it alone, refusing Mode C's future
  spelling, near misses and non-strings.
- `packages/domain/src/disclosure/mode-shape.test.ts` (6): migration 29 is the
  newest and is exactly its five statements; the domain's modes equal the
  schema's and the migration's; neither model has a default; the mode is
  written only by job admission and Transaction I, never by SQL, and no app
  mentions it; the refusal comes before the transaction; the version takes the
  job's mode and a replay the version's.
- `packages/domain/src/deliverable-composition/plan.test.ts` (2 more): the
  exact v2 payload, and a fingerprint that changes with the mode.
- `tests/integration/disclosure-mode.db.test.ts` (7): admission stores and
  returns the mode; an unbuilt mode writes no job and no event; the enum's
  labels are the domain's; both columns are `NOT NULL` with no default; the
  database refuses an unknown mode; Transaction I copies the job's mode and
  stores the v2 fingerprint computed with it; a plan holding exactly the v1
  value the old code stored fails closed on replay and is left as it was. The
  test's v1 formula was checked against `cb81844`'s own function, which gives
  the same value for the same inputs.

Twenty-one existing pins, in 20 files, on the number of migrations or on which
is newest move by one, as each earlier migration's own did.

### Mutation ledger

**18 mutants: 18 killed, 0 survived, 0 broken, 0 anchor-missing**, in one
pass on `a092d89`; M01 and M02 ran again on `e87b129`, which re-declares the
list they mutate, and both were killed. Each breaks one claim of ADR-0073 at an anchor that occurs
exactly once, and runs against every suite listed for it, so the table shows
which suites catch it: the unit tests (`mode.test.ts`, `plan.test.ts`), the
shape test (`mode-shape.test.ts`) and the database suites
(`disclosure-mode.db.test.ts`, `deliverable-composition-plan.db.test.ts`,
`generation-orchestration.db.test.ts`). Every mutated file was restored and
re-hashed, and all 917 files were byte-identical after the pass.

| Mutant | Area | What it breaks | File | Caught by |
| --- | --- | --- | --- | --- |
| M01 | admission | any string accepted as a mode | `mode.ts` | unit, database |
| M02 | admission | Mode C's value listed before it is built | `mode.ts` | unit, database, shape |
| M03 | fingerprint | the mode left out of the hashed target | `plan.ts` | unit |
| M04 | fingerprint | the v1 prefix kept | `plan.ts` | unit, database |
| M05 | fingerprint | the mode hashed before the duration | `plan.ts` | unit |
| R01 | admission | an unbuilt mode not refused before the write | `orchestration-repositories.ts` | database, shape |
| R02 | admission | the job created without its mode | `orchestration-repositories.ts` | database, shape |
| R03 | admission | the job read back without its mode | `orchestration-repositories.ts` | database, shape |
| R04 | planning | the version created without the mode | `deliverable-composition-repository.ts` | database, shape |
| R05 | planning | the plan's fingerprint computed without the mode | `deliverable-composition-repository.ts` | database, shape |
| R06 | planning | the job's mode not read under the lock | `deliverable-composition-repository.ts` | database |
| R07 | replay | a replay recomputed without the mode | `deliverable-composition-repository.ts` | database, shape |
| R08 | replay | a replay recomputed with the job's mode | `deliverable-composition-repository.ts` | shape only (below) |
| R09 | replay | a v1 plan accepted on replay | `deliverable-composition-repository.ts` | database |
| S01 | migration | the job column keeps its default | `migration.sql` | shape |
| S02 | migration | existing versions' fingerprints rewritten | `migration.sql` | shape |
| S03 | schema | a schema default for the job's mode | `schema.prisma` | shape |
| S04 | schema | a second mode in the schema enum | `schema.prisma` | shape |

**M03 and M05 pass the database suites**, because those compute the expected
fingerprint with the same function. The unit test's exact v2 payload is what
pins the hashed structure.

**R08 is equivalent in behaviour** while every version takes its job's only
mode: the job's and the version's are the same value. Only the shape test's
pin on the source catches it; a behaviour test needs a second mode, and
arrives with Mode B or a disclosure change.

**S01 to S04 change the migration or the schema text**, which the live
database (already migrated) and the generated client do not see; the shape
test reads the files. CI's `prisma migrate diff --exit-code` would also catch
S03 and S04.

### Review

The automated code review is still at its usage limit, so an independent
review read the whole diff (`cb81844..a092d89`) through git objects. It found
nothing blocking. Answered in `e87b129`:

1. **Should-fix: what a v1 plan's replay affects.** ADR-0073 said a plan stored
   before migration 29 cannot be replayed and its job can be planned again
   only by a new cycle. Only Transaction I's replay recomputes a fingerprint;
   composition's claim and finalization do not read it, so a pending v1 plan
   is still claimed and composed, and a pending job is not planned again
   (`COMPOSITION_PENDING` moves only to `COMPOSING` or `FAILED_TERMINAL`). The
   ADR and the migration notes now say so.
2. **Why existing rows are Mode A.** The reason given, "the only mode any
   composition could have given them", was wrong: no composition draws the
   disclosure yet. The ADR and the migration's comment now give the approved
   plan as the reason, and say that a version composed before DS-5 holds a
   video without the disclosure.
3. **The type and the list could drift.** `DisclosureMode` is now derived from
   `DISCLOSURE_MODES`.
4. **Housekeeping.** The rollback note now says to roll the code back with the
   columns, and the replay check's docstring names the version's mode.

Not changed, with the reason:

- **A runtime guard on the raw read of the job's mode.** The shape test and the
  database test hold the domain's list and the database enum equal, so a value
  added to one alone fails CI, and no test could reach the guard.
- **A pinned v1 value in a unit test.** The database test's formula matches
  `cb81844`'s code (above). What the test adds to the existing tamper test is
  that the plan is left as it was and no second version appears.
- **The missing completion record**: this section.

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the composition-plan row and the disclosure row |
| Entity-relationship diagram | `docs/er-diagram.md`, *DS-3*: the two columns and the enum |
| Critical sequence diagram | Not applicable: no flow changes order; admission and Transaction I each write one more column in the transaction they already had |
| OpenAPI / API change summary | `docs/api-changes-ds-3.md`: no route or page; the domain exports, the job port and the fingerprint |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-3* |
| Completion report | this file |

Also updated: `docs/DataModel.md` (where the mode is stored),
`docs/Roadmap.md`, and `docs/decisions/TODO.md` (the disclosure item and the
frozen-contract item, in part, and a new item: which mode a later version
carries once disclosure changes exist).

### Activation status

Nothing paid or scheduled is activated. DS-3 adds a migration and changes two
dormant repositories and the domain: no worker, scheduler, credential,
environment variable or payment integration. Paid Provider Activation,
production credentials, the production scheduler and live Stripe charges remain
BLOCKED.

### Known limitations

- **Only Mode A can be stored.** Mode B and Mode C add their values, and their
  admission rules, when they are built.
- **No customer chooses a mode yet.** No route admits a whole-video
  generation; the generation-start screen is proposed separately.
- **A replay recomputing with the job's mode instead of the version's cannot
  be told apart by behaviour** while every version takes its job's only mode.
  The shape test pins the source; a behaviour test needs a second mode.
- **A development database's pending v1 plan fails Transaction I's replay**
  with `PARTIAL_PLAN_STATE`; composition, which does not read the fingerprint,
  is unaffected. Only development data holds one.
- **Which mode a later version carries** after a disclosure change is open
  (TODO).

### Remaining work

DS-3 waits for the product owner's yes before merge. DS-4 (the Clean Master
record and its private storage location, migration 30) comes next, after it.

## DS-4 — the Clean Master record and its internal location

Base: `17d39a3` (PR #96 merge commit on `main`; post-merge CI run 625 green).
ADR: `docs/decisions/0074-clean-master-record-and-internal-location.md`

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `0e88b25` | migration 30, the key and the internal namespace, the signers' refusal, the tests, ADR-0074 and the documentation |
| `1d4e70a` | the answers to the independent review: non-canonical keys refused, the wider static guard, the blank-organization CHECK, the lifecycle TODO |
| this commit | this record |

The exact head SHA is reported with the pull request.

### What DS-4 does

- **Migration 30** creates `generation_deliverable_clean_masters`, one receipt
  per composed deliverable version for its overlay-free master: the key, the
  SHA-256, the size and when the bytes were proven, every column required,
  RESTRICT to the version. A CHECK holds each row's key to its own version's
  place in the internal namespace; another holds the receipt to canonical
  values.
- **The internal namespace**, `org/{organizationId}/internal/`, holds the
  master at `…/internal/clean-masters/{deliverableVersionId}`, built only by
  `managedCleanMasterKey` under its own brand.
- **No signed URL reaches it.** `signStorageToken` throws for an internal key,
  `verifyStorageToken` ignores a token for one, and `LocalObjectStorage`
  rejects both of its signed URLs for one. The download and upload routes
  answer such a token as a forged one (`401`) and serve or write nothing.
- **Outside quota and Units.** No quota is built and the TODO item already
  excludes the master; nothing touches the Unit ledger.
- **Nothing writes a master yet.** DS-5's composition will. No state,
  transition, event, page, command or environment variable changes.

### Verification

Measured locally (PostgreSQL 16, configured like CI) on `1d4e70a`.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5771 / 5771**, 205 files (5751 before; 20 new) |
| `pnpm test:db` | **1452 / 1452**, 55 files (1446 before; 6 new) |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 31 migrations, up to date |

New tests:

- `packages/domain/src/clean-master/key.test.ts` (7): the key's exact shape and
  owner; its refusals of a blank identifier or one containing `/`; its brand,
  distinct from the scene output's and the customer video's (typecheck-level);
  the namespace holds the master and no customer key, and is the exact,
  case-sensitive third segment; no key a store could rewrite onto the master
  (doubled or leading `/`, `.`, `..`, `\`) is signable, and every key the
  application builds is canonical; the guard throws an internal error naming
  no key, and only for a key it may not sign.
- `packages/domain/src/clean-master/clean-master-shape.test.ts` (6): migration
  30 is the newest and is exactly its five statements; the model is the receipt
  and RESTRICT; nothing writes or reads it and no app names the key; the files
  naming the signer, the verifier or a signed-URL method are exactly today's,
  and no source or manifest names a presigner; the download route is the only
  app code that reads object bytes, and reads a verified key.
- `packages/storage/src/signing.test.ts` (3 more): never signed for either
  purpose; never honoured however the token was made, nor through a key a store
  could rewrite onto it, while the same hand-made token for a customer's key
  is; the local adapter rejects both URLs while
  server-side reads still work.
- `tests/api/storage-routes.test.ts` (4): the download route serves a
  customer's object and refuses the master with `401`; the upload route never
  writes over the master and still accepts a customer's upload.
- `tests/integration/clean-master.db.test.ts` (6): every column required, no
  default but `createdAt`; a stored master's key is one the signer refuses; one
  master per version; ten wrong keys refused; six bad receipts refused and the
  largest safe size accepted; a missing version refused, and a version cannot be
  deleted from under its master but can once the master is gone.

Twenty-two existing pins on the migration count and the newest migration move
from 30 to 31 directories, as each earlier migration's own did. The
orchestration fixture's wipe deletes Clean Masters before versions.

### Mutation testing

**39 of 39 killed** on `1d4e70a` (`ds4/mutate.py` in the session scratchpad).
An earlier pass of the first 32 on `0e88b25` also killed every one.
Each source mutant replaced one anchor that occurs exactly once; each database
mutant weakened one live constraint with SQL and restored it afterwards, so the
database suite was run against the constraint it relies on, not just the
migration's text. Every file was restored and re-hashed, and the file manifest
and the live constraints were identical after the pass.

| Area | Mutants | Killed by |
| --- | --- | --- |
| The internal namespace: never true, wrong segment, no `org` prefix, case-insensitive, any segment | K01–K05 | the key test, and for the first two also the signer, route and database tests |
| The key: `/` accepted, blank accepted, version id unchecked, master outside `internal/`, master beside the customer's video | K06–K10 | the key test; the last two also the signer, route and database tests |
| The guard: a no-op, a message naming the key, a 403 instead of an internal error | K11–K13 | the key test, and the signer and database tests where they apply |
| The signer and verifier: no refusal, refusal of downloads only (either side), honouring an internal key | G01–G04 | the signer test, and the route and database tests where they apply |
| The local adapter: a synchronous throw, signing around the guard | L01–L02 | the signer test |
| Canonical keys: every key canonical, empty segments, dot segments, a backslash, a verifier checking only the namespace, signable ignoring the namespace | C01–C06 | the key and signer tests, and the route and database tests for the last |
| The migration and schema text: no key check, CASCADE, a rewritten row, a schema CASCADE, a default verification time | S01–S05 | the shape test |
| The live constraints: any `org/` key, no version binding, an empty or a blank organization, uppercase hex, zero bytes, no upper bound, no uniqueness, CASCADE | D01–D09 | the database test |

Every mutant in the code was killed by a behaviour test; the shape test alone
kills only the migration's and schema's text, which the live-constraint mutants
cover behaviourally.

### Review

The automated review is still at its usage limit, so an independent review read
the whole of `0e88b25` from git objects. It found nothing blocking: no code path
can issue or honour a signed URL for a master, and nothing writes one. Its
findings, and what `1d4e70a` does about each:

- **Should-fix: the static guard matched method syntax only**, so an adapter
  written as an object literal or arrow property, or a presigner with another
  name, would have passed, and ADR-0074 claimed more than that. The guard now
  pins every file naming the signer, the verifier or a signed-URL method in any
  syntax, and refuses any presigner or shared-access signature in source and
  any presigner package in a manifest. ADR-0074 now says exactly that.
- **Should-fix: masters with no stated lifecycle.** The master of a version that
  is never published, and of content replaced by a paid regeneration, are not
  covered by ADR-0052 Decision 17's retention rule; both are now a TODO item.
  The suggestion to own the master by the job instead was not taken: a paid
  regeneration makes new content and so a new master, which a job-owned row
  could not hold. The review's concern that a version could not be deleted
  after its 30 days does not arise: that retention is the old version's video,
  not its row, which its composition and validation rows already keep. ADR-0074
  Decision 5 now says so.
- **Odd key shapes** (`org/o//internal/x`, a leading `/`, `.` or `..` segments)
  passed the positional check, and a store that collapses `//` could map them
  onto the master. Nothing builds such a key, but the signer and verifier now
  refuse any key that is not canonical.
- **The CHECK accepted a blank organization segment** (`org/ /…`), though the
  notes said non-blank. It now trims before comparing, with a test.
- **The brand's comment** claimed it stops a signer; signers take any string,
  and the comment now says the runtime check is what refuses.
- **Brittle source-text pins** on the signer and local adapter repeated what the
  behaviour tests prove; they are dropped.
- **Not changed: the preflight reports a signer refusal as a storage outage.**
  That mapping predates DS-4, and the preflight signs only a source photograph's
  key read from its asset row, so an internal key cannot reach it.
- **The completion record** is this section.

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: a Clean Master row |
| Entity-relationship diagram | `docs/er-diagram.md`, *DS-4*: the table and its relationship |
| Critical sequence diagram | Not applicable: no flow changes; nothing writes or reads the master yet, and the routes' refusal is one more reason a token is invalid |
| OpenAPI / API change summary | `docs/api-changes-ds-4.md`: the two routes' refusal, the domain exports and the signing changes |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-4* |
| Completion report | this file |

Also updated: `docs/DataModel.md` (where the master is recorded),
`docs/SecurityCompliance.md` (internal objects are never signed),
`docs/Roadmap.md`, and `docs/decisions/TODO.md` (the disclosure and Clean
Master items, in part, and a new item: whether scene outputs move under
`internal/`).

### Activation status

Nothing paid or scheduled is activated. DS-4 adds a migration, a domain module
and a refusal in the signer: no worker, scheduler, credential, environment
variable or payment integration. Paid Provider Activation, production
credentials, the production scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **No master exists yet.** DS-5 encodes and records it; DS-6 requires it.
- **The CHECK cannot verify the key's organization** against the version's
  job; the writer derives it.
- **A production adapter that presigns through its own SDK** must call the
  guard itself; the shape test fails when one appears, so its author decides.
- **Scene outputs are outside `internal/`** and are signed by nothing today
  (TODO).
- **Deletion with the content** is unbuilt, as is all physical deletion of
  videos (TODO records the order).
- **Which masters outlive their purpose** (a version never published, content
  replaced by a paid regeneration) is not decided by ADR-0052 (TODO).

### Remaining work

DS-4 waits for the product owner's yes before merge. DS-5 (composition makes
the Clean Master, then the customer's video from it) comes next, after it.

## DS-5a — the Clean Master encode, and the disclosure laid over it

Base: `0c1eff2` (PR #97 merge commit on `main`; post-merge CI run 631 green).
ADR: `docs/decisions/0075-clean-master-encode-and-disclosure-overlay.md`

DS-5 is built in two pull requests. DS-5a gives the composer its two encodes;
DS-5b will make composition run them, store the master and write its record.

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `94ed441` | the two encodes, the image check, the unit tests, the media suites on the composer, ADR-0075 and the documentation |
| `8d070ef` | the independent review's answers: FFmpeg reads a private copy of the checked image through a stated reader; no input's tags or chapters reach a composed file; defects checked before the deployment, with codec, pixel format and preset added to the profile check; transient read failures retried; the master at CRF 16 |
| this commit | this record, and the composer media suite's chapter moved past its clip's start so FFmpeg would carry it over (found by mutation round 2) |

The exact head SHA is reported with the pull request.

### What DS-5a does

- **`composeCleanMaster`** encodes the composition graph `compose` runs at
  `CLEAN_MASTER_CRF`, 16, with nothing laid over it. Its argument vector
  differs from `compose`'s in that one value.
- **`applyDisclosure`** makes the customer's video from a Clean Master file:
  the committed disclosure image for the frame size, looped, laid over it at
  the origin (`overlay=0:0:format=auto:shortest=1,format=yuv420p`), encoded at
  the profile's preset, CRF and pixel format with no audio. Mode A only; any
  other mode is refused.
- **The image is the reviewed one, and FFmpeg reads only those bytes.** Before
  every run the composer reads the image from its configured
  `disclosureLayerDirectory` (an absolute path) and compares its SHA-256 with
  the one `DISCLOSURE_LAYER_ASSETS` pins, then writes the bytes it compared to
  a private directory of its own and hands FFmpeg that copy, through a stated
  reader (`-f png_pipe`). A missing setting, a missing or unreadable file, or
  another image is a deployment fault and nothing runs; a frame size with no
  image, a mode it does not implement, or an output path that is the master's
  is a defect, reported as one whatever the deployment holds.
- **Nothing from an input's container.** `-map_metadata -1` and
  `-map_chapters -1` in all three encodes, `compose` included: a provider
  clip's title, comment or chapter no longer reaches a composed file.
- **The media suites drive both.** In all six sizes, the master and the
  customer's video keep every fact the composer suite measured before, carry
  none of the first clip's tags or chapters, the disclosure is where its image
  puts it, the video is the master everywhere else, and the master carries
  none. The overlay suite's nine backgrounds go through the composer, with its
  bounds and measurements unchanged.
- **Nothing calls them yet.** The runner still composes with profile v1 and
  calls `compose`; nothing in production constructs the composer.

### Why CRF 16

Measured on FFmpeg 6.1.1, 1080p at 30 fps, the master and then the customer's
video at CRF 18 from it, against one encode at CRF 18 from the same input
(ADR-0075 Decision 1, which records how to reproduce it):

| Input | PSNR lost, master at CRF 12 / 14 / 16 | Master against the video |
| --- | --- | --- |
| a textured pan with grain, from an 8 Mbps encode (provider-like) | 0.10 / 0.15 / 0.25 dB | 3.0 / 2.2 / 1.5 times |
| a Mandelbrot zoom, from an 8 Mbps encode | 0.00 / 0.01 / 0.02 dB | 1.5 / 1.3 / 1.1 times |
| `testsrc2`, lossless | 0.00 / 0.00 / 0.01 dB | 1.5 / 1.3 / 1.2 times |

SSIM moves by 0.003 at most. The approved plan estimated that the master
roughly doubles what is kept per video. CRF 16 keeps to that (1.1 to 1.5 times
the video); CRF 14, the first build's choice, would have been 2.2 times on the
provider-like footage for 0.1 dB nobody can see. Every video is made from the
master directly, once, so the loss never compounds. The storage is VTaVision's
and outside customer quota (ADR-0052 Decision 17). The table is three synthetic
clips; `docs/decisions/TODO.md` asks for a re-measurement on the verified
route's own clips before composition is activated.

### Verification

Measured locally (PostgreSQL 16 and FFmpeg 6.1.1, configured like CI) on
`8d070ef`; this record's commit changes only the composer media suite's
fixture and comments, and that suite passed again on it (90 / 90).

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5804 / 5804**, 206 files (5771 before; 33 new) |
| `pnpm test:db` | **1452 / 1452**, 55 files (unchanged) |
| `pnpm test:media` | **144 / 144**, 2 files (84 before; 60 new) |
| `pnpm build` | succeeded |

New and changed tests:

- `packages/storage/src/managed-output/ffmpeg-composer-disclosure.test.ts`
  (33): the master's quality, 16, above the video's; its vector, `compose`'s
  with only the CRF changed and nothing laid over it; the disclosure vector
  pinned element by element, carrying the profile's settings, with no scaling,
  cropping or drawn text; a mode it does not implement refused; all three
  vectors dropping every input's tags and chapters; for each of the six sizes,
  FFmpeg handed a private copy holding the reviewed bytes (mode `0600`, in a
  `0700` directory, never the deployment's file), removed after the run, also
  when the run throws; a relative directory refused when the composer is
  built; no directory, a missing image, a directory in its place, another
  size's image and the reviewed image with one byte appended all refused as
  deployment faults with nothing run; the reviewed bytes accepted from any
  directory, and a success not remembered (the image replaced afterwards is
  refused at the next run); an I/O error and a copy that cannot be written
  retried; the read-error classification; a frame size with no image, an
  unknown mode and an output path that is the master's (also through `..`)
  refused as defects even with no directory configured; all three encodes map
  a run as `compose` does and refuse a profile they do not implement, now
  including another codec, preset or pixel format.
- `packages/storage/src/managed-output/ffmpeg-composer.test.ts`: `compose`'s
  pinned vector carries the two metadata options.
- `tests/media/composer.media.test.ts` (90, was 30): the five existing checks
  now run on the master and on the customer's video in each size, as does a
  sixth: the first clip arrives with a title, a comment, a stream handler name
  and a chapter, and neither file carries any of them or any stream but the
  video. Three frames per size (the first, the cut, the held last frame) prove
  the disclosure, the master underneath, and the master's lack of one.
- `tests/media/disclosure-overlay.media.test.ts` (54): now through the
  composer, over a Clean Master of each background.
- `packages/domain/src/disclosure/disclosure-shape.test.ts`: the composer is
  the one managed-output file that may read the layer table.

Measured at CRF 16 (FFmpeg 6.1.1), the composer suite's disclosure checks: a
mean error of 1.2 to 4.1 where the image has ink (bound 6), a 99th percentile of
4.4 to 20.3 (bound 30), the strongest 1% of the text 120 to 181 from the master
(bound at least 72), the video within 3.5 of the master beyond the text (bound
6, raised from 4: the largest is at the yellow bands' edge in the square
frames), and the master under the text exactly what the rows above show. The
overlay suite measured the same as ADR-0072.

### Mutation testing

Two rounds, each mutant applied to the source, the relevant suites run, and the file restored and checked by SHA-256; the repository's 929-file manifest was identical before and after each pass.

**Round 1, on `94ed441`: 27 / 27 killed.** **Round 2, on `8d070ef`, after the
review: 47 / 47 killed**, none survived, none broken. Round 2 re-anchors round
1's mutants to the changed code and adds 20 for what the review changed. Its
first pass found that T02 (`compose` keeping chapters) was killed only by the
unit suites: the media fixture's chapter ended before its clip's 3-second
start, so FFmpeg dropped it whatever the composer asked. The fixture's chapter
now runs past that start, and T01 and T02 were run again on this record's
commit.

| Mutant | Area | Change | Killed by |
| --- | --- | --- | --- |
| E01 | master quality | the master at the video's CRF | unit-new |
| E02 | master quality | the master below the video's quality | unit-new |
| E07 | master quality | the master at the earlier CRF 14 | unit-new |
| E03 | master quality | the master encoded at the profile's CRF | unit-new |
| E04 | master quality | compose encoded at the master's CRF | unit-new, unit-old |
| E05 | master quality | composeCleanMaster runs compose's vector | unit-new |
| E06 | master content | something drawn into the master (and compose) | unit-old, media-composer |
| V01 | image check | the image never verified | unit-new |
| V02 | image check | the digest not compared | unit-new |
| V03 | image check | another size's image for every frame | unit-new, media-composer |
| V04 | image check | a missing image called an internal defect | unit-new |
| V05 | image check | a different image called an internal defect | unit-new |
| V06 | image check | a frame size without an image called a deployment fault | unit-new |
| V07 | image check | no directory called an internal defect | unit-new |
| V08 | image check | a passing check remembered | unit-new |
| V09 | image check | every read failure a deployment fault | unit-new |
| V10 | image check | every read failure retried | unit-new |
| V11 | image check | an I/O error called a deployment fault | unit-new |
| V12 | image check | a relative directory accepted | unit-new |
| C01 | private copy | FFmpeg handed the deployment's file | unit-new |
| C02 | private copy | the copy readable by others | unit-new |
| C03 | private copy | the copy left behind | unit-new |
| C04 | private copy | a copy that cannot be made thrown, not retried | unit-new |
| O01 | overlay | the image laid one pixel off the origin | unit-new, media-composer, media-overlay |
| O02 | overlay | the master laid over the image | unit-new, media-composer, media-overlay |
| O03 | overlay | blending not in the master's format | unit-new |
| O04 | overlay | the video not ended with the master | unit-new |
| O05 | overlay | the image not looped | unit-new |
| O10 | overlay | the image's reader left to FFmpeg's guess | unit-new |
| O06 | overlay | no closing pixel format | unit-new |
| O07 | overlay | the video encoded at the master's CRF | unit-new |
| O08 | overlay | audio kept in the video | unit-new |
| O09 | overlay | an unknown mode encoded as Mode A | unit-new |
| T01 | tags | compose keeps the inputs' tags | unit-old, unit-new, media-composer |
| T02 | tags | compose keeps the inputs' chapters | unit-old, unit-new, media-composer |
| T03 | tags | the video keeps the master's tags and chapters | unit-new |
| D01 | defects first | the output over the master not refused | unit-new |
| D02 | defects first | the same path compared unresolved | unit-new |
| D03 | defects first | the deployment checked before the defects | unit-new |
| P01 | guard | applyDisclosure skips the profile guard | unit-new |
| P02 | guard | composeCleanMaster skips the profile guard | unit-new |
| P03 | guard | the pixel format unchecked | unit-new |
| P04 | guard | the preset unchecked | unit-new |
| P05 | guard | the codec unchecked | unit-new |
| R01 | outcomes | a failed exit read as success | unit-new, unit-old |
| R02 | outcomes | a missing binary retried | unit-new, unit-old |
| S01 | shape | the layer table read outside the composer | shape |

Suites: `unit-new` = `ffmpeg-composer-disclosure.test.ts`; `unit-old` =
`ffmpeg-composer.test.ts`; `shape` = `disclosure-shape.test.ts`;
`media-composer` and `media-overlay` = the two media suites on real FFmpeg.

### Review

Codex is at its usage limit, so, as for DS-3 and DS-4, an independent review
agent reviewed `94ed441` against `0c1eff2`, reading only git objects. Verdict:
nothing blocking; five should-fix findings and nine nits, all answered in
`8d070ef`:

| Finding | Answer |
| --- | --- |
| The hash check does not cover the bytes FFmpeg reads: with `-loop 1` FFmpeg rereads the image for the whole encode, a `%` in the directory expands as a pattern, a relative directory resolves elsewhere | Fixed. Measured first: for these paths FFmpeg picks its PNG pipe reader, but for a path holding a `%` pattern its image-sequence reader, with which an image replaced in place during an encode changed every later frame. FFmpeg now reads a private copy of the checked bytes (`0700` directory, `0600` file created exclusively, removed after the run) through a stated reader, `-f png_pipe`; the directory must be absolute. ADR-0075 Decision 3 and the docstrings no longer claim the risk ends when FFmpeg opens the file |
| `applyDisclosure` assumes the master is the profile's size: a smaller master would come out with no disclosure, and validation would accept it | Recorded for DS-5b, which hands it the master (ADR-0075 Decision 6): composition probes the read-back master and requires its width, height and 30/1 rate to equal the profile's before laying anything over it, with a media test of a mismatched master. Nothing calls `applyDisclosure` until then |
| No test proves the image is checked at every run; two tests share a scratch directory | Fixed: after a success the image is replaced and the next run refused; a fresh directory per test |
| CRF 14 exceeds the approved "roughly double" estimate, with the summary leading on the smaller ratios, and the measurements cannot be reproduced | Fixed by choosing CRF 16, which keeps to the approved estimate (1.1 to 1.5 times) at 0.25 dB; ADR-0075 states the comparison plainly and records the procedure; TODO asks for a re-measurement on the provider's real clips |
| Provider metadata reaches the customer's file (pre-existing in `compose`) | Confirmed by measurement (a clip's title, comment and chapter survived, the chapter as a track of its own, and with `-map_metadata -1` alone the chapter still survived, untitled) and fixed in all three encodes, pixels unchanged; the media suite tags its first clip and proves neither output carries it |
| Nit: the pixel format reaches the filter graph unchecked | Fixed: the profile check now pins codec, pixel format and preset for all three encodes |
| Nit: defects reported as configuration faults when no directory is set | Fixed: profile, mode, frame size and the output path are checked before the deployment |
| Nit: every read error a permanent configuration fault | Fixed: only missing or unreadable files are; others, and a copy that cannot be written, retry |
| Nit: the video written over the master | Fixed: refused as a defect |
| Nit: "a change is a new profile" is not enforced | Recorded: DS-5b's profile v2 binds the master's CRF; nothing runs the master encode until then |
| Nit: the disclosure's argument builder is exported with any image path | Fixed: no longer exported from `@app/storage` |
| Nit: stale comments | Fixed in `ai-disclosure.ts` and the composer's header |
| Nit: `compose` no longer runs on real FFmpeg | Stated in ADR-0075 Decision 4: its vector is proved equal to the master's but for the CRF, and the master runs in every size |
| Nit: the PR is about 1,160 changed lines against the ~500 guideline | Kept as one milestone: DS-5 was already split in two, and splitting the two encodes from their media suites would leave each without its proof. With the answers it is about 400 lines of code, 810 of tests and 330 of documentation |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the composer and disclosure rows |
| Entity-relationship diagram | Not applicable: no schema change |
| Critical sequence diagram | Not applicable: no flow runs the encodes yet; DS-5b adds composition's sequence |
| OpenAPI / API change summary | `docs/api-changes-ds-5a.md`: no HTTP change; the composer's methods, its setting and the domain exports |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-5a*: no migration |
| Completion report | this file |

Also updated: `docs/Roadmap.md` and `docs/decisions/TODO.md` (the disclosure
item; the worker image must carry the six images and name their directory by
an absolute path; a new item: re-measure the master's quality on the provider's
real output).

### Activation status

Nothing paid or scheduled is activated. DS-5a changes the composer and its
port: no worker, scheduler, credential, environment variable or payment
integration. Paid Provider Activation, production credentials, the production
scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **Composition does not run the encodes yet**, so a composed deliverable still
  has no disclosure; DS-5b switches the runner, and DS-6 refuses to publish one
  without its master.
- **`applyDisclosure` trusts the master's size and rate**; DS-5b checks them
  before calling it.
- **No worker image carries the images** or names their directory (TODO).
- **The master's quality is not a column** and was measured on synthetic clips;
  DS-5b's profile v2 binds it, and TODO asks for a re-measurement on real
  provider output.

### Remaining work

DS-5a waits for the product owner's yes before merge. DS-5b (composition runs
the two encodes, stores the master first-wins, writes its record) comes next,
after it.

## DS-5b-1 — storing the Clean Master, and checking it before the disclosure

Base: `e759a96` (PR #98 merge commit on `main`; post-merge CI run 637 green).
ADR: `docs/decisions/0076-clean-master-store-and-inspection.md`

DS-5b is built in two pull requests. DS-5b-1 adds the pieces composition still
lacked to run DS-5a's two encodes, and nothing calls them; DS-5b-2 switches the
runner to them, with migration 31 for two new block codes (ADR-0076
Decision 5, not built).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `50dacbf` | the master's ceiling, the store, the inspector, the comparison with the profile, the tests, the media suites, ADR-0076 and the documentation |
| `cf81e2a` | the independent review's answers: a master that asks to be shown turned is refused; the copy's path named `cleanMasterPath`; an oversized encode answered with the master already stored; one primary-stream selection for both inspectors; every opened file closed and every body cancelled, asserted; the ceiling and the rate check worded as what they are |
| `4a3dbac` | a display matrix that names no rotation refused too (written for mutant F12) |
| this commit | this record; from the mutation pass, a failed write proved to answer without reading the key, the two-stream case given two sizes, counted-only chunks refused by the fake's files; the Roadmap and architecture rows worded as ADR-0076 now is |

The exact head SHA is reported with the pull request.

### What DS-5b-1 does

- **`MAX_CLEAN_MASTER_BYTES`**, 1 GiB, twice the customer's video's ceiling.
  The master was measured at 1.1 to 1.5 times its video on three synthetic
  inputs, so this is an expectation, not a bound; the re-measurement on the
  verified route's real clips, already required before activation, now checks
  it too.
- **`createCleanMasterStore`** (`@app/storage`): `probe` reads a master's key
  and reports its receipt, writing nothing; `fetch` streams the stored master
  into a private file, hashing as it writes; `publish` stores an encoded
  master first-wins under the internal namespace and copies back what is at
  the key, which may be another attempt's master. One read per method, the
  ceiling enforced on the bytes read, `ABSENT` only when the store says so,
  one private directory per copy holding the copy and the customer's video,
  removed on every failure and by one `release`. A key outside
  `org/{organizationId}/internal/`, or not canonical, is refused as a defect.
- **`FfprobeCleanMasterInspector`** (`@app/storage`) reads a local master's
  frame size and frame rate through the media validator's own `ffprobe` run,
  now shared by both: the media policy first, then no display matrix or
  rotation, then base and average rates that are one exact fraction.
- **`cleanMasterMatchesProfile`** (`@app/domain`): the raster equals the
  profile's width, height and rate (as a fraction), exactly.
- **Nothing calls them.** The runner still claims under profile v1 and calls
  `compose`; the dormancy tripwires now name the store and the inspector. No
  migration.

### Verification

Measured locally (PostgreSQL 16 and FFmpeg 6.1.1, configured like CI) on this
record's commit, except the database suite, run on `cf81e2a`: nothing it runs
changed after.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5877 / 5877**, 208 files (5804 before; 73 new) |
| `pnpm test:db` | **1452 / 1452**, 55 files (unchanged) |
| `pnpm test:media` | **164 / 164**, 3 files (144 before; 20 new) |
| `pnpm build` | succeeded |

New and changed tests:

- `packages/storage/src/managed-output/clean-master-store.test.ts`
  (18), against a fake object store and real files under a
  per-test `TMPDIR`: probe reports the digest and count of every stored chunk
  from one read and writes nothing; absent only on the store's "no such key";
  a failing get, a failing stream, a chunk that is not bytes and an empty
  object retryable; exactly the ceiling accepted and one byte more refused
  without reading further; fetch writes exactly the stored bytes, owner-only,
  through short writes, with the receipt of what it wrote and the video's path
  beside it; every failure (a short write, a failing close, a failing stream,
  the ceiling) removes its directory, closes every file it opened and cancels
  every body; publish stores and copies back the stored object, copies back
  another attempt's master without overwriting it, refuses a key outside the
  internal namespace or not canonical before touching anything, sends nothing
  over the ceiling and answers with what is stored, sends nothing for a
  missing or empty encode, and is retryable when the write fails (without
  reading the key, even with a master there) or nothing is at the key after
  it. The fake's files refuse a counted-only chunk, so a change that writes
  one fails an assertion instead of aborting the worker.
- `packages/storage/src/managed-output/ffprobe-clean-master.test.ts` (41): the
  exact frame-rate reading and its twelve refusals; the raster of a composed
  master, reduced; a wrong size or rate reported as read; base and average
  rates that differ, including in the denominator only, or are unknown or
  missing; every media-policy refusal; four kinds of orientation refused, and
  side data that turns nothing accepted; the real video stream, never artwork
  listed before it, and the first of two real streams for both size and rate;
  the validator's argument vector, defaults, bounds and
  configuration checks; each run outcome mapped; the three defects thrown
  without the output's text.
- `packages/domain/src/deliverable-composition-execution/profile.test.ts`:
  each of the six profiles matches its own raster and no other; 60/2 is 30/1;
  one pixel off either way, swapped, 25, 29.97, 60, 30/2, unknown, zero and
  zero-denominator rates refused.
- `tests/media/clean-master-inspector.media.test.ts` (8), on real FFmpeg:
  masters encoded at 720p, portrait, 1918 wide, 25 fps and 29.97 fps read as
  they are and refused for the 1080p landscape profile; a 1920x1080 30 fps
  master matched; the same master given a quarter turn with `-c copy`
  unusable; a PNG, a Matroska file and a text file unusable.
- `tests/media/composer.media.test.ts`: in all six sizes, the inspector reads
  the master and the customer's video as the profile's raster, and both match.
- The dormancy and shape tests: production constructs neither the store nor
  the inspector; only the port and the store name the master key's type, and
  only the key module builds one.

### Mutation testing

Two rounds, each mutant applied to the source, the relevant suites run, and
the file restored and checked by SHA-256; the repository's 935-file manifest
was identical before and after each pass.

**Round 1, on `4a3dbac`: 75 mutants, 71 killed by an assertion.** Two survived
and two were caught only because the test worker crashed:

- **S13** (a failed write ignored, then the key read back) survived: every
  failed-write case also had an empty key, so reading it gave the same answer.
  A new test fails the write with a master already stored and requires
  `RETRYABLE_FAILURE` with no read.
- **F20** (the width taken from the last video stream) survived: the
  two-stream case used the same size twice. It now uses two sizes and checks
  the whole raster.
- **S24** (the ceiling not enforced on the read) and **S33** (probe writing a
  file) made the store write a counted-only chunk, whose reported length Node
  aborts on. The fake's files now refuse such a chunk with an error, so a
  change that writes one fails an assertion.

**Round 2, on this record's code and tests: the 36 store mutants, D01 and F20 run
again, 38 / 38 killed by an assertion.** In total, **75 / 75 killed**, none
survived, none broken.

| Mutant | Area | Change | Killed by |
| --- | --- | --- | --- |
| S01 | namespace | a canonical key outside internal/ stored | store |
| S02 | namespace | a non-canonical internal key stored | store |
| S03 | preflight | an unreadable encode called too large | store |
| S04 | preflight | an encode over the ceiling sent | store |
| S05 | preflight | an encode of exactly the ceiling refused | store |
| S06 | preflight | an oversized encode answers TOO_LARGE without reading the key | store |
| S07 | preflight | an oversized encode over an empty key retried | store |
| S08 | preflight | an empty encode sent | store |
| S09 | write | the master never stored | store |
| S10 | write | stored in another bucket | store |
| S11 | write | stored without the expected bucket owner | store |
| S12 | write | stored with another content type | store |
| S13 | write | a failed write ignored | store |
| S14 | write | absent after the write answered as absent | store |
| S15 | directory | no directory called absent | store |
| S16 | directory | a failed copy leaves its directory | store |
| S17 | directory | release removes only the copy | store |
| S18 | directory | the video's path outside the directory | store |
| S19 | directory | the copy under another name | store |
| S20 | directory | the directory under another prefix | store |
| S21 | read | no body called retryable | store |
| S22 | read | a chunk that is not bytes skipped | store |
| S23 | read | a master of exactly the ceiling refused | store |
| S24 | read | the ceiling never enforced on the read | store |
| S25 | read | a failed write to the copy ignored | store |
| S26 | read | an empty object called absent | store |
| S27 | read | a failing close ignored | store |
| S28 | read | a file left open on failure | store |
| S29 | read | a body left uncancelled | store |
| S30 | read | a throwing read called absent | store |
| S31 | read | another key read | store |
| S32 | read | read without the expected bucket owner | store |
| S33 | read | probe writes a file | store |
| S34 | read | probe reports another digest | store |
| S35 | read | the copy's receipt counts one byte less | store |
| S36 | read | the hash taken of a chunk's first byte only | store |
| D01 | ceiling | the ceiling one byte higher | store |
| F01 | rate | a leading zero read | inspector-unit |
| F02 | rate | a zero denominator read | inspector-unit |
| F03 | rate | the rate's pattern unanchored | inspector-unit |
| F04 | rate | an unsafe integer read | inspector-unit |
| F05 | rate | the rate not reduced | inspector-unit |
| F06 | rate | the divisor wrong | inspector-unit, media-inspector |
| F07 | rate | the average's numerator not compared | inspector-unit |
| F08 | rate | the average's denominator not compared | inspector-unit |
| F09 | rate | no average required | inspector-unit |
| F10 | rate | no base rate required | inspector-unit |
| F11 | orientation | orientation never checked | inspector-unit, media-inspector |
| F12 | orientation | a display matrix only by its rotation | inspector-unit |
| F13 | orientation | a rotation in other side data ignored | inspector-unit |
| F14 | orientation | a rotate tag ignored | inspector-unit |
| F15 | orientation | a turn of 0 not refused | inspector-unit |
| F16 | stream | the first listed stream, artwork included | inspector-unit |
| F17 | stream | the last usable video stream | inspector-unit |
| F18 | stream | the shared selection takes artwork | inspector-unit, validator-unit |
| F19 | policy | the media policy skipped | inspector-unit, media-inspector |
| F20 | policy | the size from the last stream | inspector-unit |
| F21 | outcome | a refused file called retryable | inspector-unit, media-inspector |
| F22 | outcome | a failed run called unusable | inspector-unit |
| F23 | outcome | an unreadable raster called retryable | inspector-unit, media-inspector |
| F24 | runner | a timeout called a refusal | inspector-unit, validator-unit |
| F25 | runner | a missing binary called retryable | inspector-unit, validator-unit |
| F26 | runner | malformed output called a refusal | inspector-unit, validator-unit |
| F27 | runner | another argument vector | inspector-unit, validator-unit |
| F28 | runner | the configured timeout ignored | inspector-unit, validator-unit |
| P01 | profile | a zero denominator matched | profile |
| P02 | profile | the width not compared | profile, media-inspector |
| P03 | profile | the height not compared | profile |
| P04 | profile | the rate compared by numerator | profile |
| P05 | profile | two pixels of tolerance | profile, media-inspector |
| P06 | profile | the area compared, so a turned master matches | profile, media-inspector |
| Z01 | dormancy | the worker constructs the store | domain-dormancy |
| Z02 | dormancy | the worker constructs the inspector | domain-dormancy |
| Z03 | dormancy | the store constructs the inspector | storage-dormancy |
| Z04 | shape | the store builds a master key | shape |

Suites: `store` = `clean-master-store.test.ts`; `inspector-unit` =
`ffprobe-clean-master.test.ts`; `validator-unit` = `ffprobe.test.ts` and
`media-validation.test.ts`; `profile` = `profile.test.ts`; `domain-dormancy`
and `storage-dormancy` = the two dormancy tests; `shape` =
`clean-master-shape.test.ts`; `media-inspector` = the inspector media suite on
real FFmpeg. Z01 and Z02 add a construction to the worker's bootstrap; Z03
and Z04 add one to the store's module.

### Review

Codex is at its usage limit, so, as for DS-3 to DS-5a, an independent review
agent reviewed `50dacbf` against `e759a96`, reading only git objects. It traced
every return path in the store by hand and found no wrong outcome, and found
the validator's behaviour unchanged by the shared `ffprobe` run. Verdict:
nothing blocking; five should-fix findings and seven nits, all answered in
`cf81e2a`:

| Finding | Answer |
| --- | --- |
| The copy's path is named `localPath`, the customer video publisher's field, so DS-5b-2 could hand the master to that publisher | Fixed: `cleanMasterPath`, as `applyDisclosure`'s input names it, with a doc saying why |
| The fetch failure tests do not prove files are closed or bodies cancelled (`rm -rf` succeeds with a file still open) | Fixed: every failure case asserts each opened file closed and each body cancelled, in probe's loop too |
| No rate case differs in the denominator only | Fixed: 30/1 against 30/7 |
| The inspector does not check rotation: FFmpeg turns a master with a display matrix before the overlay, so 1920x1080 coded frames would be overlaid as 1080x1920 | Confirmed by measurement on FFmpeg 6.1.1 (`-display_rotation 90 -c copy`: `ffprobe` reports 1920x1080, the filter graph sees 1080x1920) and fixed: a display matrix, any rotation in side data, or a `rotate` tag is `UNUSABLE`, unit-tested in four forms and on real FFmpeg |
| The 1 GiB ceiling is stated as a guarantee, but rests on three measurements | Fixed: worded as a measured expectation with its consequence named (a master over twice its video would be stopped with a video that fitted), and added to the re-measurement TODO |
| Nit: an oversized or empty encode answers without reading the key, though another attempt may have stored a master | Fixed for the oversized encode, which would end the work: it sends nothing and answers with the stored master, `TOO_LARGE` only over an empty key. An empty encode stays retryable, which already reads the key on the next attempt |
| Nit: an unneeded dormancy exemption for `ffprobe.ts` | Removed |
| Nit: the inspector's port doc names only a launch failure | Fixed: names oversized and malformed output too, and says none is a fact about the file |
| Nit: "constant rate" claims too much | Fixed in the port, the adapter and ADR-0076: agreeing rates refuse what visibly is not constant; the composer, the key's only writer, is what makes it constant |
| Nit: the primary stream is selected twice | Fixed: one `usableVideoStreams` helper for the validator and the inspector |
| Nit: a test comment says a counted-only chunk is never hashed | Fixed |
| Nit: export order | Fixed |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: the composition-execution and Clean Master rows |
| Entity-relationship diagram | Not applicable: no schema change |
| Critical sequence diagram | Not applicable: nothing runs the store or the inspector; DS-5b-2 adds composition's sequence (ADR-0076 Decision 5 states it) |
| OpenAPI / API change summary | `docs/api-changes-ds-5b-1.md`: no HTTP change; the domain and storage exports |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *DS-5b-1*: no migration; DS-5b-2 plans migration 31 |
| Completion report | this file |

Also updated: `docs/Roadmap.md` and `docs/decisions/TODO.md` (the disclosure
item; the master's ceiling joins the re-measurement on the provider's real
output).

### Activation status

Nothing paid or scheduled is activated. DS-5b-1 adds a store and an inspector
that nothing constructs: no worker, scheduler, credential, environment
variable or payment integration. Paid Provider Activation, production
credentials, the production scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **Composition does not run any of it yet**, so a composed deliverable still
  has no disclosure and no master; DS-5b-2 switches the runner.
- **The ceiling is a measured expectation**, on synthetic clips; TODO asks for
  the real route's.
- **Agreeing rates are not proof of a constant rate.** The inspector refuses
  what visibly is not one; the composer's `fps` filter is what makes a master
  constant, and nothing else writes the key.

### Remaining work

DS-5b-1 waits for the product owner's yes before merge. DS-5b-2 (profile v2,
the claim carrying the mode and the master's key, the master before the video,
one record, migration 31's two block codes, and `compose` removed) comes next,
after it.
