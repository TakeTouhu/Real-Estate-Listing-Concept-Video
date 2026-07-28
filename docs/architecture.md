# Architecture Diagram

Version: 1.1 (as implemented through Phase 3A-1)
Status: Describes **implemented** behavior only. Components that do not exist yet
are marked `(not implemented)`.

See `docs/SystemArchitecture.md` for the target architecture and
`docs/decisions/` for the decisions behind this shape.

## Runtime architecture

```mermaid
flowchart TB
  browser["Browser<br/>(server-rendered pages + XHR upload)"]

  subgraph web["Next.js app — apps/web (Node runtime, server-only secrets)"]
    pages["Pages<br/>/login · / · /properties/[id]"]
    authapi["Auth routes<br/>register · login · logout"]
    propapi["Property + asset routes<br/>properties · upload-url<br/>complete · retry · download-url"]
    storageapi["Signed storage endpoints<br/>PUT /api/storage/upload<br/>GET /api/storage/download"]
    health["Health routes<br/>/api/health · /api/health/ready"]
  end

  subgraph domain["@app/domain — pure domain, no I/O libraries"]
    identitysvc["AuthService<br/>OrganizationService<br/>MembershipService"]
    propsvc["PropertyService<br/>AssetService"]
    anasvc["Analysis contracts<br/>normalization · ordering<br/>duplicate rules<br/>(AnalysisService: 3A-2)"]
    authz["authorizeOrganization<br/>RBAC + tenant scope"]
    audit["recordAudit"]
    ports["Ports:<br/>repositories · ObjectStorage<br/>MalwareScanner · ImageProcessor<br/>ImageAnalysisProvider"]
  end

  subgraph adapters["Adapters"]
    db["@app/database<br/>Prisma repositories"]
    store["@app/storage<br/>LocalObjectStorage<br/>SharpImageProcessor<br/>PassthroughMalwareScanner"]
    vp["@app/video-providers<br/>VideoGenerationProvider<br/>Fake · WaveSpeed"]
    aip["@app/ai-providers<br/>ImageAnalysisProvider<br/>Deterministic (offline)"]
    obs["@app/observability<br/>redacting logger"]
  end

  pg[("PostgreSQL")]
  objects[("Object storage<br/>in-process today<br/>S3/Azure planned")]
  wavespeed["WaveSpeedAI API<br/>(adapter only; not called in Phase 2)"]

  worker["apps/worker<br/>bootstrap + self-check<br/>queue consumer (not implemented)"]

  browser --> pages
  browser --> authapi
  browser --> propapi
  browser -- "signed URL only" --> storageapi

  pages --> identitysvc
  pages --> propsvc
  authapi --> identitysvc
  propapi --> propsvc
  propapi --> authz
  storageapi -- "verify HMAC token" --> store

  identitysvc --> authz
  propsvc --> authz
  identitysvc --> audit
  propsvc --> audit
  authz --> ports
  audit --> ports

  ports -.implemented by.-> db
  ports -.implemented by.-> store
  ports -.implemented by.-> aip
  anasvc --> ports

  db --> pg
  store --> objects
  worker --> vp
  vp -.server-side only.-> wavespeed
  web --> obs
  worker --> obs
```

## Key boundaries

- **Domain never imports an SDK.** `@app/domain` depends only on ports; Prisma,
  sharp, and provider SDKs live in adapter packages.
- **Secrets are server-only.** `DATABASE_URL`, `SESSION_SECRET`,
  `STORAGE_SIGNING_SECRET`, and `WAVESPEED_API_KEY` are read through the
  validated server env and are never referenced from client components. No
  `NEXT_PUBLIC_*` variable exists.
- **The browser never receives a storage key.** It receives only short-lived,
  single-purpose signed URLs.
- **Tenant scope is enforced twice**: repository lookups filter by
  `organizationId`, and `authorizeOrganization` requires a membership (plus a
  permission for writes).

## Phase status of each component

| Component | Status |
| --- | --- |
| `apps/web` pages, auth, property/asset, storage, health routes | Implemented |
| `@app/domain` identity + property/media services | Implemented |
| `@app/database` Prisma repositories | Implemented |
| `@app/storage` object storage, signing, image pipeline, scan hook | Implemented (in-process storage) |
| `@app/video-providers` Fake + WaveSpeed adapters | Implemented; WaveSpeed not invoked |
| `@app/domain` analysis contracts, normalization, ordering/duplicate rules | Implemented (Phase 3A-1) |
| `@app/ai-providers` `ImageAnalysisProvider` + deterministic offline adapter | Implemented (Phase 3A-1); **no real vision vendor** (ADR-0009) |
| `AnalysisService`, `AssetAnalysis` persistence | **Not implemented** (Phase 3A-2) |
| Analysis review UI | **Not implemented** (Phase 3B) |
| `@app/observability` redacting logger | Implemented |
| `apps/worker` queue consumer, generation orchestration | **Not implemented** (Phase 4) |
| `@app/queue` | **Not implemented** (placeholder) |
| FFmpeg composition, billing, Stripe | **Not implemented** (Phases 5–6) |
