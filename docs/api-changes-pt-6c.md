# API Changes — PT-6c

`sharp` goes from 0.33.5 to 0.35.5 in `apps/web` and `packages/storage`,
and two pnpm overrides lift `nanoid` and `source-map-js` to their fixed
patch releases (`package.json`, `pnpm.overrides`). Production readiness,
part 2, approved by the product owner on 2026-11-26. **No migration, no
new setting and no ADR**; no route, answer or stored value changes.
`next` stays at 15.5.28.

## Why

`pnpm audit --prod` on 2026-11-26, on the base (`main @ 1c3cb69`), on
the `sharp` bump alone, and with the overrides as well:

| `pnpm audit --prod` | Critical | High | Moderate | Total |
| --- | --- | --- | --- | --- |
| before | 0 | 11 | 5 | 16 |
| `sharp` 0.35.5 | 0 | 5 | 5 | 10 |
| and the overrides | 0 | 3 | 5 | 8 |

`sharp` 0.33.5 and the 0.34.5 `next` takes as optional held three high
advisories each, in the libvips they bundle; both fixed from 0.35.5.
`next` now takes the one `sharp` 0.35.5 as well, since its optional
range is `^0.34.3 || ^0.35.5`. `nanoid` 3.3.16 and `source-map-js`
1.2.1, which `postcss` 8.4.31 brings, held one high each; their fixes,
3.3.18 and 1.2.2, are patch releases inside the ranges `postcss` asks
for.

Still open, recorded in `TODO.md`:

- `postcss` 8.4.31, pinned exactly by `next` 15.5.28: two high
  (GHSA-6g55-p6wh-862q, fixed from 8.5.12; GHSA-r28c-9q8g-f849, from
  8.5.18) and two moderate; 8.5.23 is past all four.
- `zod` 3.25.76: one high (GHSA-mrhx-c7xc-m3w5), fixed in 4.6.6, a
  major version (PT-6d).
- `next` 15.5.28: three moderate, fixed only in 15.5.29, which do not
  apply here (`docs/api-changes-next-15-5-28.md`).

## Why overrides and not a lockfile refresh

An override names only the package and the versions it lifts:
`nanoid@<3.3.18` becomes 3.3.18, `source-map-js@<1.2.2` becomes 1.2.2.
Once every dependent asks for a fixed version, the override matches
nothing. A refresh with `pnpm update` would also move other packages;
measured, it bumped `@babel/runtime` 7.29.7 to 7.29.15.
`tests/dependency-overrides.test.ts` holds the two overrides, their
form, the lockfile's copy of them and the one `sharp` the lockfile
keeps.

## What changes in `sharp`

- libvips 8.15.3 to 8.18.7; the glibc it needs, 2.26 to 2.28 (Debian
  13's is 2.41). Node.js `>=20.9.0`; the repository requires 22.
- The package ships both ES modules and CommonJS, and no install
  script. The `sharp.` type namespace is gone, so the one test that
  named `sharp.Exif` imports the type `Exif` instead.
- The options 0.35.0 removed are not used here.

## What was measured

On Ubuntu, outside Docker, with 0.33.5 and 0.35.5 side by side:

- On 44 synthetic images, the normalized JPEG and the WebP thumbnail
  are byte-identical between the two.
- The perceptual hash is the one difference: equal on 13 of the 44,
  at most 3 bits apart on the rest, under the duplicate threshold of 6
  (`DUPLICATE_HAMMING_THRESHOLD`, `packages/domain/src/property/media.ts`).
  The normalized JPEGs are equal, so the difference is in the 8-by-8
  reduction. No hash is stored anywhere yet: nothing is deployed.
- The six disclosure layers re-render byte-identical to the committed
  files with the bundled `FONTCONFIG_FILE` (ADR-0071's pins hold).
- EXIF, GPS, ICC and XMP are still stripped. A JPEG followed by a ZIP
  header and the EICAR string still re-encodes to the clean image's
  bytes, as ADR-0163 measured on 0.33.5. A truncated JPEG is still
  refused; only libvips's wording changed, and nothing reads it.
- The unit suite (340 files, 8,553 tests), the media suite (5 files,
  172 tests), typecheck, lint and the production build pass.

No real camera photograph was tested. Not measured before CI: `sharp`
0.35.5 inside the Debian 13 images (the worker image's `media-test`
stage and the `production-mode` job).
