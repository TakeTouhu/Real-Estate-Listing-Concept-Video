# API Changes — Phase 4C-3B-2B

One **breaking** rename on the video-project creation endpoint and its DTO. No
new endpoints, no new permissions, no change to authentication or tenancy.

## Breaking — `resolution` becomes `targetOutputResolution`, and is a closed set

### `POST /api/properties/{propertyId}/video-projects`

Before:

```jsonc
{ "organizationId": "org_…", "name": "…", "durationSeconds": 30,
  "aspectRatio": "16:9", "resolution": "1080p" }
```

After:

```jsonc
{ "organizationId": "org_…", "name": "…", "durationSeconds": 30,
  "aspectRatio": "16:9", "targetOutputResolution": "1080p" }
```

Two changes, and both are deliberate:

1. **The key is renamed.** `resolution` meant two different things at once —
   the product deliverable the customer asked for, and the token a provider is
   told to generate at. They coincided only because one wired model made them
   coincide (ADR-0033, ADR-0034).
2. **The value is now a closed vocabulary**: `720p` or `1080p`. Anything else is
   `422`, including a non-string. Previously any non-empty string was accepted
   and stored, which is why the migration for this phase can encounter `4k` in
   existing data.

**`resolution` is not accepted as an alias.** A request sending only the old key
fails with `422` on the missing `targetOutputResolution`. Keeping the old name
writable would let a client that was never updated keep setting the ambiguous
value, which is the drift this change removes — a silent acceptance would be
worse than a loud rejection.

Error body, unchanged in shape:

```jsonc
{ "error": { "message": "targetOutputResolution must be one of: 720p, 1080p" } }
```

Aspect ratio is **unaffected**. It remains free text validated for shape only;
whether a model can honour it is decided at generation admission.

### `VideoProjectDto`

`resolution: string` becomes `targetOutputResolution: "720p" | "1080p"`, on
`POST` responses and on `GET /api/properties/{propertyId}/video-projects`. The
old field is removed rather than duplicated.

Nothing else on the DTO changes. It still exposes no compiled prompt, no
provider name, no model id, and no request hash.

## Not exposed

Everything else this phase added is server-side and stays there:

- the selected model (`modelKey`) — `GenerationService.startScene` takes it as
  an optional argument with **no HTTP or UI caller yet**, so there is no model
  selector in this release;
- the frozen delivery snapshot on a generation attempt — the native token, the
  normalization, and `nativeMeetsTarget`;
- the request-identity version. `requestHash` is internal and appears in no DTO;
  its `sha256:v2:` prefix is not an API-visible change.

`nativeMeetsTarget` deserves a note as a **known gap**: a customer who picks a
1080p deliverable on a model that upscales to it has no way to see that from the
API. The fact is persisted and audited so the claim is checkable, but where that
disclosure belongs is a product decision recorded in `docs/decisions/TODO.md`,
and it is a prerequisite for offering model selection to customers.

## UI

The create-project form's free-text "Resolution" input becomes a
closed **"Output resolution"** selector offering exactly the product vocabulary,
starting unset. It is deliberately not defaulted — a pre-selected `1080p` would
have a customer "choose" the more expensive deliverable by not looking at the
field.

The options are resolved by the server page and passed down as plain data, the
same boundary rule already used for camera motions: the panel is a Client
Component, and importing the domain constant would put domain code in the
browser bundle. The server refuses an off-vocabulary value regardless of what
the control offers, because the same route serves API callers who never load
this page.

Project detail views relabel the displayed field to "Output resolution".

## Migration for API clients

Rename the request key and the response field. There is no compatibility window:
this product has no external API consumers yet, and adding a deprecation alias
for a value whose meaning was the defect would preserve exactly the thing being
fixed.
