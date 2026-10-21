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

## Decision 1 — The master is the composed video at CRF 16

`composeCleanMaster` runs the composition graph `compose` runs (constant 30
fps, contain and pad, hold or trim each scene to its length, hard cuts, no
audio) and encodes it with H.264 in `yuv420p` at preset `medium`, as the
customer's video is, but at **CRF 16** (`CLEAN_MASTER_CRF`) instead of 18. Its
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

SSIM moves by 0.003 at most anywhere in the table. The approved plan estimated
that the master roughly doubles what is kept per video, a master about the size
of the video. CRF 16 is the setting that keeps to it: 1.1 to 1.5 times the
video, 1.5 times on the provider-like footage. CRF 14 would lose 0.1 dB less
on that footage for a master 2.2 times the video, more storage than the plan
was approved with, and no viewer can see either loss. Two quality steps of
headroom are enough because every video is made from the master directly, once:
a later disclosure or logo change encodes from the master again, never from an
earlier video, so the loss never compounds.

These are three synthetic clips, not the provider's footage; the provider-like
row is the one to re-measure when real output exists. How they were made, so the
table can be reproduced:

```sh
# Lossless references, 6 s at 1920x1080, 30 fps.
ffmpeg -f lavfi -i "mandelbrot=s=1920x1080:rate=30:end_scale=0.3" -t 6 -c:v libx264 -qp 0 -preset ultrafast -pix_fmt yuv420p ref-mandel.mkv
ffmpeg -f lavfi -i "testsrc2=s=1920x1080:r=30" -t 6 -c:v libx264 -qp 0 -preset ultrafast -pix_fmt yuv420p ref-testsrc.mkv
ffmpeg -f lavfi -i "color=c=0x8a7a66:s=2400x1400:r=30,noise=alls=30:allf=u,gblur=sigma=1.2,format=yuv420p" -frames:v 1 tex.png
ffmpeg -loop 1 -framerate 30 -i tex.png -vf "crop=1920:1080:x='t*60':y='t*30',noise=alls=4:allf=t,format=yuv420p" -t 6 -c:v libx264 -qp 0 -preset ultrafast ref-pan.mkv
# Provider-like inputs: the pan and the zoom through an 8 Mbps encode, then kept losslessly as the reference.
ffmpeg -i ref-pan.mkv -an -c:v libx264 -preset medium -b:v 8M -maxrate 10M -bufsize 16M -pix_fmt yuv420p prov-pan.mp4
ffmpeg -i prov-pan.mp4 -c:v libx264 -qp 0 -preset ultrafast prov-pan-ref.mkv
# For each reference REF: one encode at 18; and for M in 12 14 16, the master at M, then the video at 18 from it.
ffmpeg -i REF -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p direct.mp4
ffmpeg -i REF -an -c:v libx264 -preset medium -crf M -pix_fmt yuv420p masterM.mp4
ffmpeg -i masterM.mp4 -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p doubleM.mp4
# PSNR and SSIM of each against REF.
ffmpeg -i doubleM.mp4 -i REF -lavfi "[0:v][1:v]psnr" -f null -
ffmpeg -i doubleM.mp4 -i REF -lavfi "[0:v][1:v]ssim" -f null -
```

- **Not a column.** The composition row freezes the customer's video's settings
  (ADR-0050); the master's quality is the constant this composer reads, whatever
  profile it is handed. Changing it must be a new profile, never an edit in
  place; DS-5b's composition profile v2 binds it (Decision 6). Nothing runs the
  master encode until then.
- **Same raster and frame rate as the video.** A later disclosure or logo change
  lays its image over the master directly, with no scaling.

## Decision 2 — The customer's video is the master with the image laid over it

`applyDisclosure` encodes the customer's video from a Clean Master file:

```text
-i <master> -f png_pipe -loop 1 -i <private copy of the image>
[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p
-map_metadata -1 -map_chapters -1 -an,
libx264 at the profile's preset, CRF and pixel format, +faststart, mp4
```

- **The method ADR-0072 measured**, now in the composer: the image is the
  frame's size, so it goes at the origin, unscaled; looped, it covers every
  frame of the master; `shortest=1` ends the video with the master.
- **The image's reader is stated.** Left to guess from the path, FFmpeg reads a
  `.png` with its PNG pipe reader, but a path holding a `%` pattern with its
  image-sequence reader, which expands the pattern and opens the file again for
  every frame. Measured: with that reader, an image replaced in place during an
  encode changed every later frame. `-f png_pipe` is the reader ADR-0072's
  measurements used, now chosen rather than inferred, as `-f mp4` already is for
  the output.
- **Nothing from an input's container.** By default FFmpeg copies the first
  input's title, comment and chapters into the output, and an mp4 holds a
  chapter as a track of its own. Measured: a clip's title, comment and chapter
  survived composition, and with `-map_metadata -1` alone the chapter still
  did, without its title. `-map_metadata -1` and `-map_chapters -1` together
  drop them in all three encodes (`compose`, the master, the video), so nothing
  a provider's file carries reaches a customer's file. The pixels are
  unchanged.
- **The mode chooses the graph.** Mode A (`THROUGHOUT`) lays it over the whole
  video. A mode the composer does not implement is refused with an internal
  error, never encoded as Mode A or without the disclosure. Mode B will limit
  the overlay with `enable`.
- **Its input is a file the caller names**, documented as the local copy of the
  bytes stored at the master's key. Making that true, and proving that file is
  the profile's size and rate, is DS-5b's (Decision 6). The customer's video
  written over the master it is made from is refused as an internal error.

## Decision 3 — The image is the reviewed one, and FFmpeg reads only those bytes

The composer takes the deployment's copy of `assets/disclosure/` as
`disclosureLayerDirectory`, an absolute path (a relative one is refused when the
composer is built). Before each `applyDisclosure` it:

1. checks what needs nothing from the deployment: the profile is the one it
   implements, the mode is one it implements, and `DISCLOSURE_LAYER_ASSETS` has
   an image for the profile's frame size. Any of those failing is a defect
   (`INTERNAL_ERROR`), whatever the deployment holds; every size a profile
   resolves to has an image (ADR-0071 Decision 1);
2. reads the deployment's image and compares its SHA-256 with the pinned one;
3. writes the bytes it compared to a new private directory of its own (created
   `0700`, the file created exclusively, `0600`), hands FFmpeg that copy, and
   removes the directory after the run, whatever the run's outcome.

A missing directory setting, a missing or unreadable file, or a file that is
not the reviewed image is a deployment fault (`CONFIGURATION_ERROR`) and nothing
runs: retrying cannot give a video its disclosure there. A read that fails for
a reason the deployment did not cause (too many open files, an I/O error), or a
private copy that cannot be written, retries the run. There is no fallback, no
scaling of another size's image and no drawn text.

The check runs at every run, not once at start-up, so a file replaced while the
worker runs is caught at its next use. FFmpeg reads the looped image throughout
the encode, so checking the deployment's file and then letting FFmpeg read that
same file would leave the whole encode open to a change of it. Reading the
private copy, FFmpeg lays the bytes that were compared over the video, whatever
happens to the deployment's directory meanwhile.

## Decision 4 — What the media suites prove

The composer suite (`tests/media/composer.media.test.ts`) now composes each of
the six sizes' Clean Master from its two synthetic clips, then lays the
disclosure over it. For the master **and** the customer's video, everything
ADR-0072 Decision 4 lists still holds: the inspector's facts, H.264 in
`yuv420p` at 30 fps with square pixels and 105 frames, letterboxing, the held
last frame and the exact cut. The first clip now carries a title, a comment, a
stream handler name and a chapter, and neither file carries any of them or any
stream but the video. Then, at the first frame, the cut and the held last
frame:

| Measure, in BT.601 lightness | Bound | Measured (FFmpeg 6.1.1) |
| --- | --- | --- |
| mean error where the image has ink, against its blend over the master | 6 | 1.2 to 4.1 |
| 99th percentile of that error | 30 | 4.4 to 20.3 |
| the strongest 1% of the text, against the master | at least 72 apart | 120 to 181 |
| the customer's video against the master, beyond 16 pixels of the ink | 6 | at most 3.5 |
| the master under the text, against the rows just above it | 4 | 0 |

These frames hold a cut and letterbox bands, unlike ADR-0072's flat
backgrounds. Over a band's pure black, one edge pixel of the first frame is up
to 46 levels out, so the bound is on the 99th percentile rather than the
largest error. Beyond the text the comparison is of lightness, because between
two encodes a band's edge moves by up to 20 in one colour channel (`yuv420p`
halves the colour planes); the largest, 3.5, is at the edge of the yellow bands
in the square frames, and text there would be 72 or more out. The last row is
what shows the master carries no disclosure: without one, each of its columns
under the text is the colour of the rows above.

The overlay suite (`tests/media/disclosure-overlay.media.test.ts`) now has the
composer lay each image over a one-second Clean Master of each of its nine
backgrounds, encoded with FFmpeg at the master's settings. Its bounds are
unchanged, and the measurements came out the same as ADR-0072's: a mean of 1.31
to 1.69, a largest error of 6.3 to 16.6, the background exact, and the strongest
1% of the text 82 to 158 levels from it.

`compose`, which the runner still calls, no longer runs on real FFmpeg itself:
the unit suite proves its argument vector is the master's with only the quality
changed, and the master runs in every size.

## Decision 5 — Nothing calls them yet

DS-5a changes the composer and its port, and nothing else. The composition
runner still claims under profile v1 and calls `compose`, so a composed
deliverable still has no disclosure; nothing constructs the composer, the
runner or any composition adapter in production (the existing dormancy test);
and no worker image carries the disclosure images or sets
`disclosureLayerDirectory`. The disclosure's argument builder is not exported
from `@app/storage`, since its image path must be the private copy. The DS-1
shape test now allows exactly one managed-output file, the composer, to read the
layer table; composition execution, validation, the database and both
applications still read none of it.

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
- **The master is the profile's size and rate before anything is laid over it.**
  `applyDisclosure` lays the frame-sized image at the origin, so a master of
  another size would come out with the image cut off or misplaced, or, smaller
  than the image's ink, with no disclosure at all, and nothing today would
  notice: validation only requires positive dimensions. Composition probes the
  read-back master and requires its width, height and 30/1 frame rate to equal
  the profile's before calling it, with a media test of a mismatched master
  refused. DS-6's validation then requires the same of the customer's video.
- **One record.** The transaction that records the composed video's receipt
  writes the Clean Master record in the same commit, and its replay compares
  both receipts.
- **A ceiling for the master.** A master over its own ceiling blocks the work,
  as an oversized video does.

---

## Consequences

- The composer can make the master and the customer's video from it; their
  arguments are pinned, and both encodes are measured on real FFmpeg in CI.
- No input's tags or chapters reach a composed file, including `compose`'s.
- A deployment that composes must ship `assets/disclosure/`'s six images and
  name the directory by an absolute path; without them the composer refuses to
  make a video (`docs/decisions/TODO.md`).
- The master costs storage of 1.1 to 1.5 times each video, as the approved plan
  estimated, VTaVision's cost (ADR-0052 Decision 17), and a second encode per
  composition.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
