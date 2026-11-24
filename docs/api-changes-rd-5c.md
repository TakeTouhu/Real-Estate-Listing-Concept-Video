# API Changes — RD-5c

The upload panel's Retry (ADR-0165). **No migration, no new route and no
setting.**

## HTTP

`POST /api/assets/{id}/complete` and `POST /api/assets/{id}/retry` now
answer `422` with "This property already has the maximum of 20 photos"
for a `FAILED` photo when the Property's photos that hold a place already
fill its limit, as `POST /api/properties/{id}/assets/upload-url` does. The
photo stays `FAILED`. A `PENDING_UPLOAD` photo is answered as before.

The Property page's upload panel asks those routes differently when Retry
is pressed:

| The photo | Before | After |
| --- | --- | --- |
| `FAILED` (its bytes stored) | `POST /api/assets/{id}/retry`, then asked to choose the file again, which made a new photo | `POST /api/assets/{id}/complete` again |
| no status (the upload or completing it failed) | as above | `POST /api/assets/{id}/retry`, the kept file sent to its new link, then `POST /api/assets/{id}/complete` |
| `QUARANTINED`, `REJECTED` | Retry offered; the server refused it | no Retry |

A photo whose upload link was refused has no Retry, as before.

## Internal API

| Export | Change |
| --- | --- |
| `AssetService.completeUpload`, `AssetService.retryUpload` (`@app/domain`) | refuse a `FAILED` photo, as `VALIDATION_FAILED`, when no place is left |
| `UploadPanel` (web app) | keeps each chosen file in its own state |
