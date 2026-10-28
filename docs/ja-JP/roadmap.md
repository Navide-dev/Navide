# プロダクトロードマップ

[English](../en-US/roadmap.md) | [繁體中文](../zh-TW/roadmap.md) | 日本語 | [ドキュメント](README.md)

Navide の長期的な方向性は、**Agent 時代のエンジニアリングツール**になることです。一人のエンジニアが、ソフトウェアライフサイクル全体を通じて AI エンジニアリングチームを指揮する主要環境を目指します。

目標は Multi-agent Terminal Manager や Control Plane よりも大きなものです。最終的にエンジニアは、従来の IDE を主要な作業環境へ戻すことなく、ソフトウェアの理解、作成、Navigation、Editing、Execution、Debugging、Testing、Review、Versioning、Delivery を行えるべきです。

この Roadmap は方向性を示すものであり、日付を約束したり、将来の Capability がすでに提供済みだと主張したりするものではありません。提供済みの挙動は [CHANGELOG.md](../../CHANGELOG.md)、現在の挙動は[ユーザーガイド](user-guide.md)、根本となる目的は[マニフェスト](manifesto.md)と[プロダクトビジョン](vision.md)を参照してください。

## North Star

```text
エンジニアが成果を定義する
  → Navide が非公開の Project Intelligence を復元する
  → 適切な Agent と Session を構成する
  → 作業を分解し、Ownership を与え、同期する
  → 可視化された境界内で Agent が並行実行する
  → Navide が Conflict、Risk、意味ある Exception を検出する
  → Test、Review、Evidence が一つの成果へ収束する
  → 判断が必要な場所へエンジニアが正確に介入する
  → 成果を受け入れ、次の Evolution の Context にする
```

Intent、長期的な Decision、Credential、Destructive Action、External Publication、Final Acceptance には、引き続きユーザーが責任を持ちます。

## プロダクト原則

1. **一人のエンジニア、AI Engineering Force** — 従来の人間組織図を再現するのではなく、一人が多数の Agent を指揮する完全な System を最適化します。
2. **Keystroke より Outcome** — 作業の主要単位は Acceptance Evidence を伴う Goal です。File と Edit は第一級の Implementation Artifact であり続けます。
3. **Evolution が中心** — Project Creation も重要ですが、実際の Engineering Work の大部分は Feature、Fix、Test、Refinement の反復 Loop です。
4. **Management by Exception** — 定型的で可逆的な作業は承認 Noise なしで継続し、Ambiguity、Risk、Conflict、External Impact、Irreversible Action はエンジニアへ戻します。
5. **Private Project Intelligence** — `.agent-team/` は Local、Per-user、Git から除外、Inspectable、Controllable であり、暗黙の Team または Cloud Synchronization Layer にはしません。
6. **Autonomous but not opaque** — 作業は可視化され、中断、復旧でき、Evidence によって説明可能でなければなりません。
7. **Complete Engineering Capability** — Navide は最終的に従来の IDE を置き換えるために必要な Professional Workflow を網羅し、Agent 時代に合わせて再解釈します。
8. **Provider Independence** — Agent と Model の Capability は、一つの Vendor に関する仮定の背後へ隠さず明示します。

## 現在地と目指す先

| 領域 | 現在 | 目指す先 |
|---|---|---|
| Genesis | 設定可能な SDLC Pipeline グラフ（並列 Stage、承認 Gate、回数上限付きの差し戻しループ、Pin されたノード、ノードからの再実行） | 検証済み Initial System と持続可能な Project Intelligence を生む Adaptive Creation Workflow |
| Evolution | Manual Pane と Maintenance Task | Ownership と Dependency を持つ複数 Session を協調させる Intent-driven Daily Workspace |
| Intervention | Monaco、Diff、Terminal、Git、Diagnostics、Review | Navigation、Editing、Execution、Debugging、Testing、Review、Versioning、Delivery の完全な環境 |
| Coordination | Manager Protocol、Handoff、History、Session Attribution | Structured Shared State、Ownership、Dependency、Conflict、Progress Synchronization |
| Memory | Project State、Run、History、Token | Task、Decision、Handoff、Evidence、Recovery のための Versioned Private Project Intelligence Model |
| Autonomy | Manual Toggle、Analyzer、Full Auto、YOLO、Timeout | 明示的な Authority と Escalation を持つ Policy-driven Management by Exception |
| Delivery | Git、Issue、Review、Commit 関連 Workflow | Outcome から Change、Test、Release まで追跡可能な Lifecycle |

## Horizon 0 — ツールとして確立する

**Outcome：** ユーザーが新しい Engineering Model を理解し、Navide を安全に Install、評価できる。

Scope：

- Manifesto、Product Vision、正確な Current Capability Documentation、Architecture、Privacy、Roadmap
- Canonical Product Naming と対応 Agent 情報
- 再現可能な Signed macOS Release と Updater Validation
- Guided First Project と最初の Evolution Task
- Editor の目新しさではなく Agent Coordination を中心にした Product Demonstration

Exit Criteria：

- 新しいユーザーが Genesis、Evolution、Intervention、Private Project Intelligence を説明できる
- 対応するクリーンな Mac で、文書化された Install と First-run Workflow を完了できる
- 最初の Signed GitHub Release に必要な Updater Asset がすべて含まれる
- Documentation が Current Behavior と Future Direction を区別する

## Horizon 1 — 信頼できる Session Fabric

**Outcome：** 複数の Agent Session が、無関係な Terminal Window ではなく、信頼できる Local Engineering Force として動作する。

Scope：

- Preparing、Ready、Working、Waiting、Blocked、Failed、Completed、Interrupted、Resumable を明示する Lifecycle State
- Durable Session Identity、Provider Binding、Rebuild、Resume、Crash Recovery
- 構造化された Session Presence、Ownership、Progress、Blocker、Question、Completion Event
- Raw Terminal Activity と Engineering State の明確な区別
- 信頼できる Input Delivery、Cancellation、Retry、Timeout、Recovery Semantics
- Session が進行・再開できない理由を説明する Local Diagnostics

Exit Criteria：

- 代表的な Session が Application Restart を越えて Silent State Loss なしに存続する
- 対応 Resume Flow 全体で Session Identity と Ownership が安定する
- すべての Automatic Lifecycle Transition に可視化された原因がある
- Failed Session が Recovery Action または Actionable Diagnostic を提供する

## Horizon 2 — Private Project Intelligence Layer

**Outcome：** 各 Session が、すべての会話を再生せずに、エンジニアが蓄積したプロジェクト理解を継承できる。

Scope：

- Project State、Session、Run、Task、Decision、Handoff、Evidence、Coordination Metadata の Versioned Local Schema
- Derived State、Durable Knowledge、Raw Log、Cache、Secret の明確な分離
- Source と Freshness Metadata を持つ Structured Fact と Decision
- 無差別な History Injection ではなく Current Goal に基づく Context Assembly
- Retention、Compaction、Deletion、Redaction、Backup、明示的な Local Export/Import
- Navide が記憶する内容と Session が受け取る内容を示す Inspectable UI

Exit Criteria：

- Resume または Replacement Session が、Transcript の手動 Copy なしに関連する Goal、Constraint、Decision、Evidence を受け取る
- ユーザーが記憶内容を Inspect、Delete できる
- `.agent-team/` は Git から除外されたままで、Private State は暗黙に同期されない
- Schema Migration と Corruption Recovery が Test されている
- Context Selection が古い Agent Output を Current Project Truth と暗黙に扱わない

## Horizon 3 — Evolution Workspace

**Outcome：** 日々の Feature Development、Fix、Test、Tuning、Maintenance が、一貫した Intent-driven Loop になる。

Scope：

- Maintenance を付随的なものとせず、First-class Evolution Workspace にする
- Scope、Acceptance Criteria、Priority、Dependency、Evidence Requirement を持つ Goal
- エンジニアが編集できる Navide 提案の Session Composition
- Task Ownership、Dependency Graph、Parallel Scheduling、Partial Retry
- File、Module、Repository、Environment の Scope Awareness
- Agent Work の重複に対する Conflict Prevention または Early Warning
- Goal から Implementation、Test、Repair、Review、Acceptance までの Continuous Loop
- Evolution Run の Fork または Resume を可能にする Checkpoint

Exit Criteria：

- エンジニアが全 Session を手作業で構成せず次の Feature を開始できる
- Independent Task が並行実行し、Dependency は決定的に待機する
- Destructive Integration 前に Overlapping Ownership が見える
- 成功した Independent Work を再開せずに Failed Node を Retry できる
- Accepted Result が次の Evolution Goal の Context になる

## Horizon 4 — Management by Exception

**Outcome：** Navide が制御を手放さず、エンジニアの注意を守る。

Scope：

- Exploration、Workspace Edit、Command、Test、Network Access、Credential、Git Publication、Deployment、Unrestricted Execution の明示的な Authority Profile
- Ambiguity、Conflict、Failed Evidence、Protected Resource、External Impact、Budget Limit、Irreversible Action の Exception Model
- 各 Session から独立した Prompt ではなく Consolidated Decision Queue
- Escalation 前に Routine Question を解決できる Manager と Peer Coordination
- Handoff、Cloud Request、Diagnostic、Export 前の Secret Detection と Redaction
- Platform Capability により強制可能な Workspace と Protected Path の Isolation
- Policy、Escalation、Override、Acceptance Decision の完全な Audit Trail

Exit Criteria：

- 定型的で可逆的な Workflow が Approval Fatigue なしで完了できる
- Sensitive または Irreversible Action が Effective Policy 外で進行できない
- すべての Escalation が Decision、Available Evidence、Consequence、Recommended Next Step を説明する
- Handoff と Diagnostic の Redaction が Adversarial Test を通過する
- Unsupported Sandbox Guarantee が Platform と Agent ごとに誠実に記載される

## Horizon 5 — 完全な Intervention Environment

**Outcome：** エンジニアが、別の IDE を主要環境とせず、ソフトウェアの理解と変更に必要なすべての精密作業を行える。

Scope：

- 高速な Project Navigation、Global Search、Symbol Search、Reference、Code Intelligence
- 堅牢な Monaco Editing、Multi-file Operation、Diagnostics、Refactoring、Formatting、Language Server Integration
- 統合された Run Configuration、Task、Test Discovery、Test Result、Log、Interactive Terminal
- Breakpoint、Stack と Variable Inspection、Evaluation、Agent-readable Debug Evidence を持つ Debugging
- First-class Diff、Branch Comparison、Conflict、History、Blame、Review
- Git Branch、Worktree、Commit、Remote、Pull Request、Check、Review Feedback
- Language、Tool、Debugger、Test System、Engineering View の Extension Point
- Performance、Accessibility、Keyboard Control、Large-workspace Reliability

Exit Criteria：

- 対象ユーザーが、欠けた Core Capability のために別 IDE を開かず、代表的な Professional Project を完了できる
- Intervention が Context を保ち、Coordinated Agent Execution へきれいに戻れる
- Agent と人間が同じ Diagnostic、Test、Symbol、Diff、Debug Evidence を参照できる
- Large Repository が定義された Performance Budget 内で Responsive を保つ

この Horizon は従来の IDE Interaction をすべて複製することを求めません。より良い Agent 時代の Model による Outcome Parity を求めます。

## Horizon 6 — 検証可能な Genesis と Delivery

**Outcome：** Product が Initial Intent から Continuous Delivery まで、一つの追跡可能な Engineering Environment を通じて進む。

Scope：

- Requirement、Architecture、Implementation、Test、明示的な First Evolution Backlog を生む Adaptive Genesis Workflow
- Intent、Repository、Base Revision、Agent、Policy、Action、Artifact、Evidence を接続する Immutable Run Manifest
- Requirement から Task、Change、Test、Review、Commit、Release への Provenance
- Repository と Permission Preflight を伴う GitHub Issue と Pull Request Intake
- 意図的な Branch、Commit、Push、Draft PR、Check、Review、Follow-up Flow
- 明示的な Human Authority を持つ Build、Packaging、Deployment、Release Gate
- Reproducible Run Export と Fork-from-checkpoint Behavior

Exit Criteria：

- 新しい Product が Genesis に入り、Test 済み Prototype と Evolution-ready Project Model を持って出られる
- Accepted Goal が、Linked Evidence と明示的な User Approval を持つ Draft PR を生成できる
- Failed Check と Review Feedback が Scoped Follow-up Work になる
- External Write、Deployment、Release が曖昧な Authority で発生しない
- Exported Run Evidence を元の Live Session なしに Inspect できる

## Horizon 7 — Agent、Platform、Ecosystem の成熟

**Outcome：** Model、Agent、Language、Tool、OS が変化しても Navide が持続する。

Scope：

- Agent Identity、Installation、Capability、Permission、Launch、Readiness、Resume、Interruption、Session Discovery、Usage の Declarative Adapter Contract
- Compatibility Test Kit と Adapter Health Diagnostics
- 再利用可能な Role、Pipeline、Policy、Team Configuration、Engineering Template
- Version と Capability Metadata を持つ安全な Template Packaging
- PTY、Path、Permission、Packaging、Update が同等な Linux Support——`main` に取り込み済み。Linux CI Gate が対象とし、x64 向けの AppImage と `.deb` は v0.2.2 からリリースで配布済み。残る作業は arm64 ビルドの配布（Release CI は現在手動 Dispatch のときだけビルドする）
- ConPTY、Filesystem Behavior、Packaging、Policy が同等な Windows Support——`main` に取り込み済み。Windows CI Gate が対象とし、x64 向けの NSIS Installer は v0.2.2 からリリースで配布済み。残る作業は Code Signing と CLI を穏当に停止させるシグナル。Task Scheduler 統合は予定なし：Navide 自身が Scheduled Job を作ることはなく、Task Scheduler が既にマシンの Task の一覧・有効化・無効化・削除を担っているためです。Navide 自身が Task を登録し始めた場合のみ再検討し、その際は PowerShell `ScheduledTasks` モジュール上の第三の execution kind として扱います
- Platform と Adapter の Capability Matrix
- Internationalization と Accessible Workflow

Exit Criteria：

- 単純な Agent を Core Pipeline UI Logic の編集なしに統合できる
- Built-in Adapter が共有 Compatibility Suite を通過する
- Template が暗黙に Code を実行したり Authority を付与したりできない
- Platform CI が Unit、Integration、Packaging、Terminal、Editor、代表的 Evolution Workflow を網羅する
- Unsupported Capability が Execution 前に見える

## 横断的な Quality Gate

すべての Horizon で次を扱います。

- Backward-compatible Local State または明示的な Migration Path
- Threat Model と Privacy Data Flow の変更
- Risk に応じた Unit、Integration、End-to-end Coverage
- Recovery、Diagnostics、User-controlled Deletion
- Performance、Storage、Accessibility、Internationalization
- Current Capability Documentation と Release Note
- Credential、Destructive Operation、External Write、Deployment、Publication に対する明確な Human Authority

## 進捗の測定

Navide は現在 Product Telemetry を収集していません。将来 Privacy Review 済みの Telemetry Design を採用しない限り、Measure は Local Report、Test、Opt-in Diagnostic、明示的に共有された Issue Data から得ます。

有用な Measure には次が含まれます。

- Navide を主要な日常 Engineering Environment として使うエンジニア数
- Workspace を開いてから正常な Evolution Goal を開始するまでの時間
- Session Binding、Rebuild、Resume、Recovery の成功率
- Ownership Conflict や Manual Context Copy なしに完了した Parallel Session
- Human Judgment が必要だった Exception と、回避された Routine Approval Prompt
- Linked Change、Test、Review、Evidence を伴って完了した Goal
- Orchestration Failure の修復ではなく、作業の指揮と受け入れに使った時間
- 代表的 Workflow 完了に必要だった Traditional IDE Exit
- Handoff、Cloud Request、Exported Artifact への流入を防いだ Secret

## 目指す先

エンジニアが Idea から始め、AI Engineering Force を構成して指揮し、Product を継続的に進化させ、精密に介入し、信頼できる Software を届けられるようになり、従来の IDE が作業の中心でなくなったとき、Navide の構想は完成します。
