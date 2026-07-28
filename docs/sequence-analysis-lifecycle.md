# Analysis Lifecycle — Sequence Diagram

Version: 1.1
Status: describes **implemented** behaviour through Phase 3A-2b. The contract
and provider layer shipped in 3A-1, persistence in 3A-2a, and the orchestrating
`AnalysisService` in 3A-2b. Steps marked **3A-2c** (refresh, duplicate grouping,
suggested order) and **3B** (review UI) are labelled so the diagram is not read
as describing more than currently ships.

## Analysis of one asset

```mermaid
sequenceDiagram
  autonumber
  actor U as Creator
  participant AS as AnalysisService<br/>(3A-2b)
  participant AZ as authorizeOrganization
  participant AR as MediaAsset repository
  participant NR as AssetAnalysis repository<br/>(3A-2a)
  participant S as ObjectStorage
  participant P as ImageAnalysisProvider<br/>(3A-1, deterministic offline)
  participant N as Normalization + rules<br/>(3A-1)
  participant AL as AuditLog

  U->>AS: analyzeAsset(org, assetId)
  AS->>AZ: require membership + property:write
  AZ-->>AS: AuthContext (else FORBIDDEN)
  AS->>AR: findById(org, assetId)
  Note over AS,AR: Only READY assets are eligible;<br/>anything else → VALIDATION_FAILED,<br/>missing/DELETED → NOT_FOUND
  AS->>NR: findByAssetId(org, assetId)

  alt SUCCEEDED record exists
    NR-->>AS: existing record
    AS-->>U: existing record (idempotent — provider NOT called)
  else no record, or PENDING/FAILED record
    AS->>NR: create, or reset an existing row, as PENDING
    Note over AS,NR: Reserved before the provider call, so a crash<br/>leaves a visible PENDING row. If a concurrent<br/>insert wins the unique index on assetId, this<br/>request adopts that row instead of creating<br/>a second one.
    AS->>AL: analysis.requested
    AS->>S: getObject(asset.storageKey)

    alt bytes missing
      AS->>NR: status = FAILED (sanitized reason)
      AS->>AL: analysis.failed
      AS-->>U: FAILED record
    else bytes available
      AS->>P: analyze({assetId, bytes, mime, w, h, perceptualHash})

      alt provider throws
        P-->>AS: throws
        AS->>P: normalizeError(error)
        AS->>NR: status = FAILED (messageSanitized)
        AS->>AL: analysis.failed
        AS-->>U: FAILED record
      else provider returns
        P->>N: normalizeAnalysisResult(raw)
        Note over N: unknown room → OTHER/0 confidence;<br/>scores clamped 0..1; non-finite → 0;<br/>objects ≤50, flags ≤20
        N-->>AS: AnalysisResult
        AS->>N: deriveQualityFlags(w, h, blur, brightness)
        N-->>AS: LOW_RESOLUTION / BLURRY / EXPOSURE_PROBLEM warnings
        AS->>AS: merge flags, keeping the most severe per code
        AS->>NR: status = SUCCEEDED (+ scores, flags)
        Note over AS,AL: The row is persisted before its audit entry, so an<br/>audit-sink failure surfaces as an error over a<br/>consistent terminal row — never silently.
        AS->>AL: analysis.succeeded
        Note over AS,N: Duplicate grouping (resolveDuplicateGroup) and<br/>suggestedOrder (roomOrderRank) are 3A-2c.
        AS-->>U: SUCCEEDED record
      end
    end
  end
```

## Status machine

```mermaid
stateDiagram-v2
  [*] --> PENDING : analyzeAsset reserves the record
  PENDING --> SUCCEEDED : provider returned, result normalized
  PENDING --> FAILED : bytes unreadable or provider error
  FAILED --> PENDING : analyzeAsset retried
  PENDING --> PENDING : retried after a failed terminal write
  SUCCEEDED --> [*]
```

## What is implemented, by milestone

| Element | Milestone |
| --- | --- |
| `ImageAnalysisProvider` interface and normalized request/result types | 3A-1 |
| `normalizeAnalysisResult`, `deriveQualityFlags`, `analysisProviderError` | 3A-1 |
| `roomOrderRank`, `resolveDuplicateGroup` (defined; wired in 3A-2c) | 3A-1 |
| `DeterministicImageAnalysisProvider` (offline, no network I/O) | 3A-1 |
| `ANALYSIS_PROVIDER` selection with fail-fast on anything else | 3A-1 |
| Audit action vocabulary (`analysis.requested` etc.) | 3A-1 |
| `AssetAnalysis` table, migration, tenant-scoped repository | 3A-2a |
| `AnalysisService` orchestration, authorization, idempotency, READY-only check | 3A-2b |
| Audit **emission** | 3A-2b |
| Transaction/retry safety: PENDING reservation, no completed row on provider failure, persist-before-audit, unique-index concurrency reconciliation | 3A-2b |
| `refresh` re-run, duplicate grouping, `suggestedOrder`, read APIs | ⏭ 3A-2c |
| Analysis HTTP endpoints | ⏭ 3A-3 |
| Review UI, storyboard, prompt compilation | ⏭ 3B / 3C |

## Low confidence and blocking findings

`isLowConfidence` (≤ 0.6, or null) and `hasBlockingFlag` are available from
3A-1, and `AnalysisService` *records* the signals it computes. Nothing enforces
them yet.
Enforcement (a low-confidence classification cannot silently proceed, and
blocking findings must be resolved) is delivered with the review UI in Phase 3B.
