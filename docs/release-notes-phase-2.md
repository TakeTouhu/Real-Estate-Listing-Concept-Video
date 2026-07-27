# Release Notes — Phase 2: Properties and Secure Media Upload

Status: **Release candidate under review (PR #3). Not merged, not released.**
Date prepared: 2026-07-27

## What this release adds

Real-estate teams can now register properties and upload the photos those
videos will be generated from — securely, privately, and with a full audit
trail.

### For users

- **Properties.** Create a property with a name, type, optional masked address,
  and description. Creating one requires confirming that you own or have
  licensed the photos you will upload.
- **Photo upload.** Drag and drop (or pick) JPEG, PNG, or WebP photos, up to 20
  per property and 25 MB each. Each file shows live upload progress, then a
  processing indicator, then a clear result.
- **Automatic cleanup of your photos.** Every accepted photo is re-encoded with
  camera metadata removed (including GPS location), rotated to the correct
  orientation, resized to a sensible master size, and given a thumbnail.
- **Duplicate hints.** Visually near-identical photos are flagged so you can
  decide whether to keep both.
- **Clear failures and retry.** If an upload fails, you see a plain-language
  reason and can retry without starting over.
- **Private by default.** Photos are never on a public URL. Previews and
  downloads use short-lived signed links.

### For operators and reviewers

- Every property and asset write produces an audit event (eleven new actions).
- Uploads that fail a safety check land in an explicit terminal state —
  `REJECTED` (wrong type, wrong size, wrong dimensions), `QUARANTINED` (malware
  signature), or `FAILED` (scan or decode error) — and quarantined content can
  never be downloaded.
- Deleting a property moves its photos to `DELETION_PENDING`, ready for the
  retention job that lands in Phase 7.

## Upgrade / deployment notes

1. **New required environment variable.** Set `STORAGE_SIGNING_SECRET` (32-byte
   random hex recommended) in every environment. Startup fails fast without it.
   It is server-side only — never expose it to the browser.
2. **Database migration.** Apply
   `00000000000001_phase2_properties_media`:
   ```bash
   pnpm --filter @app/database run db:migrate
   ```
   The migration is additive only; see `docs/migration-notes.md`.
3. **Native dependency.** `sharp` is now required by `apps/web`. Deployment
   images must install it for the target platform (`linux-x64` by default) and
   keep it external to the bundle.
4. **No breaking API changes.** All Phase 0/1 endpoints behave as before.

## Known limitations in this release

These are deliberate and tracked; they must be resolved before a production
launch.

| Limitation | Impact | Tracked |
| --- | --- | --- |
| Object storage is in-process (`LocalObjectStorage`) | Uploaded bytes are lost on restart and are not shared between instances. **Not production-ready.** | `docs/decisions/TODO.md`, ADR-0008 |
| Image processing runs inline in the completion request | Large photos hold a request open; no retry queue | Phase 4 follow-up |
| Malware scanning is a hook, not a real engine | Only the EICAR test signature is detected | ADR-0008 |
| No live-PostgreSQL CI job | Prisma adapters are typechecked and built but not integration-tested in CI | Carried over from Phase 1 |
| Perceptual hash is aHash, not DCT pHash | May be permissive on real-world photos | `docs/decisions/TODO.md` |

## Not in this release

AI room classification and analysis, storyboards, video generation, FFmpeg
composition, human review/approval of videos, billing, and credits. See
`docs/Roadmap.md`.

## Verification

- typecheck, lint, 117 unit/integration tests, and the production build all pass.
- Exact results: `docs/phase-2-completion.md`.
