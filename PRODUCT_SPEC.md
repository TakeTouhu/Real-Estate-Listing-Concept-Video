# PRODUCT_SPEC.md — Real-Estate-Listing-Concept-Video 引き継ぎ仕様書

> **対象読者:** Munder Difflin / Michael（このプロジェクトを初めて見る開発者・エージェント）  
> **目的:** このファイル単体とリポジトリを読めば、現状を壊さずに開発を再開できること。  
> **As-built baseline:** `2dddb3beb391667f6f400e5a20a7a5793a11eef1`  
> **Baseline milestone:** `PHASE 4C-3A-2b COMPLETE / MERGED / CLOSED`  
> **次の実装:** **Phase 4C-3B-1 — Provider Diagnostic Sanitization Foundation**  
> **重要:** 本書では「実装済み」「実装承認済みだが未実装」「将来計画」を明確に分離する。計画を実装済みとして扱わないこと。

---

## 0. 最初に読むべきこと

この製品は、アップロードされた不動産写真から AI を用いて室内ウォークスルー風の物件紹介動画を生成する、**商用・マルチテナント SaaS**である。デモ用の一枚岩アプリではなく、以下を前提に設計している。

- テナント分離
- 外部 AI Provider の交換可能性
- 有料 Provider 呼び出しの二重実行防止
- クレジット/課金の exactly-once 方針
- 監査証跡
- Provider 障害時の復旧
- 短命署名 URL による非公開アセット管理
- 人間による最終レビュー必須
- Provider の一時 URL / job ID を顧客へ公開しない

**現在はまだ実際の動画生成を行わない。** Phase 4 の実行基盤を構築中であり、WaveSpeedAI への本番 POST を呼ぶ production caller は 0 のまま維持されている。

### 現在の最重要原則

1. `SUBMITTING` は「Provider に POST してよいライセンス」を表す。
2. そのライセンスは DB の `SceneGeneration` を `QUEUED -> SUBMITTING` にしただけでは足りない。
3. source asset を同じ DB row lock 下で再検証し、PreparedSourceIdentity と一致し、トランザクションが **COMMIT** した場合だけ成立する。
4. Provider POST の結果が「受理されたか不明」なら、勝手に再 POST してはいけない。
5. `SUBMISSION_UNKNOWN` は自動復旧しない。二重課金防止のため identity を保持したまま人間判断に止める。

---

# 1. 製品概要

**製品名:** Real Estate Virtual Tour AI / Real-Estate-Listing-Concept-Video

不動産事業者が物件写真をアップロードし、AI による画像解析、人間によるレビュー、ストーリーボード作成、AI 動画生成、最終動画の合成・レビュー・公開を行う SaaS。

最終的なユーザーフローは次の通り。

```text
Login / Organization
  -> Property 作成
  -> 写真 Upload
  -> MIME / Malware / EXIF / Normalization
  -> AI Room Analysis
  -> Human Review / Correction
  -> Storyboard Compose
  -> Scene Generation Admission
  -> DB durable queue
  -> Worker claims generation
  -> WaveSpeedAI image-to-video
  -> Provider result retrieval
  -> Managed Storage copy
  -> FFmpeg composition
  -> Human review / approve
  -> Publish
  -> Credit settle exactly once
```

現在は **Storyboard + SceneGeneration admission + durable execution/claim safety** までが実装済み。Provider への有料 submission はまだ dormant。

---

# 2. 目的

## 2.1 Product goal

写真のみから、不動産掲載用の「ウォークスルー風」動画を安全かつ商用利用可能な形で生成する。

## 2.2 守るべき Product rules

- 顧客はアップロード画像の所有権または利用権を持つこと。
- AI 生成物には原則 AI-generated disclosure を表示する。
- 実測寸法、正確な幾何形状、実写ウォークスルーであるかのような表現をしない。
- 存在しない窓、扉、設備、眺望、構造物を意図的に追加しない。
- AI output を自動公開しない。**Human review / approval 必須。**
- User prompt と upload file は untrusted input として扱う。
- 顧客アセットは private。short-lived signed URL でのみアクセスする。
- 全 tenant-owned data は authenticated organization に scope する。
- 有料生成は credit reserve -> generation -> settle exactly once の順序を守る。

## 2.3 Non-goals / 現時点でしないこと

- 写真から正確な間取りを推定する機能
- Provider URL の直接顧客公開
- Provider prediction ID の顧客公開
- 自動公開
- 自動 retry による ambiguous paid POST の再送
- Redis / BullMQ / SQS / Azure Service Bus の導入

---

# 3. 現在の開発基準点

## 3.1 Git baseline

```text
main merge commit:
2dddb3beb391667f6f400e5a20a7a5793a11eef1

Completed milestone:
Phase 4C-3A-2b
```

この SHA より古い feature branch の tree が同一でも、**implementation baseline として扱わない**。新規 branch は必ず exact `origin/main` から切る。

## 3.2 現在の milestone 状態

完了済み:

- Phase 0
- Phase 1
- Phase 2
- Phase 3 全体
- Phase 4A 系
- Phase 4B 系
- Phase 4C-0a / 0b
- Phase 4C-1a / 1b
- Phase 4C-2A / 2B
- Phase 4C-3A-1
- Phase 4C-3A-2a
- Phase 4C-3A-2b

次:

- **Phase 4C-3B-1: Provider Diagnostic Sanitization Foundation**

まだ未実装:

- Phase 4C-3B-2: Paid submission certainty + transport hardening
- pricing contract hardening
- Phase 4C-3C: submission persistence / audit / config contract
- Phase 4C-3D: paid-call-capable orchestrator（gate default false）
- Phase 4C-3E: stale SUBMITTING sweeper
- Provider polling execution loop
- provider output ingestion
- scene/output composition
- billing settlement
- final review/publish

## 3.3 直近の検証基準

Phase 4C-3A-2b closure 時点:

```text
pnpm typecheck   -> 0 errors
pnpm lint        -> exit 0
pnpm test        -> 1345 passed / 62 files
pnpm build       -> exit 0
pnpm test:db     -> 213 passed / 9 files
prisma migrate diff -> No difference detected.
```

テスト数は今後増えてよい。減少した場合は理由を確認すること。

---

# 4. 技術スタック

## 4.1 Runtime / language

- Node.js 22+
- TypeScript 5.7.x
- strict typing
- `any` 原則禁止
- ESM
- pnpm 10.x workspace monorepo

## 4.2 Web

- Next.js 15.5.x
- React 19
- Next.js App Router
- Route Handlers under `apps/web/src/app/api`

## 4.3 Database

- PostgreSQL
- Prisma 5.22
- PostgreSQL が system of record
- raw SQL は Prisma が表現できない safety primitive に限定

## 4.4 Storage / media

- Object storage abstraction
- short-lived signed upload/download URL
- Sharp
- MIME sniffing by actual content
- EXIF stripping / orientation normalization
- normalized image + thumbnail
- SHA-256 + perceptual hash
- malware scan hook
- future FFmpeg composition

## 4.5 AI / Provider

- provider abstraction
- initial video provider: WaveSpeedAI
- candidate model: `wavespeed-ai/open-video/image-to-video`
- offline fake provider available
- analysis provider boundary separate from video provider boundary

## 4.6 Testing / Ops

- Vitest
- real PostgreSQL integration tests
- GitHub Actions CI
- OpenTelemetry-oriented observability package
- Playwright は target stack だが E2E 全面実装は後続
- Stripe は target stack / billing phase

---

# 5. 現在のアーキテクチャ

## 5.1 High-level

```text
Browser
  |
  v
Next.js Web / API
  |
  +--> Domain Services
  |      - Identity / RBAC
  |      - Property / Asset
  |      - Analysis / Review
  |      - Storyboard
  |      - Generation admission / preflight contracts
  |
  +--> PostgreSQL via repository ports
  |
  +--> Object Storage
  |
  +--> AI analysis provider
  |
  +--> VideoGenerationProvider abstraction

SceneGeneration row
  == durable queue authority

Future Worker
  -> discover QUEUED rows globally
  -> preflight
  -> claimPreparedForSubmission
  -> audit
  -> WaveSpeed POST
  -> persist provider result
  -> poll
  -> managed storage
```

## 5.2 Modular monolith + independent worker

Web/domain/database は modular monolith。Worker は別 app として独立 scaling 可能だが、現時点では bootstrap only。

## 5.3 Queue architecture — DB row is queue

外部 queue broker は使わない。

```text
SceneGeneration.state = QUEUED
```

これ自体が durable executable work。

Worker は将来 `findNextQueuedForPreparation()` で oldest-first discovery を行う。

`packages/queue` は **reserved boundary / transport intentionally empty**。

Redis/BullMQ、SQS、Azure Service Bus を勝手に追加してはいけない。追加する場合は ADR-0024 を明示的に supersede する必要がある。

---

# 6. ディレクトリ構成

```text
apps/
├── web/
│   ├── src/app/          # UI + Next.js routes
│   └── src/lib/          # route composition / service wiring
└── worker/
    └── src/              # 現在 bootstrap + offline self-check のみ

packages/
├── domain/               # entities, services, RBAC, state machines, ports
├── database/             # Prisma schema/client/repositories/execution repo
├── storage/              # object storage, signed URL, image pipeline
├── queue/                # intentionally empty transport boundary
├── ai-providers/         # AI image-analysis provider boundary
├── video-providers/      # VideoGenerationProvider + fake + WaveSpeed
├── observability/        # structured logging / redaction
└── shared/               # env, errors, money, security helpers

packages/database/prisma/
├── schema.prisma
└── migrations/

tests/
└── integration/          # real PostgreSQL integration tests etc.

docs/
├── ProductRequirements.md
├── SystemArchitecture.md
├── AIVideoPipeline.md
├── WaveSpeedAIIntegration.md
├── DataModel.md
├── API.md
├── UXFlow.md
├── SecurityCompliance.md
├── SaaSOperations.md
├── Roadmap.md
├── progress.md
├── decisions/            # ADRs + TODO
└── phase-*-completion.md
```

---

# 7. 実装済み機能

## 7.1 Identity / tenant

- User registration/login/logout
- password credential
- session
- organization creation
- membership / roles
- tenant-scoped repositories
- audit log foundation
- role vocabulary:
  - OWNER
  - ADMIN
  - CREATOR
  - REVIEWER

## 7.2 Property

- create/list property
- property status
- ownership/rights confirmation flow
- tenant authorization
- logical deletion/deletion intent design

## 7.3 Asset upload pipeline

- upload URL issuance
- upload complete flow
- retry upload
- signed download URL
- tenant-scoped storage
- MIME verification from bytes
- malware scan hook
- QUARANTINED state
- EXIF removal
- orientation normalization
- normalized JPEG
- thumbnail
- SHA-256
- perceptual hash
- duplicate foundation

### MediaAsset lifecycle

```text
PENDING_UPLOAD
UPLOADED
SCANNING
QUARANTINED
PROCESSING
READY
REJECTED
FAILED
DELETION_PENDING
DELETED
```

## 7.4 Deletion intent monotonicity

重要 safety invariant:

通常 lifecycle writer は `deletionRequestedAt` を絶対に消せない。

Ordinary CAS:

```text
id
AND organizationId
AND status = expectedStatus
AND deletionRequestedAt IS NULL
```

Deletion request CAS:

```text
id
AND organizationId
AND deletionRequestedAt IS NULL
AND status <> DELETED
```

write:

```text
status = DELETION_PENDING
deletionRequestedAt = requestedAt
```

`deletionRequestedAt` は削除意図の durable monotonic authority。

## 7.5 AI image analysis

- analysis creation/read/list
- room classification
- confidence/quality/brightness/blur
- duplicate grouping
- detected objects / safety flags
- suggested ordering
- refresh
- retry/failure handling

## 7.6 Human review / correction

- approve
- reject
- room type correction
- ordering correction
- duplicate primary asset handling
- review status
- database uniqueness safety
- review transaction

**Human review は product requirement。省略禁止。**

## 7.7 Storyboard

- VideoProject persistence
- StoryboardScene persistence
- deterministic eligible asset selection
- deterministic ordering
- duration allocation
- prompt compilation
- moderation port
- composition fingerprint
- freshness detection
- compose / recompose
- project creation/list
- storyboard read

## 7.8 Scene generation admission

SceneGeneration を作成する admission domain が実装済み。

Provider call はしない。

Admission 時に:

- authorization
- project / storyboard freshness validation
- provider capability validation
- immutable request snapshot
- frozen rendered prompt
- requestHash computation
- active identity uniqueness
- durable `QUEUED` row creation

### requestHash

8 request facts に基づく application-level immutable request identity。

**provider idempotency token ではない。**

SHA-256 source content hash を requestHash に追加してはいけない。

## 7.9 Execution preflight

`prepareQueuedGeneration` 実装済み、production caller 0。

PreparedGeneration は、Provider POST 前に必要な frozen facts と short-lived signed source URL を持つ。

### PreparedSourceIdentity

```ts
interface PreparedSourceIdentity {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sha256: string;
}
```

- nested in PreparedGeneration
- ephemeral
- not persisted
- signed URL ではない
- assetId を含めない
- organizationId を含めない
- prompt を含めない

Canonical SHA-256 format:

```text
^[0-9a-f]{64}$
```

SHA-256 は collision-resistant content identity evidence として使う。数学的に injective / collision-free と表現しない。

### Preflight source stability

First tenant-scoped read:

- lifecycle classify
- JPEG
- nonblank key
- canonical sha256
- storage.exists
- signed URL mint

Second tenant-scoped read:

- same classifier
- `storageKey`
- `mimeType`
- `sha256`

3 field exact equality が必要。

## 7.10 Locked submission claim

最新の実装済み安全境界。

Public port:

```ts
claimPreparedForSubmission(
  generationId: string,
  sourceIdentity: PreparedSourceIdentity,
): Promise<SubmissionClaimOutcome>
```

旧:

```text
claimQueuedForSubmission(generationId)
```

は削除済み。復活禁止。

Outcome:

```ts
type SubmissionClaimOutcome =
  | { kind: "CLAIMED"; claim: ClaimedSceneGeneration }
  | { kind: "SOURCE_INVALID"; reason: PreflightRefusalReason }
  | { kind: "NOT_CLAIMABLE" };
```

`CLAIMED` の `generation.state` は statically `SUBMITTING`。

### DB transaction order

```text
1. SceneGeneration + VideoProject plain read
2. state != QUEUED -> NOT_CLAIMABLE
3. MediaAsset SELECT ... FOR NO KEY UPDATE
4. generation plain re-read after lock wait
5. state != QUEUED -> NOT_CLAIMABLE
6. canonical source classifier
7. exact sourceIdentity equality
8. CAS QUEUED -> SUBMITTING
9. CAS loss -> NOT_CLAIMABLE
10. authoritative count-1 reread + invariants
11. COMMIT
```

**Serialization barrier:** MediaAsset row lock  
**Licence linearization point:** transaction COMMIT

Lock order:

```text
MediaAsset -> SceneGeneration
```

reverse orderを導入してはいけない。

---

# 8. 未実装機能

以下は production ではまだ存在しないか dormant。

## 8.1 WaveSpeed actual paid submission

- production `createGeneration()` caller: **0**
- worker submission loop: **なし**
- paid generation gate: **なし**
- submission_started audit: **なし**

## 8.2 Provider submission certainty

未実装。

将来 `createGeneration` は、paid POST の side-effect certainty を明示する result union に変更予定。

```text
ACCEPTED
DEFINITIVELY_REJECTED
SUBMISSION_UNKNOWN
```

これは Phase 4C-3B-2。

## 8.3 Worker loop

`apps/worker` は現在 env/provider bootstrap + offline `estimateCost` self-check のみ。

まだ:

- QUEUED discovery loop
- preflight
- claim
- audit
- provider submission
- polling
- output copy

を行わない。

## 8.4 Output pipeline

未実装:

- provider status poller
- provider temporary output fetch
- managed storage copy
- output validation
- FFmpeg scene composition
- final video object
- final human approval
- publish

## 8.5 Billing

未実装:

- Stripe commercial flow
- credit reservation production integration
- exact settlement
- billing API
- verified WaveSpeed pricing contract

## 8.6 Physical retention/deletion worker

未実装。

将来 physical deletion を実装する場合、少なくとも次の generation state が source を必要とする間は削除禁止:

```text
SUBMITTING
PROCESSING
SUBMISSION_UNKNOWN
```

---

# 9. 今後のロードマップ

## Phase 4C-3B-1 — NEXT

**Provider Diagnostic Sanitization Foundation**

実装範囲:

- ProviderError から raw `cause` を除去
- ProviderErrorException から external cause chain を除去
- provider response raw body を diagnostic へ入れない
- safe `providerStatus?: number`
- unsafe duck-typing cast を runtime-safe validation に変更
- Fake provider も固定 safe message にする
- requestHash の「provider idempotency / charge dedup」誤記コメントを修正
- hostile-input tests
- ADR-0031 / completion / TODO / CHANGELOG / progress

3B-1 で **やらない**:

- createGeneration return type change
- redirect change
- timeout change
- certainty union
- paid gate
- audit
- pricing
- env additions

## Phase 4C-3B-2

**Paid Submission Certainty + Transport Hardening**

同一 PR で certainty contract と one-POST transport guarantee を閉じる。

計画:

```text
ProviderSubmissionOutcome:
  ACCEPTED
  DEFINITIVELY_REJECTED
  SUBMISSION_UNKNOWN
```

WaveSpeed paid-create HTTP classification（現在承認済み）:

```text
DEFINITIVELY_REJECTED allowlist:
400
401
403

SUBMISSION_UNKNOWN:
3xx
402
404
405
406
408
409
411
413
414
415
422
429
all 5xx
all unlisted statuses
transport failure
timeout
2xx malformed JSON
2xx without usable prediction id
```

- 429 を自動 retry しない
- 5xx を自動 retry しない
- network/timeout を自動 retry しない
- ambiguous POST は 1 回のみ
- create POST の redirect は `manual`
- GET/cancel の既存 behavior を対称性だけの理由で変えない
- create request-specific timeout は 60,000ms
- GET/cancel default 30,000ms を維持
- env 追加は 3B ではしない

## Pricing prerequisite

Paid gate を有効化する前の hard prerequisite。

現在の `DEFAULT_WAVESPEED_PRICING` は placeholder で一律 price。

2026-08-29 に確認した OpenVideo pricing:

```text
480p  = $0.02 / sec
720p  = $0.04 / sec
1080p = $0.06 / sec
```

したがって resolution-aware verified pricing contract が必要。

`VideoModelPricing.verified: boolean` のようなフラグだけで「verified」に見せる実装は禁止。

## Phase 4C-3C

Submission persistence / audit / config contracts。

重要 future rules:

- system audit actor: `actorUserId = null`
- `generation.submission_started` audit は Provider POST **より前に durable success 必須**
- Provider accepted + predictionId known 後の persistence failure は provider ambiguity ではなく orchestration persistence problem
- known predictionId を失わない設計が必要

## Phase 4C-3D

Paid-call-capable orchestrator。

ただし gate:

```text
WAVESPEED_PAID_GENERATION_ENABLED
```

- booleanish parser 使用
- default false
- missing false
- gate は discovery/preflight **より前**
- disabled 時は signed URL を mint しない
- storage work もしない
- provider construction自体をgateしない（getStatus/recovery のため）

3D でも gate true を real environment へ勝手に設定してはいけない。

## Phase 4C-3E

Stale SUBMITTING sweeper。

```text
stale SUBMITTING -> SUBMISSION_UNKNOWN only
```

絶対に QUEUED へ戻さない。

## Later Phase 4

- PROCESSING poll
- retry-safe GET status
- provider output retrieval
- managed storage copy

## Phase 5

- FFmpeg composition
- final output validation
- AI-generated disclosure
- human review / approval

## Phase 6

- Stripe
- credit reservation
- exact-once settlement
- billing usage

## Phase 7

- production operations
- retention
- webhooks/replay protection
- monitoring
- scaling

## Phase 8

- beta / launch

---

# 10. API仕様

## 10.1 注意: 現在 API と target API は異なる

`docs/API.md` は将来 REST `/api/v1` contract を示す draft だが、現在の Next.js routes は `/api/...` で実装されている。

**Michael は plan document の `/api/v1/generations` が実装済みだと思わないこと。**

## 10.2 現在実装済み Route Handlers

### Health

```text
GET /api/health
GET /api/health/ready
```

`ready` は healthcheck bearer token 必須。

### Authentication

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
```

### Organizations

```text
POST /api/organizations
```

### Properties

```text
GET  /api/properties?organizationId=...
POST /api/properties
```

POST は現在 form-based UI flow を持つ。

### Asset lifecycle

```text
POST /api/properties/{propertyId}/assets/upload-url
POST /api/assets/{assetId}/complete
POST /api/assets/{assetId}/retry
GET  /api/assets/{assetId}/download-url

POST /api/storage/upload
GET  /api/storage/download
```

Storage routes は signed-token mediated internal upload/download endpoint。

### Analysis

```text
GET  /api/properties/{propertyId}/analyses
GET  /api/properties/{propertyId}/assets/{assetId}/analysis
POST /api/properties/{propertyId}/assets/{assetId}/analysis
POST /api/properties/{propertyId}/assets/{assetId}/analysis/approve
POST /api/properties/{propertyId}/assets/{assetId}/analysis/reject
POST /api/properties/{propertyId}/assets/{assetId}/analysis/refresh
[correction route exists] /api/properties/{propertyId}/assets/{assetId}/analysis/correction
```

Correction route は human correction 用。route 実装を source of truth とし、method/payload変更は既存テストと API change docs を確認して行う。

### Video Project / Storyboard

```text
GET  /api/properties/{propertyId}/video-projects?organizationId=...
POST /api/properties/{propertyId}/video-projects

GET  /api/video-projects/{projectId}/storyboard?organizationId=...
POST /api/video-projects/{projectId}/storyboard
```

Storyboard POST body:

```json
{
  "organizationId": "org_...",
  "minSceneSeconds": 3,
  "maxSceneSeconds": 8
}
```

Project creation accepts provider-neutral project settings, including duration/aspect/resolution/prompt/cameraMotion. Provider capability enforcement is generation admission 側。

## 10.3 まだ存在しない HTTP API

以下は target design にはあるが production route 未実装:

```text
POST /video-projects/{projectId}/estimate
POST /video-projects/{projectId}/generations
GET  /generations/{jobId}
POST /generations/{jobId}/cancel
POST /generations/{jobId}/retry

outputs APIs
billing APIs
WaveSpeed provider webhook API
```

これらを「docs/API.md にあるから」という理由だけで勝手に作らない。対応 phase で実装する。

## 10.4 API security convention

- authenticated user
- explicit organization scope
- foreign resource と absent resource を必要に応じて indistinguishable にする
- writes は audit 対象
- stable internal error codes
- provider payload / API key / signed URL を response に出さない

---

# 11. DB設計

System of record: PostgreSQL。

## 11.1 Identity tables

```text
organizations
users
credentials
memberships
invitations
sessions
audit_logs
```

Key rules:

- membership PK = `(organizationId, userId)`
- session/invitation token は raw token ではなく hash
- org/user status を持つ

## 11.2 Property / media

```text
properties
media_assets
asset_analyses
```

MediaAsset key columns:

```text
id
organizationId
propertyId
storageKey        UNIQUE
mimeType
sha256
perceptualHash
status
thumbnailKey
deletionRequestedAt
retentionExpiresAt
```

`@@unique([id, propertyId])` で storyboard scene の cross-property asset relation を DB で防ぐ。

## 11.3 Analysis

`asset_analyses` は 1 asset = 1 analysis row。

主な columns:

```text
provider
status
roomType
confidence
qualityScore
brightnessScore
blurScore
duplicateGroup
detectedObjects JSON
safetyFlags JSON
suggestedOrder
roomTypeOverride
orderOverride
analysisRevision
reviewStatus
reviewNote
reviewedBy
reviewedAt
```

Partial unique index など Prisma が表現できない constraint は migration raw SQL で管理。

## 11.4 VideoProject

```text
video_projects
```

Provider-neutral settings:

```text
durationSeconds
aspectRatio
resolution
stylePreset
cameraMotion
prompt
negativePrompt
includeMusic
includeCaptions
compositionFingerprint
```

status:

```text
DRAFT
STORYBOARD_READY
STORYBOARD_STALE
```

## 11.5 StoryboardScene

```text
storyboard_scenes
```

```text
videoProjectId
propertyId
assetId
position
roomType
durationSeconds
cameraMotion
compiledPrompt
sourceAnalysisRevision
```

Composite FK により project/asset の property 一致を強制。

## 11.6 SceneGeneration

最重要 execution table。

```text
scene_generations
```

主な columns:

```text
id
videoProjectId
sourceStoryboardSceneId   # provenance, no FK
assetId                   # provenance, no FK
sourceAnalysisRevision
requestHash
providerName
providerModelId
requestCompiledPrompt
requestDurationSeconds
requestCameraMotion
requestAspectRatio
requestResolution
requestRenderedPrompt
state
providerPredictionId
submittedAt
lastPolledAt
normalizedErrorCode
normalizedErrorMessage
outputStorageKey
createdAt
updatedAt
```

`sourceStoryboardSceneId` と `assetId` に FK を張らないのは意図的。storyboard recomposition / asset retention で paid-call history を cascade delete させないため。

VideoProject FK は `onDelete: Restrict`。

## 11.7 SceneGeneration state machine

```text
QUEUED
SUBMITTING
PROCESSING
SUCCEEDED
FAILED_RETRYABLE
FAILED_TERMINAL
SUBMISSION_UNKNOWN
CANCELLED
```

Legal transitions:

```text
QUEUED
  -> SUBMITTING
  -> CANCELLED
  -> FAILED_RETRYABLE
  -> FAILED_TERMINAL

SUBMITTING
  -> PROCESSING
  -> FAILED_RETRYABLE
  -> FAILED_TERMINAL
  -> SUBMISSION_UNKNOWN

PROCESSING
  -> SUCCEEDED
  -> FAILED_RETRYABLE
  -> FAILED_TERMINAL

FAILED_RETRYABLE
  -> QUEUED

SUBMISSION_UNKNOWN
  -> no automatic exit

SUCCEEDED / FAILED_TERMINAL / CANCELLED
  -> terminal
```

`FAILED_RETRYABLE -> QUEUED` は legal だが、**自動 actor は現在存在しない**。

## 11.8 Active generation identity

Partial unique index が active states の同一 `(videoProjectId, requestHash)` 重複を防ぐ。

Active:

```text
QUEUED
SUBMITTING
PROCESSING
FAILED_RETRYABLE
SUBMISSION_UNKNOWN
```

Terminal:

```text
SUCCEEDED
FAILED_TERMINAL
CANCELLED
```

**FAILED_RETRYABLE と SUBMISSION_UNKNOWN が active であることは二重課金防止上 load-bearing。**

---

# 12. AI Provider設計

## 12.1 原則

Provider SDK / HTTP implementation を UI や domain から直接呼ばない。

```text
UI / Domain
  -> provider-neutral port
    -> adapter
      -> external provider
```

## 12.2 AI analysis provider

画像分析は video provider と別 boundary。

目的:

- room type
- quality
- blur/brightness
- duplicate
- safety findings
- ordering hints

Human review の判断を上書きしてはいけない。

## 12.3 VideoGenerationProvider

現在の interface 概要:

```ts
interface VideoGenerationProvider {
  readonly name: ProviderName;
  createGeneration(input: ProviderGenerationInput): Promise<ProviderGenerationRef>;
  getStatus(ref: ProviderGenerationRef): Promise<ProviderGenerationStatus>;
  cancelGeneration(ref: ProviderGenerationRef): Promise<void>;
  estimateCost(input: ProviderGenerationInput): Promise<Money>;
  normalizeError(error: unknown): ProviderError;
}
```

**createGeneration の return contract はまだ旧式。3B-2 で変更予定。**

## 12.4 WaveSpeed request

Current create payload:

```json
{
  "image": "<short-lived signed source URL>",
  "prompt": "<frozen rendered prompt>",
  "duration": 5,
  "resolution": "720p",
  "seed": 123
}
```

`seed` は optional。

現在送らない:

- `aspect_ratio`
- `negative_prompt`
- `camera_motion`
- `preset`

`preset` は official docs で optional だが、送らなくてもよい。勝手に追加しない。

Provider URL は frozen `input.modelId` から構築する。

## 12.5 Provider diagnostics — current known defects

**この section が次の実装対象。**

現行 baseline には以下の defect が残っている:

1. unexpected HTTP status の error message に provider response body の先頭を入れる。
2. network ProviderError が raw `cause` を保持する。
3. Fake provider が `Error.message` を sanitized message にコピーする。
4. arbitrary object を弱い duck typing で ProviderError として cast できる。

3B-1 で修正する。

## 12.6 Future provider submission certainty

3B-2 で `createGeneration` を result union 化する。

```text
ACCEPTED
DEFINITIVELY_REJECTED
SUBMISSION_UNKNOWN
```

Meaning:

### ACCEPTED

- usable prediction id known
- later `getStatus` recovery possible

### DEFINITIVELY_REJECTED

- positive evidence provider did not accept the create request
- retry policy は別 axis

### SUBMISSION_UNKNOWN

- provider が受理/課金した可能性を否定できない
- automatic re-POST prohibited

---

# 13. Worker / Queue設計

## 13.1 Current worker

現状 `apps/worker` は:

- load env
- construct video provider
- offline `estimateCost` self-check
- log ready

のみ。

**Provider POST はしない。**

## 13.2 Future worker algorithm

概念的 future loop:

```text
if paid gate disabled:
  do nothing

candidate = findNextQueuedForPreparation()
if none:
  wait

prepared = prepareQueuedGeneration(candidate)
if refused:
  failQueuedPreflight(...)
  continue

claim = claimPreparedForSubmission(id, prepared.sourceIdentity)

if NOT_CLAIMABLE:
  stop this item

if SOURCE_INVALID:
  discard prepared
  failQueuedPreflight(id, reason) CAS
  stop

if CLAIMED:
  durable submission_started audit
  provider create POST exactly once
  persist outcome
```

ただしこの loop 自体は未実装。

## 13.3 Queue authority

Queue transport は DB row。

Discovery は read-only/non-exclusive。

Two workers が同じ QUEUED row を prepare してもよい。exclusive ownership は claim transaction で決まる。

## 13.4 Claim safety

`SOURCE_INVALID` は SceneGeneration row を変更しない。

`NOT_CLAIMABLE` は source verdict を意味しない。

`CLAIMED` だけが Provider POST に進める。

---

# 14. セキュリティ要件

## 14.1 Tenant isolation

- tenant-facing repository は原則 `organizationId` 必須
- system execution repository だけ system-scoped trusted boundary
- worker が tenant を caller input から受け取らない
- SceneGeneration -> VideoProject から authoritative organization を resolve
- foreign resource は absent と indistinguishable にする箇所を維持

## 14.2 Secret handling

絶対に log / persist / client expose しない:

- `WAVESPEED_API_KEY`
- Authorization header
- signed upload URL
- signed source download URL
- prompt raw text（customer authored）
- arbitrary provider response body
- raw network Error cause
- provider temporary output URL（durable DB には保存しない）

## 14.3 Media security

- MIME を filename/Content-Type だけで信じない
- content sniffing
- malware scanning
- quarantine
- EXIF stripping
- orientation correction
- normalized derivative
- short-lived signed URL

## 14.4 Provider response safety

3B-1 completion 後の desired ProviderError:

```ts
interface ProviderError {
  kind: ProviderErrorKind;
  retryable: boolean;
  code: string;
  messageSanitized: string;
  providerStatus?: number;
}
```

禁止:

```text
cause
rawBody
response
request
headers
URL
prompt
API key
arbitrary metadata/details
```

## 14.5 Audit

対象:

- upload
- deletion request
- analysis review
- generation admission
- future submission
- approval
- download
- billing
- admin action

Future system submission actor:

```text
actorUserId = null
```

`generation.submission_started` は Provider POST より前に durable success が必要。

---

# 15. 冪等性・二重課金防止

この製品の最重要 cross-cutting concern。

## 15.1 requestHash

- application-local request identity
- immutable generation facts を hash
- active generation partial unique index に使用
- Provider idempotency header ではない

`Idempotency-Key: requestHash` を勝手に送らない。

WaveSpeed create endpoint の公式 idempotency-key support は未証明。

## 15.2 Active identity prevents duplicate attempt

同じ project/requestHash について active row を複数作らない。

`FAILED_RETRYABLE` が identity を保持するのは future explicit requeue があり得るため。

`SUBMISSION_UNKNOWN` が identity を保持するのは provider がすでに課金している可能性があるため。

## 15.3 Provider POST retry rule

Future hard rule:

**paid create POST に automatic retry を入れない。**

以下は原則 SUBMISSION_UNKNOWN:

- timeout
- disconnect
- connection reset
- fetch rejection
- AbortError
- malformed 2xx
- 2xx without usable prediction id
- 429
- 5xx
- unproven HTTP status

## 15.4 Definitive rejection allowlist

3B-2 の CTO-approved allowlist:

```text
400
401
403
```

のみ。

HTTP class 一般論で 4xx を全部 definitive にしてはいけない。

## 15.5 Redirect

Current fetch default は `follow`。

3B-2 で paid create POST のみ `redirect: manual` にする。

理由: 307/308 による request body 自動再送を防ぐ。

## 15.6 Audit-before-POST

Provider POST の前に durable audit を成功させる。

Audit failure のとき Provider を呼ばない。

## 15.7 Pricing correctness

二重課金だけでなく誤課金も禁止。

Paid gate enable 前に resolution-aware verified pricing が必要。

---

# 16. 開発ルール

## 16.1 Source-of-truth priority

原則:

```text
explicit owner / CTO instruction
> security/compliance
> ProductRequirements
> current accepted ADR
> WaveSpeed integration contract
> architecture/API docs
> existing implementation
```

ただし docs が stale の場合は、**merged source + later ADR/completion report** を優先して現状を確定する。

不明な business rule を invent しない。

Unresolved item は:

```text
docs/decisions/TODO.md
```

へ記録する。

## 16.2 Implementation workflow

```text
Inspect
-> gap/design report
-> CTO approval
-> create fresh branch from exact origin/main
-> implement smallest coherent milestone
-> mutations / discriminating tests
-> full gates
-> docs
-> commits
-> push
-> PR
-> exact-head CI
-> review findings
-> CTO merge approval
-> true merge commit
-> merge-commit CI
-> local annotated completion tag
-> STOP
```

## 16.3 PR size

General target は ~500 LOC だが、safety-heavy milestone は事前 CTO waiver が存在する。

重要:

- size overrun を実装後に隠さない
- tests/docs を LOC 合わせのため消さない
- concurrency primitive とその safety evidence を別 PR に切り離さない

## 16.4 Mandatory checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:db
# Prisma migration parity / migrate diff
```

Migration parity:

```text
No difference detected.
```

が原則必要。

## 16.5 Mutation testing style

重要 invariant には temporary mutation を入れ、test が本当に load-bearing であることを確認する。

Mutation code は commit しない。

Restore は byte-identical を確認する。

Compile-only mutation と runtime mutation を混同しない。

---

# 17. Git運用ルール

## 17.1 Branch

- 新規 milestone branch は exact `origin/main` から作る
- tree が同じだから古い parent から branch してよい、とはしない
- main が advance していたら勝手に rebase せず STOP / report

## 17.2 PR

- 1 milestone = 1 PR 原則
- unrelated refactor 禁止
- PR open 後は merge approval まで merge しない
- review thread を substantive finding が残った状態で resolve しない
- exact-head CI を evidence にする

## 17.3 Merge

直近 Phase 4 milestones は **true merge commit** で閉じる governance。

禁止:

- squash
- rebase merge
- cherry-pick merge
- manual fast-forward

Merge commit は expected base/head の exactly two parents を確認。

## 17.4 Merge後

- new `push` CI on exact merge SHA を待つ
- verify + database 両方 green
- post-merge docs commit を作らない

## 17.5 Tags

Milestone completion 後:

```text
annotated local tag
```

例:

```text
phase-4c3a2b-complete
```

Known environment limitation:

- branch push: success
- tag push: HTTP 403

したがって completion tags は **local-only unless verified**。

勝手に tag push を再試行しない。

remote tag が存在すると主張しない。

---

# 18. エージェントが勝手に変更してはいけない仕様

以下は frozen / load-bearing。Michael または他 agent が「簡単にできるから」という理由で変更してはいけない。

## 18.1 Queue

**External broker を追加しない。**

DB `SceneGeneration` row が queue authority。

## 18.2 State machine

特に禁止:

- `SUBMISSION_UNKNOWN -> QUEUED`
- stale `SUBMITTING -> QUEUED`
- `PROCESSING -> QUEUED` の自動 retry shortcut

Stale SUBMITTING future rule:

```text
SUBMITTING -> SUBMISSION_UNKNOWN
```

## 18.3 SUBMISSION_UNKNOWN

自動 exit を追加しない。

Human/manual recovery が前提。

## 18.4 FAILED_RETRYABLE

`FAILED_RETRYABLE -> QUEUED` は legal だが actor は現在ない。

勝手に timer/retry loop を作らない。

Future requeue は expected-state CAS 必須。

## 18.5 requestHash

- source SHA を追加しない
- provider idempotency token とみなさない
- field ordering / facts を無断変更しない

## 18.6 PreparedSourceIdentity

Exact shape:

```text
storageKey
mimeType
sha256
```

追加禁止:

- assetId
- organizationId
- URL
- expiry
- prompt
- provider credential

## 18.7 Claim API

保持:

```ts
claimPreparedForSubmission(generationId, sourceIdentity)
```

旧 one-argument claim を復活させない。

## 18.8 Asset lock

Lock mode:

```sql
FOR NO KEY UPDATE
```

`FOR UPDATE` へ理由なく強化しない。

Lock ordering:

```text
MediaAsset -> SceneGeneration
```

## 18.9 Licence point

`SUBMITTING` licence の linearization は transaction **COMMIT**。

Lock acquisition / uncommitted UPDATE を licence とみなさない。

## 18.10 Source byte stability

現在「READY asset は同じ identity で再 processing しない」production lifecycle に依存している。

将来以下を追加する場合は paid submission safety を再レビュー:

- READY -> reupload
- READY -> reprocess
- same normalized key overwrite
- in-place photo replacement

必要なら versioned/content-addressed key 等を先に設計する。

## 18.11 Provider POST retry

Ambiguous paid submission を automatic re-POST しない。

429/5xx だから retry、という generic retry middleware を導入しない。

## 18.12 Provider diagnostics

Provider raw body / raw network error を safe error として残さない。

次 milestone でこの defect を閉じる。

## 18.13 WaveSpeed fields

勝手に追加しない:

- `preset`
- undocumented `aspect_ratio`
- `camera_motion`
- `negative_prompt`

Current model contract と ADR を確認する。

## 18.14 Paid gate

まだ追加しない。

Future exact name:

```text
WAVESPEED_PAID_GENERATION_ENABLED
```

booleanish parser、default false。

Gate false 時は preflight 前に stop。

## 18.15 Pricing

placeholder pricing を本番料金として扱わない。

Paid gate enable 前に resolution-aware verified pricing が必須。

## 18.16 Human review

AI output の自動 publish を追加しない。

---

# 19. 次に実装すべきタスク

## Phase 4C-3B-1 — Provider Diagnostic Sanitization Foundation

### Goal

Provider 由来の arbitrary text / Error を「safe internal diagnostic」として保持しない。

### Baseline

```text
2dddb3beb391667f6f400e5a20a7a5793a11eef1
```

### Expected production files

主に:

```text
packages/video-providers/src/types.ts
packages/video-providers/src/errors.ts
packages/video-providers/src/fake/fake-provider.ts
packages/video-providers/src/wavespeed/mapping.ts
packages/video-providers/src/wavespeed/wavespeed-provider.ts
```

**変更してはいけない:** `wavespeed/http.ts` redirect/timeout semantics は 3B-2。

### Required changes

#### A. ProviderError safe shape

Keep:

```text
kind
retryable
code
messageSanitized
```

Add at most:

```text
providerStatus?: number
```

Remove:

```text
cause
```

#### B. ProviderErrorException

External raw cause を Error cause chain に付けない。

#### C. HTTP body

現行 unexpected status:

```text
messageSanitized = raw body summary included
```

を廃止。

`normalizeHttpStatusError(status)` の fixed app-owned text にする。

`providerStatus = status` は許可。

#### D. Network

Generic Error:

```text
NETWORK / WAVESPEED_NETWORK_ERROR / fixed message
```

AbortError:

```text
TIMEOUT / WAVESPEED_TIMEOUT / fixed message
```

raw message / stack / cause を残さない。

#### E. Runtime ProviderError validation

現在の弱い:

```text
"kind" in error && "retryable" in error
```

だけの cast を廃止。

Required fields 全てを runtime validate。

#### F. Fake provider

`error.message` passthrough をやめる。

固定:

```text
FAKE_PROVIDER_ERROR
"Fake provider error"
```

#### G. requestHash comment

「provider-charge dedup / idempotency」と読めるコメントを修正。

requestHash は:

```text
stable internal request identity
```

Provider `Idempotency-Key` ではない。

### Required tests

Hostile values を使う:

```text
signed URL-like value
fake API key
customer prompt
provider raw error text
newline/control text
```

Assert:

```text
JSON.stringify(providerError)
String(ProviderErrorException)
```

のどちらにも sentinel が出ない。

Status representative:

```text
400
401
403
422
429
500
418
```

**3B-1 では existing retry semantics を変えない。**

3B-2 で certainty model と一緒に変更する。

### Mutation ledger requirement

最低:

```text
M1 raw body restore -> fail
M2 raw cause restore -> fail
M3 Error({cause}) restore -> fail
M4 fake error.message passthrough -> fail
M5 weak duck cast restore -> fail
M6 providerStatus omitted -> fail
M7 provider body in code -> fail
```

### Documentation

Create:

```text
docs/decisions/0031-provider-diagnostic-sanitization.md
docs/phase-4c3b1-completion.md
```

Update:

```text
docs/decisions/TODO.md
CHANGELOG.md
docs/progress.md
```

### Reviewability

```text
target <= 800 changed lines
hard stop > 950
```

950 超過時は PR を開く前に STOP/report。

### Explicitly deferred to 3B-2

```text
ProviderSubmissionOutcome
certainty HTTP mapping
redirect manual
submission timeout 60s
exactly-one-POST evidence
fake submission outcome configuration
env timeout variables
```

---

# 20. Michael の再開チェックリスト

最初にこの順序で行う。

```text
1. git fetch origin
2. git checkout main
3. git pull --ff-only
4. git rev-parse HEAD
   -> 2dddb3beb391667f6f400e5a20a7a5793a11eef1 expected
5. git status --short
   -> clean expected
6. read CLAUDE.md
7. read docs/decisions/0029, 0030 and current TODO
8. inspect packages/video-providers
9. confirm createGeneration production callers == 0
10. create fresh 3B-1 branch
11. implement sanitization only
12. run full gates
13. mutation evidence
14. docs
15. push + PR
16. STOP for review
```

もし `origin/main` が `2dddb3b...` より進んでいる場合:

**この spec の baseline を盲目的に checkout しない。**

新しい main の diff / milestone completion を確認し、本書との差分を把握してから再開する。

---

# 21. Handover summary

Michael が最初に覚えるべきことを 10 行にまとめる。

1. これは commercial multi-tenant real-estate AI video SaaS。
2. Phase 0–3 は完成。Phase 4 execution safety を構築中。
3. actual WaveSpeed paid POST はまだ production から一度も呼ばない設計。
4. durable queue は `SceneGeneration` DB row。broker はない。
5. `requestHash` + active partial unique index で duplicate local attempt を防ぐ。
6. Provider POST ライセンスは `claimPreparedForSubmission` transaction COMMIT でのみ成立。
7. source は `storageKey + mimeType + sha256` を asset row lock 下で再検証する。
8. ambiguous submission は `SUBMISSION_UNKNOWN` に止め、再 POST しない。
9. 次は provider raw body/raw cause を安全に除去する 3B-1。
10. 3B-1 が merge するまで 3B-2、paid gate、audit、worker POST を始めない。

---

## Reference documents in repository

実装再開時は少なくとも以下を参照する。

```text
CLAUDE.md
README.md
docs/ProductRequirements.md
docs/SystemArchitecture.md
docs/AIVideoPipeline.md
docs/WaveSpeedAIIntegration.md
docs/DataModel.md
docs/API.md
docs/SecurityCompliance.md
docs/SaaSOperations.md
docs/Roadmap.md
docs/progress.md
docs/decisions/TODO.md
docs/decisions/0029-*.md
docs/decisions/0030-*.md
packages/database/prisma/schema.prisma
packages/domain/src/generation/state-machine.ts
packages/domain/src/generation/execution-ports.ts
packages/video-providers/src/*
```

---

**End of handover specification.**
