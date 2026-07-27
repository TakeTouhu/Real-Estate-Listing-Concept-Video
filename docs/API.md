# API Design

Version: 1.0
Status: Draft

## Conventions

- REST + JSON under `/api/v1`
- OpenAPI is the contract source of truth
- Authentication and organization scope required
- Schema validation for all requests
- Audit logging for writes
- `Idempotency-Key` required for generation and billing-sensitive commands
- Stable internal error codes; never expose provider payloads or secrets

## Endpoints

### Authentication and organization

- `POST /auth/login`
- `POST /auth/logout`
- `POST /organizations/{organizationId}/invitations`
- `POST /invitations/{token}/accept`

### Properties

- `GET /properties`
- `POST /properties`
- `GET /properties/{propertyId}`
- `PATCH /properties/{propertyId}`
- `DELETE /properties/{propertyId}`

### Assets

- `POST /properties/{propertyId}/assets/upload-url`
- `POST /properties/{propertyId}/assets/complete`
- `GET /properties/{propertyId}/assets`
- `PATCH /assets/{assetId}`
- `DELETE /assets/{assetId}`
- `POST /assets/{assetId}/reanalyze`

### Video projects

- `POST /video-projects`
- `GET /video-projects`
- `GET /video-projects/{projectId}`
- `PATCH /video-projects/{projectId}`
- `POST /video-projects/{projectId}/storyboard/generate`
- `PATCH /video-projects/{projectId}/storyboard`

### Generation

- `POST /video-projects/{projectId}/estimate`
- `POST /video-projects/{projectId}/generations`
- `GET /generations/{jobId}`
- `POST /generations/{jobId}/cancel`
- `POST /generations/{jobId}/retry`

Example request:

```json
{
  "durationSeconds": 30,
  "aspectRatio": "16:9",
  "resolution": "1080p",
  "stylePreset": "natural",
  "cameraMotion": "slow-walkthrough",
  "prompt": "明るく自然で誤認を招かない室内紹介動画",
  "negativePrompt": "存在しない家具、設備、窓、扉、眺望を追加しない",
  "includeMusic": true,
  "includeCaptions": true
}
```

Example response:

```json
{
  "jobId": "job_public_123",
  "status": "QUEUED",
  "reservedCredits": 12,
  "estimatedCompletionSeconds": 420
}
```

### Outputs

- `GET /video-projects/{projectId}/outputs`
- `GET /outputs/{outputId}/download-url`
- `POST /outputs/{outputId}/approve`
- `POST /outputs/{outputId}/reject`
- `DELETE /outputs/{outputId}`

### Billing

- `GET /billing/plan`
- `GET /billing/usage`
- `GET /billing/credits`
- `POST /billing/checkout-session`
- `POST /billing/webhooks/stripe`

### Internal provider webhooks

- `POST /internal/webhooks/wavespeed`

This endpoint must verify the current WaveSpeedAI-supported signature or authentication mechanism, deduplicate events, and resolve jobs using internal provider references.

## Error envelope

```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "動画生成に必要なクレジットが不足しています",
    "requestId": "req_123",
    "details": {}
  }
}
```

## Events

- `generation.queued`
- `generation.started`
- `generation.progressed`
- `generation.completed`
- `generation.failed`
- `output.approved`
- `credit.reserved`
- `credit.settled`
- `subscription.updated`

Events and webhooks require replay protection and idempotent consumers.