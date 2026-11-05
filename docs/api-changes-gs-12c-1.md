# API Changes — GS-12c-1

A download link that names the file it saves (ADR-0118). **No migration, no
new route and no environment variable**; nothing signs a named link yet, so no
token names a file and no answer changes.

## HTTP

### Changed: `GET` and `HEAD /api/storage/download?token=…`

A token may now name the file its object is saved under. For such a token,
every answer that serves bytes carries one more header:

| The token | `200` and `206` (and `HEAD`'s) |
| --- | --- |
| names a file | `Content-Disposition: attachment; filename="<plain>"; filename*=UTF-8''<encoded>` |
| names none, as every token given so far | no `Content-Disposition`, as before |

`<encoded>` is the name as percent-encoded UTF-8 (RFC 8187), with `'`, `(`,
`)` and `*` encoded too. `<plain>` is the same name with each character outside
printable ASCII, and each `"`, `\` and `%`, as `_`. `401`, `404` and `416`
name no file.
Everything else is as GS-12a left it (`docs/api-changes-gs-12a.md`).

A token is answered `401 Unauthorized`, as a forged one, when it names a file
on an upload, or a name that is not a string or not safe to send, or carries
more than four fields.

## Internal API

### Changed: `@app/domain`, `ObjectStorage.createSignedDownloadUrl(key, ttlSeconds, options?)`

`options` is `SignedDownloadOptions`, `{ attachmentFilename: string }`: the
link names that file. Without it, the link is as before. Both stores
(`LocalObjectStorage`, the shared folder's) take it; a name that is not safe
to send is a rejected promise, `AppError` `INTERNAL_ERROR`.

### Changed: `@app/storage`, `signStorageToken`, `verifyStorageToken`, `signedStorageUrl`

`SignedKeyToken` has an optional `attachmentFilename`, signed as the payload's
fourth field. `signStorageToken` throws `INTERNAL_ERROR` for one on an upload
or one not safe to send; `verifyStorageToken` answers `null` for such a token
and returns the name of a download's.

### Added: `@app/domain`, `isAttachmentFilename`, `assertAttachmentFilename`, `ATTACHMENT_FILENAME_MAX_BYTES`, `replaceUnsafeFilenameCharacters`, `utf8ByteLength`

A name a link may carry: not empty, at most `240` UTF-8 bytes, neither
starting nor ending with a dot or white space, and holding no control or
invisible format character (the zero-width joiner and non-joiner aside), line
or paragraph separator, half of a surrogate pair, or any of
`\ / : * ? " < > |`. `replaceUnsafeFilenameCharacters` replaces each
character such a name may not hold; `utf8ByteLength` measures a name.
