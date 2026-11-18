# API Changes — RD-3c

The Google Cloud Storage adapter's credential, and connections of its own
(ADR-0158). **No migration, no new route and no page.** Nothing in either
application constructs the adapter.

## HTTP

No change. Every route and page answers as before, with the same adapters
from the same environment.

## Internal API

### Changed: `@app/storage/google-cloud-storage`

The subpath's exports are unchanged.

| Export | Change |
| --- | --- |
| `createGoogleCloudStorage(options)` | for the endpoint `https://storage.googleapis.com` alone, sends every request a token from the metadata server; sends every request, to the store and for the token, on HTTP agents of its own, never through a proxy |
| `GoogleCloudStorageError` | gains `STORAGE_CREDENTIAL_UNAVAILABLE` (no token could be had for Google's store, and nothing was sent to it); `STORAGE_TIMEOUT` also names a limit that ended a request in a production build |

### What the token asks

| Request | When | Limit |
| --- | --- | --- |
| `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` with `Metadata-Flavor: Google` | the endpoint is Google's, and no token is held, or the one held is due: 240 seconds before its end, or at half its life if it lives less than 480 | 3 seconds, gaxios's own |

| Answer from the store | What happens to the token |
| --- | --- |
| `401` | let go, if it is still the one held; the request fails `STORAGE_FORBIDDEN` and is not sent again |
| anything else | kept |

A token that is due is still sent while it lasts when its renewal fails.
Nothing is retried, and nothing is read from the environment.

### Internal to the adapter's folder (not exported)

- `access-token.ts`: the metadata server's token, `metadataAccessToken`,
  with `GOOGLE_CLOUD_STORAGE_CREDENTIAL_LIMIT_MS` (3,000) and
  `GOOGLE_CLOUD_STORAGE_TOKEN_MARGIN_MS` (240,000).
- `client.ts`: the adapter's gaxios client and its two agents, with Node.js
  22's global-agent options (`keepAlive`, `lifo`, an idle limit of 5,000
  milliseconds).
