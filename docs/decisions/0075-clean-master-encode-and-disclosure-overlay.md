# ADR-0075 — The Clean Master encode, and the disclosure laid over it

Status: Accepted (DS-5a, 2026-10-21). Part of the AI-generated disclosure plan
the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`), whose DS-5 row is built in
two pull requests: DS-5a, the composer's two encodes (Decisions 1 to 5), and
DS-5b, composition running them (Decision 6, not built yet).
Implements: ADR-0071 Decision 6 (the image laid over the video with `overlay`
at 0:0) and the encoding half of Decision 7 (the master encoded at a higher
quality than the deliverable). Amends: ADR-0071 Decision 5 (the composer now
reads the layer table) and ADR-0072 Decision 5, whose overlay graph moves from
the suite into the composer.

## Context

ADR-0071 Decision 7 has composition encode the overlay-free Clean Master
(ADR-0052 Decision 17), store it, and lay the disclosure over the stored
master's bytes to make the customer's video. ADR-0072 measured the overlay with
a graph written in the test. The composer encoded one thing: the scenes, at
composition profile v1's settings, with nothing laid over them. Nothing in the
product read a disclosure image.

## Decision 1 — The master is the composed video at CRF 14

`composeCleanMaster` runs the composition graph `compose` runs (constant 30
fps, contain and pad, hold or trim each scene to its length, hard cuts, no
audio) and encodes it with H.264 in `yuv420p` at preset `medium`, as the
customer's video is, but at **CRF 14** (`CLEAN_MASTER_CRF`) instead of 18. Its
argument vector differs from `compose`'s in that one value. Nothing is laid
over it.

The customer's video is then a second encode, from the master. Measured on
FFmpeg 6.1.1, 1080p at 30 fps, against one encode at CRF 18 from the same
input:

| Input | PSNR lost by the two encodes, master at CRF 12 / 14 / 16 | Master's size against the customer's video |
| --- | --- | --- |
| a textured pan with grain, from an 8 Mbps encode (provider-like) | 0.10 / 0.15 / 0.25 dB | 3.0 / 2.2 / 1.5 times |
| a Mandelbrot zoom, from an 8 Mbps encode | 0.00 / 0.01 / 0.02 dB | 1.5 / 1.3 / 1.1 times |
| `testsrc2`, lossless | 0.00 / 0.00 / 0.01 dB | 1.5 / 1.3 / 1.2 times |

SSIM moves by 0.003 at most anywhere in the table. Every column loses nothing a
viewer can see. CRF 14 keeps four quality steps between the master and the
video, and the loss under 0.2 dB on the hardest input, for a master 1.3 to 2.2
times the size of the video made from it. The approved plan estimated that the
master would roughly double what is kept per video; on grainy footage it is
somewhat more than that. CRF 16 would match the estimate (1.1 to 1.5 times) at
0.25 dB on the hardest input, with two steps of headroom; the extra storage is
VTaVision's (ADR-0052 Decision 17) and small beside the video itself.

- **Not a column.** The composition row freezes the customer's video's settings
  (ADR-0050); the master's quality is the constant this composer reads. DS-5b's
  composition profile v2 binds it, and changing it is a new profile, never an
  edit in place.
- **Same raster and frame rate as the video.** A later disclosure or logo change
  lays its image over the master directly, with no scaling.

## Decision 2 — The customer's video is the master with the image laid over it

`applyDisclosure` encodes the customer's video from a Clean Master file:

```text
-i <master> -loop 1 -i <image>
[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p
-an, libx264 at the profile's preset, CRF and pixel format, +faststart, mp4
```

- **The method ADR-0072 measured**, now in the composer: the image is the
  frame's size, so it goes at the origin, unscaled; looped, it covers every
  frame of the master; `shortest=1` ends the video with the master.
- **The mode chooses the graph.** Mode A (`THROUGHOUT`) lays it over the whole
  video. A mode the composer does not implement is refused with an internal
  error, never encoded as Mode A or without the disclosure. Mode B will limit
  the overlay with `enable`.
- **Its input is a file the caller names**, documented as the local copy of the
  bytes stored at the master's key. Making that true is DS-5b's (Decision 6).

## Decision 3 — The image is the reviewed one, checked before every run

The composer takes the deployment's copy of `assets/disclosure/` as
`disclosureLayerDirectory`. Before each `applyDisclosure` it:

1. finds the image for the profile's frame size in `DISCLOSURE_LAYER_ASSETS`;
   a size with none is a defect in the profile (`INTERNAL_ERROR`), since every
   size a profile resolves to has one (ADR-0071 Decision 1);
2. reads that file and compares its SHA-256 with the pinned one;
3. passes its path to FFmpeg.

A missing directory setting, a missing file, or a file that is not the
reviewed image is a deployment fault (`CONFIGURATION_ERROR`) and nothing runs:
retrying cannot give a video its disclosure there. There is no fallback, no
scaling of another size's image and no drawn text. Checking at every run, not
once at start-up, catches a file replaced while the worker runs at its next
use; between the check and FFmpeg opening the file, the image is as safe as the
deployment's own filesystem, the trust the `ffmpeg` binary itself needs.

## Decision 4 — What the media suites prove

The composer suite (`tests/media/composer.media.test.ts`) now composes each of
the six sizes' Clean Master from its two synthetic clips, then lays the
disclosure over it. For the master **and** the customer's video, everything
ADR-0072 Decision 4 lists still holds: the inspector's facts, H.264 in
`yuv420p` at 30 fps with square pixels and 105 frames, letterboxing, the held
last frame and the exact cut. Then, at the first frame, the cut and the held
last frame:

| Measure, in BT.601 lightness | Bound | Measured (FFmpeg 6.1.1) |
| --- | --- | --- |
| mean error where the image has ink, against its blend over the master | 6 | 1.1 to 4.1 |
| 99th percentile of that error | 30 | 4.2 to 20.3 |
| the strongest 1% of the text, against the master | at least 72 apart | 120 to 181 |
| the customer's video against the master, beyond 16 pixels of the ink | 4 | at most 2.0 |
| the master under the text, against the rows just above it | 4 | 0 |

These frames hold a cut and letterbox bands, unlike ADR-0072's flat
backgrounds. Over a band's pure black, one edge pixel of the first frame is up
to 46 levels out, so the bound is on the 99th percentile rather than the
largest error. Beyond the text the comparison is of lightness, because between
two encodes a band's edge moves by up to 20 in one colour channel (`yuv420p`
halves the colour planes). The last row is what shows the master carries no
disclosure: without one, each of its columns under the text is the colour of
the rows above.

The overlay suite (`tests/media/disclosure-overlay.media.test.ts`) now has the
composer lay each image over a Clean Master of each of its nine backgrounds,
encoded at the master's settings. Its bounds are unchanged, and the
measurements came out the same as ADR-0072's: a mean of 1.31 to 1.69, a
largest error of 6.3 to 16.6, the background exact, and the strongest 1% of
the text 82 to 158 levels from it.

## Decision 5 — Nothing calls them yet

DS-5a changes the composer and its port, and nothing else. The composition
runner still claims under profile v1 and calls `compose`, so a composed
deliverable still has no disclosure; nothing constructs the composer, the
runner or any composition adapter in production (the existing dormancy test);
and no worker image carries the disclosure images or sets
`disclosureLayerDirectory`. The DS-1 shape test now allows exactly one
managed-output file, the composer, to read the layer table; composition
execution, validation, the database and both applications still read none of
it.

---

## Decision 6 — How composition will run them (DS-5b, not built)

- **Composition profile v2** binds Decision 1's master quality, Decision 2's
  overlay and layer v1. A build carrying it refuses a row frozen under v1, as
  `assertRunnableProfile` already does, so no video without its disclosure is
  composed again; candidate discovery stops offering such rows.
- **The master before the video.** After its claim and its probe of the
  customer's video's key, composition reads the master's key. If no master is
  stored, it materializes the scenes, composes the master and publishes it
  first-wins; either way it lays the disclosure over a local copy of the bytes
  read back from the master's key, so the video is made from the stored master
  even when another attempt stored it first.
- **One record.** The transaction that records the composed video's receipt
  writes the Clean Master record in the same commit, and its replay compares
  both receipts.
- **A ceiling for the master.** A master over its own ceiling blocks the work,
  as an oversized video does.

---

## Consequences

- The composer can make the master and the customer's video from it; their
  arguments are pinned, and both encodes are measured on real FFmpeg in CI.
- A deployment that composes must ship `assets/disclosure/`'s six images and
  name the directory; without them the composer refuses to make a video
  (`docs/decisions/TODO.md`).
- The master costs storage of 1.3 to 2.2 times each video, VTaVision's cost
  (ADR-0052 Decision 17), and a second encode per composition.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
