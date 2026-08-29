# Source of Truth 監査結果

- 作成: Product Manager / Product Owner Agent
- 対象タスク: T-008（再ディスパッチ版・範囲縮小）
- 日付: 2026-08-29
- 状態: **草案 / 未承認**。本書は監査結果の報告であり、仕様の確定ではない。
- Git 操作は行っていない。本書はエージェント作業ディレクトリ配下の草案である。

---

## 0. 監査範囲と方法

読み比べた文書（すべて読み取り専用でアクセスした）:

| # | 文書 | 規模 | 位置づけ（現状の実態） |
|---|---|---|---|
| 1 | `PRODUCT_SPEC.md` | 2156 行 / 21 章 | 実態は**技術ハンドオーバ仕様**。凍結仕様（18章）・実装状況・次フェーズを含む |
| 2 | `CLAUDE.md` | 約 220 行 | AI 開発実装ガイド。優先順位・規約・フェーズ運用 |
| 3 | `docs/ProductRequirements.md` | 75 行 | 顧客向け製品要件（枚数・尺・比率・ロール・KPI） |
| 4 | `docs/SystemArchitecture.md` | 92 行 | アーキテクチャ、ADR-0024、provider 境界 |
| 5 | `docs/AIVideoPipeline.md` | 85 行 | 生成パイプライン |
| 6 | `docs/WaveSpeedAIIntegration.md` | 101 行 | provider 契約 |
| 7 | `docs/DataModel.md` | 91 行 | データモデル（**目標形。実装と乖離あり**） |
| 8 | `docs/API.md` | 132 行 | API 設計（**目標形 `/api/v1`**） |
| 9 | `docs/UXFlow.md` | 276 行 | 画面フロー |
| 10 | `docs/SecurityCompliance.md` | 98 行 | セキュリティ / コンプライアンス |
| 11 | `docs/SaaSOperations.md` | 125 行 | SaaS 運用 |
| 12 | `docs/Roadmap.md` | 151 行 | Phase 0–8 のロードマップ（粗い粒度） |
| 13 | `docs/decisions/TODO.md` | 606 行 / 16 節 | 未決事項の集積 |
| 14 | `hive/ORG.md` | 139 行 | 組織憲章（god 所管） |

### 分類定義（本タスクの指示に従う）

| 分類 | 意味 | 誰が解決するか |
|---|---|---|
| **A** | **製品挙動が変わる重大矛盾** | **人間（CTO）判断が必須。PM は列挙のみ行い、決定しない** |
| **B** | 文書間の記述ズレ | PM 判断で統一可（ただし他エージェント所管ファイルは提案に留める） |
| **C** | 軽微な表記ゆれ | 実務担当が随時修正 |

**件数: A = 12 件 / B = 11 件 / C = 6 件。**

> **A 分類のうち A-09 のみ、本監査の途中で Orchestrator によって決着済みとなった**（HOLD は解除されない。§1 参照）。したがって列挙は 12 件、うち**人間判断がなお必要なものは 11 件**である。

> **注記（分類規約の変更）**: 本タスクの初回ディスパッチでは A と C の意味が逆（A=体裁のみ／C=人間判断）であった。Orchestrator の指示により、上表の規約（**A=重大・人間判断**）に統一している。以後の報告はすべてこの規約に従う。

---

## 1. A 分類 — 製品挙動が変わる重大矛盾（人間判断が必要・PM は決定しない）

各項目の「どちらを選ぶと製品挙動がどう変わるか」を 1 行で記す。

| ID | 項目 | 出典 | 矛盾の中身 | どちらを選ぶと何が変わるか | 推奨対応 |
|---|---|---|---|---|---|
| **A-01** | `PRODUCT_SPEC.md` の役割定義 | `PRODUCT_SPEC.md` 全体 / 本タスクの SoT 分類指示 | 与えられた分類では「製品ビジョン・事業要件・高レベル製品方針」だが、実体は凍結技術仕様・実装状況・次フェーズ手順を含む技術ハンドオーバ文書 | 分割すれば製品判断とエンジニアリング判断の SoT が分離し、以後の仕様追加先が変わる。現状追認なら PM の担当範囲は「事業要件」ではなく「技術仕様の維持」になる | 人間が「分割する／現状を追認して名称と役割定義の方を改める」を決定 |
| **A-02** | クレジット価格モデルとプラットフォームマージン | `docs/decisions/TODO.md` L590「Business rules to confirm」 | 未決。Phase 6 送り | 単価とマージンで、1 本あたり消費クレジット・見積表示・与信予約量・請求額がすべて変わる | 人間が価格方針を決定するまで Phase 6 着手不可 |
| **A-03** | プラン定義 | `docs/decisions/TODO.md` L590 台 / `docs/SaaSOperations.md` | ユーザー数・容量・月次クレジット・同時実行数・保持期間・ブランディング・サポート階層がいずれも未定 | 同時実行上限は worker 設計とプロバイダ並列度に、保持期間はストレージ課金と削除ジョブに直結する | 人間がプラン表を決定 |
| **A-04** | 顧客向け生成パラメータと実プロバイダ能力の未照合 | `docs/ProductRequirements.md` L32（尺 10–90 秒）、同 アスペクト比 16:9 / 9:16 / 1:1、解像度 720p / 1080p / `docs/decisions/TODO.md`（WaveSpeedAI 実能力が未検証） | 顧客に約束している範囲がプロバイダの実際の対応範囲で満たせるか未確認 | 実能力が下回れば、公開済みの選択肢を削るか複数生成の連結で実現するかで、原価・生成時間・失敗率が変わる | Research & Integration が実能力を確定 → 人間が顧客向け範囲を決定 |
| **A-05** | AI 生成表示の正確な文言と表示位置 | `docs/SecurityCompliance.md`（既定ラベル `AI生成イメージ`）/ `docs/decisions/TODO.md` | 既定文字列以外（動画内焼き込みの有無、位置、多言語、書き出し後も残るか）が未決 | 焼き込み必須にすると出力合成と再生成コストが変わる。任意にすると景表法・広告表示上のリスク配分が変わる | **Legal / Compliance の確認を経て人間が決定**（本件は法規制領域） |
| **A-06** | アセットと出力の保持期間・削除後の復旧猶予 | `docs/decisions/TODO.md` / `docs/SaaSOperations.md` | 未決 | 保持期間はストレージ原価・GDPR 等の削除義務対応・顧客の再ダウンロード可能期間を同時に決める | 人間が決定（Legal 確認推奨） |
| **A-07** | 写真枚数ルールの所在 | `docs/ProductRequirements.md` L20「Upload 3–20 interior photos」/ `PRODUCT_SPEC.md`（該当規定なし） | 顧客向けの中核制約が製品仕様側に不在 | 上限 20 枚を変えるとシーン数・生成コスト・尺の実現可能範囲が変わる。どの文書が正かを決めないと実装が別の値を採り得る | 人間が正の値を確定し、`PRODUCT_SPEC.md` へ反映（PM は書き換えない） |
| **A-08** | WaveSpeedAI の商用利用規約・データ取り扱い・学習利用ポリシー | `docs/decisions/TODO.md` L5 台「WaveSpeedAI」節 / `CLAUDE.md`「Verify current API contract and commercial-use terms before production release」 | 未検証。本番リリース前の必須確認事項として明記されているのみ | 商用不可・顧客画像の学習利用ありなら、プロバイダ差し替えか顧客への開示追加が必要になり、リリース可否そのものが変わる | Research & Integration が調査 → **Legal 確認 → 人間が最終判断**。本番前の必須ゲート |
| **A-09** ✅ | `hive/ORG.md` 第 7 節「全作業停止中」の効力 | `hive/ORG.md` L78「## 7. 現在のフェーズ = 組織構築フェーズ (全作業停止中)」 | T-002 / T-004 / T-005 / T-006 が blocked、T-004 は人間回答が HOLD。一方で現在タスクがディスパッチされ稼働している | **決着済み（本監査中に Orchestrator がサインオフ）**。HOLD は解除されない。人間の一括実行指示にある「この準備作業以外の製品開発を開始しない」が根拠であり、T-002 / T-004 / T-005 / T-006 は Phase 4C-3B-1 の製品開発として範囲外。準備作業（本監査等）の稼働はこれと矛盾しない | **人間判断は不要**。`hive/ORG.md` に「HOLD は人間の明示的な解除指示があるまで継続する」旨を明記（ORG.md は god 所管のため PM は編集しない） |
| **A-10** | 顧客アセットのモデル学習オプトイン提供可否 | `docs/SecurityCompliance.md` / `docs/decisions/TODO.md` | 未決 | 提供するなら同意 UI・監査記録・撤回フローが必要になり、DPA とプライバシーポリシーの記載が変わる | 人間が方針決定（Legal 確認必須） |
| **A-11** | 対応認証プロバイダ | `docs/decisions/TODO.md`（supported auth providers 未決） | メールのみか、Entra ID / Google 等の IdP を含むか未定 | エンタープライズ SSO の要否で、組織招待フロー・ロール割当・監査ログの設計が変わる | 人間が対象顧客セグメントとあわせて決定 |
| **A-12** | サポート / SLA 階層と可用性コミット | `docs/SaaSOperations.md`（API 可用性 99.9% は **将来目標**と明記）/ `docs/decisions/TODO.md` | 目標値であって契約可能なコミットかが未定 | 99.9% を対外コミットすると冗長構成・オンコール・クレジット返還条項が必要になり、原価と契約書が変わる | 人間が決定（Sales の提示条件に直結。Legal 確認推奨） |

> **PM としての立場**: A-01〜A-12 はいずれも本監査では**解決しない**。上記は検出と影響記述のみである。

---

## 2. B 分類 — 文書間の記述ズレ（PM 判断で統一可）

| ID | 項目 | 出典 | ズレの中身 | 推奨対応 |
|---|---|---|---|---|
| **B-01** | Source of Truth 優先順位の不一致 | `CLAUDE.md` L24 / `PRODUCT_SPEC.md` L1556（16.1） | `CLAUDE.md` は `explicit user instruction > security/compliance > product requirements > WaveSpeedAI integration > architecture/API > existing implementation`。`PRODUCT_SPEC.md` 16.1 は **`current accepted ADR` を含み**、さらに「docs が stale の場合は merged source + later ADR/completion report を優先」という但し書きを持つ | **`PRODUCT_SPEC.md` 16.1 側に統一**。ADR は本プロジェクトの決定記録の中核であり、これを欠く優先順位は ADR-0024 のような確定事項を軽視させる。`CLAUDE.md` に 16.1 を参照する記述を追加する（下記 §4 に diff 案） |
| **B-02** | 生成ジョブのエンティティ名 | `docs/DataModel.md` L52 `GenerationJob` / L58 `ProviderGeneration` / 実装は `SceneGeneration` | 文書が設計時の目標形のまま。実装は ADR-0024 に沿って `SceneGeneration` 行自体を耐久キューとしている | `docs/DataModel.md` に「実装済み名称は `SceneGeneration`。本節は初期設計であり ADR-0024 により統合された」旨を追記。実装側は変更しない |
| **B-03** | テナントスコープの持ち方 | `docs/DataModel.md` L9「Every tenant-owned record includes `organization_id`」/ `docs/SystemArchitecture.md`「Scope is not always a column」 | 前者は全行が列を持つと断言、後者は列でない場合があると明記。実装では `SceneGeneration` は `VideoProject` 経由の join 述語でスコープされる | 文書を実装に合わせて統一。**セキュリティ関連のため、統一時に Security & Reliability のレビューを受ける**（誤読すると分離漏れを招く） |
| **B-04** | API 形状 | `docs/API.md`（`/api/v1` REST）/ 現行実装は Next.js Route Handlers | 目標形と現行形の差。`PRODUCT_SPEC.md` 10.1 / 10.3 では既に差分が認識されている | `docs/API.md` 冒頭に「目標形であり現行実装は Route Handlers」と明記 |
| **B-05** | `PRODUCT_SPEC.md` の参照文書一覧の欠落 | `PRODUCT_SPEC.md` L2128「Reference documents in repository」 | 一覧に **`docs/UXFlow.md` が無い**（`CLAUDE.md` の Source of truth 一覧には含まれる）。実装済みのレビュー画面仕様が参照対象から漏れる | 一覧に `docs/UXFlow.md` を追加（`PRODUCT_SPEC.md` は PM が書き換えないため、**変更提案として起票**） |
| **B-06** | フェーズ粒度 | `docs/Roadmap.md`（Phase 0–8 の粗い粒度）/ `PRODUCT_SPEC.md` 9 章（4C-3A-2b, 4C-3B-1 等の細分） | ロードマップに Phase 4 のサブフェーズ体系が存在しない | `docs/Roadmap.md` に「サブフェーズ分解は `PRODUCT_SPEC.md` 9 章が現行」と注記 |
| **B-07** | `CLAUDE.md` が `PRODUCT_SPEC.md` に一切言及しない | `CLAUDE.md` L9「## Source of truth」 | Source of truth 節の 10 文書一覧に `PRODUCT_SPEC.md` が無く、本文のどこにも登場しない。新規エージェントは製品仕様書の存在に気づけない | **`CLAUDE.md` に Source of Truth 節の追記が必要**（§4 に diff 案） |
| **B-08** | `CLAUDE.md` 末尾の First assignment が stale | `CLAUDE.md` L209「## First assignment … Implement Phase 0 only」 | 実際は Phase 4C-3A-2b まで完了・マージ済み。新規エージェントが Phase 0 をやり直しかねない | **優先度高**。現行フェーズを指す記述へ差し替え（§4 に diff 案） |
| **B-09** | `hive/ORG.md` の TODO 定義 | `hive/ORG.md` L52「`TODO.md` = ロードマップ管理の基準」 | 実際は `docs/Roadmap.md` がロードマップ、`docs/decisions/TODO.md` は未決事項の集積。ルート `TODO.md` は作らない方針 | ORG.md は **god 所管のため PM は編集しない**。修正提案として god へ報告 |
| **B-10** | `hive/ORG.md` 第 10 節の役割状態 | `hive/ORG.md` L124「## 10. 追加予定の役割 (方針決定済み / 未 spawn)」 | Product Manager / DevOps・SRE / Legal・Compliance / UI・UX Designer の 4 役割が「未 spawn」と記載されているが、**4 役割とも現に稼働中** | ORG.md は god 所管。修正提案として報告 |
| **B-11** | `PRODUCT_SPEC.md` がバージョン管理外 | セッション開始時の作業ツリー状態（未追跡ファイルとして検出） | SoT に指定された文書が追跡対象外だと、履歴・レビュー・ロールバックが効かない | **Git 管理下に置く**。実際の追加操作は Developer の担当（PM は git 操作をしない） |

---

## 3. C 分類 — 軽微な表記ゆれ

| ID | 項目 | 出典 | 内容 | 推奨対応 |
|---|---|---|---|---|
| **C-01** | 文書バージョン表記 | `docs/DataModel.md` L3 ほか `docs/*.md` 全般 | すべて `Version: 1.0` / `Status: Draft` のまま。内容はマージ済み実装を記述している | 実態に合わせて版とステータスを更新 |
| **C-02** | 完了報告書の配置 | `docs/` 直下 | `*completion*.md` が 45 ファイル、フラットに並ぶ | `docs/phases/` 等へ整理（履歴リンクの追従に注意） |
| **C-03** | 参照一覧の実在確認 | `PRODUCT_SPEC.md` L2128 台 | 一覧の `README.md` / `docs/progress.md` は実在を確認済み。内容の現行性は未確認 | 各文書の現行性を確認 |
| **C-04** | シーン系の用語ゆれ | `docs/DataModel.md` / `docs/AIVideoPipeline.md` / 実装 | `StoryboardScene` / `Scene` / `SceneGeneration` が併存 | 用語集を 1 箇所に定め統一 |
| **C-05** | `prisma/` の位置 | `CLAUDE.md` L95 の構成図（ルート `prisma/`）/ 実際は `packages/database/prisma/`（`schema.prisma` と 10 マイグレーション） | ルート `prisma/` には `README.md` のみが置かれ、実質的な誘導は済んでいる | 構成図の注記のみ修正 |
| **C-06** | 日英混在 | `PRODUCT_SPEC.md` / `docs/*.md` | 日本語文書と英語文書が混在し、章内でも混ざる | 文書ごとの主言語を定める |

---

## 4. `CLAUDE.md` への Source of Truth 節 追記 diff 案

**判定: 追記が必要**（B-07 / B-01 / B-08 に対応）。`CLAUDE.md` の編集は PM の権限外のため、以下は**提案**である。適用は人間承認後、Claude Developer が行う。

### 提案 1 — Source of truth 節（`CLAUDE.md` L9 付近）

```diff
 ## Source of truth

+製品仕様の最上位文書は `PRODUCT_SPEC.md`（製品ビジョン・事業要件・凍結仕様・
+実装状況・次フェーズ）である。実装再開時は最初にこれを読む。
+
 Read before implementation:

+0. `PRODUCT_SPEC.md`
 1. `docs/ProductRequirements.md`
```

### 提案 2 — 優先順位（`CLAUDE.md` L24）

```diff
-Priority: explicit user instruction > security/compliance > product requirements > WaveSpeedAI integration > architecture/API > existing implementation.
+Priority: explicit owner / CTO instruction > security/compliance > product requirements
+> current accepted ADR > WaveSpeedAI integration contract > architecture/API docs
+> existing implementation.
+
+ただし docs が stale の場合は、merged source + later ADR / completion report を
+優先して現状を確定する。完全な定義は `PRODUCT_SPEC.md` 16.1 を参照。
```

**理由**: 現行の `CLAUDE.md` は `current accepted ADR` を優先順位に含めていない。ADR-0024（`SceneGeneration` 行自体が耐久キュー、ブローカー不採用）のような確定事項が「architecture/API docs」より下位に読まれると、stale な文書を根拠にブローカー導入等の逆行が起きうる。

### 提案 3 — First assignment 節（`CLAUDE.md` L209）

```diff
 ## First assignment

-Implement Phase 0 only:
-...
-Do not begin Phase 1 until Phase 0 completion criteria pass.
+Phase 0 から Phase 4C-3A-2b までは完了・マージ済みである。
+現在地と次に着手すべきマイルストーンは `PRODUCT_SPEC.md` 9 章および
+`docs/decisions/TODO.md` を参照して確定すること。
+過去フェーズを再実装してはならない。
```

**理由**: 現状の記述は新規エージェントに Phase 0 の再実装を指示してしまう。実害の可能性が最も高い stale 記述である。

---

## 5. `docs/decisions/TODO.md` への追記提案

既存の「Business rules to confirm (later phases)」節（L590 台）に、A 分類のうち未記載のものを追加することを提案する。**追記の実行は PM の権限外**であり、人間承認後に Developer が行う。

```text
## Source of truth / governance (T-008 監査で検出、人間判断待ち)

- [A-01] PRODUCT_SPEC.md の役割定義: 製品ビジョン文書として分割するか、技術ハンドオーバ仕様として現状を追認するか。
- [A-04] 顧客向けの尺 10-90 秒 / アスペクト比 / 解像度が WaveSpeedAI の実能力で満たせるか未照合。実能力の確定が先行条件。
- [A-05] AI 生成表示の正確な文言・表示位置・多言語・動画への焼き込み可否。Legal 確認必須。
- [A-07] 写真 3-20 枚のルールが ProductRequirements.md にのみ存在し PRODUCT_SPEC.md に無い。正の値と記載先を確定すること。
- [A-09] 決着済み。hive/ORG.md 第 7 節の HOLD は解除されない。人間の明示的な解除指示があるまで継続する旨を ORG.md に明記すること（god 所管）。
- [A-10] 顧客アセットのモデル学習オプトインを提供するか。提供する場合は同意 UI・撤回フロー・DPA 追記が必要。
- [A-12] 99.9% 可用性を対外 SLA としてコミット可能か。目標値のままか。

## 文書整合 (PM 判断で統一可、実行は Developer)

- [B-01] CLAUDE.md の優先順位に current accepted ADR と stale-docs 但し書きを追加し PRODUCT_SPEC.md 16.1 に統一する。
- [B-07] CLAUDE.md の Source of truth 節に PRODUCT_SPEC.md を追加する。
- [B-08] CLAUDE.md の First assignment 節が Phase 0 のままで stale。優先度高。
- [B-11] PRODUCT_SPEC.md を Git 管理下に置く。
```

---

## 6. 確定した Source of Truth 体系（本タスクで与えられた分類。PM は覆さない）

| 文書 | 担う範囲 | 主担当 |
|---|---|---|
| `PRODUCT_SPEC.md` | 製品ビジョン / 事業要件 / 高レベル製品方針 | 人間（最終決定権）。PM は起案と検出のみ |
| `CLAUDE.md` | AI 開発実装ガイド / 優先順位 / 規約 | Tech Lead |
| `docs/*.md` | 現行の詳細技術仕様・実装仕様 | Tech Lead / Developer |
| `docs/decisions/TODO.md` | 未決の技術事項 | 全員が起票、Tech Lead が整理 |
| `docs/Roadmap.md` | 製品ロードマップ | PM が起案、人間が承認 |
| `docs/operations/AGENT_GOVERNANCE.md` | エージェント運用ガバナンス | god（Michael）所管、PM が起草 |
| `docs/operations/BUSINESS_AUTOMATION_ROADMAP.md` | 事業自動化ロードマップ | Marketing Manager 所管（本タスクから分離済み） |

- ルート `TODO.md` は**作成しない**。未決事項は `docs/decisions/TODO.md` に集約する。
- `hive/ORG.md` は god の単独所管。他エージェントは編集せず、提案のみ行う。

---

## 7. 本監査の限界

- `PRODUCT_SPEC.md` は 2156 行のうち構成全体と 0–3 章 / 16 章 / 18 章 / 21 章を精読した。中間章は見出しレベルで確認しており、章内の細部に未検出の矛盾が残る可能性がある。
- 実装コードとの突き合わせは行っていない（本タスクは文書監査であり、コード変更・コード精査は範囲外）。B-02 / B-03 / B-04 は文書の記述と既知の実装事実の比較に基づく。
- A 分類の各項目について、**PM はいかなる解決も行っていない**。
