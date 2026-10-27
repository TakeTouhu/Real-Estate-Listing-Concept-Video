# API Changes — GS-5a-2

The test route, built only outside production (ADR-0090). **No migration; no
route and no page.** Nothing outside tests builds it yet.

## HTTP

No change.

## Internal API

### Added: `@app/video-providers`

| Export | What it is |
| --- | --- |
| `createFakeRouteKit(env)` | the test route's model catalog, route policy, quality offer, price catalog and exchange rate; throws `CONFIGURATION_ERROR` when the given or the process's `NODE_ENV` is `production`, or `VIDEO_PROVIDER` is not `fake` |
| `FakeRouteKit` | `{ models, routePolicy, qualityOffer, pricing, fx }`, frozen |
| `FAKE_ROUTE_VERSION` | `dev-test-route.1`: the kit's route policy and price contracts are recorded under it |
| `FAKE_VIDEO_MODEL_ID` / `FAKE_VIDEO_MODEL_KEY` | the test provider's model id and catalog key |

The kit's parts:

- `models`: the test provider's entry alone, as the default; 720p and 1080p,
  each generated natively; 5 to 15 seconds.
- `routePolicy`: Normal at 720p and HQ at 1080p, image-to-video, no audio,
  under `FAKE_ROUTE_VERSION`; no production route.
- `qualityOffer`: `routeQualityOffer(routePolicy)`, Normal and HQ.
- `pricing`: production's contracts and the test provider's two, one cent a
  second each.
- `fx`: a fixed ¥150 per dollar, `fx_dev_fixed_usd_jpy_150`.

### Changed

Nothing. Production's route policy, model catalog and price catalog are
unchanged.
