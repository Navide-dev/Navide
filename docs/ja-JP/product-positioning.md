# プロダクトポジショニングと公開表現

[English](../en-US/product-positioning.md) | [繁體中文](../zh-TW/product-positioning.md) | 日本語 | [ドキュメント](README.md)

この文書は、README、Web Site Copy、Demo、Release Note、Presentation、Community Post における Navide の公開 Story を一貫させるためのものです。Communication Reference であり、User Guide、Roadmap、Release History の代わりではありません。

## カテゴリー

Navide は **AI-native なソフトウェアエンジニアリング環境**であり、**Agent 時代のエンジニアリングツール**です。

単なる Code Editor、Terminal Multiplexer、IDE Plug-in、AI Chat Panel として位置づけるものではありません。それらは Interface の一部になり得ますが、Product Category は Agent 時代の Engineering Work を取り巻く完全な System によって定義されます。

- Goal と Acceptance Criteria
- Agent、Role、Session
- Parallel Execution と Coordination
- 非公開の Project Intelligence
- Human Exception と Intervention
- Change、Test、Review、Evidence

## 主要な対象ユーザー

Navide はまず、End-to-end の Software Outcome を担い、複数の Coding Agent を指揮する一人の人間のために作られています。

- Independent Developer
- Technical Founder
- Product Area 全体に責任を持つ Engineer

Product Strategy を明示的に変更しない限り、Team や Enterprise の Narrative がこの初期 Focus に取って代わってはなりません。

## 問題

AI は一人のエンジニアが開始できる実行量を増やします。しかし、Ownership、Coordination、Durable Context、Visibility、Exception、Verification を自動的に解決するわけではありません。

従来の IDE は、一人のエンジニアが一つの主要 Workstream を手動で動かすと想定しています。Agent 時代のエンジニアリングには、Intent と Concurrent Execution を組織する環境が必要です。

## 中心となる約束

> **一人のエンジニア。AI エンジニアリングチーム全体の力。**

Navide は Goal を協調され、可視化され、検証可能な Software Work へ変換します。その間もエンジニアは Intent、Architecture、Risk、Judgment、Final Acceptance に責任を持ち続けます。

## カテゴリーの対比

> **従来の IDE は Code を整理する。Navide は Engineering Work を整理する。**

```text
従来の IDE
エンジニア → ファイルを編集しツールを操作する → ソフトウェア

Navide
エンジニア → 目標、Agent、意思決定、根拠を指揮する → ソフトウェア
```

この対比は重心の変化を説明します。File、Editing、Terminal、従来の Engineering Tool が重要でなくなるという意味ではありません。

## メッセージ階層

### 1. 仕事を指揮する

Outcome を、協調する Agent、独立した Session、割り当てられた Role、Parallel Execution、設定可能な Development Stage へ変換します。

### 2. Project Intelligence を保持する

Local の `.agent-team/` Layer を通じて、Workspace ごとの State、Prior Run、Session Information、Handoff、History を個々の Agent Conversation をまたいで復元します。

### 3. 判断が重要な場所へ介入する

可逆的な作業を可視化したまま進めます。Ambiguity、Risk、Conflict、External Impact、Irreversible Action、Subjective Product Judgment がある場合にエンジニアへ注意を戻します。正確な制御のため Diff、Editor、Terminal、Diagnostics、Git、Test、Review を利用可能に保ちます。

## プロダクトモデル

- **Genesis** は Idea を最初に動く形へ変えます。
- **Evolution** は実際の Product を継続的に開発、Test、Fix、Refine します。Navide の日常的な中心です。
- **Intervention** は判断や精度が必要なとき、エンジニアに専門的な直接制御を提供します。

## 根拠の階層

公開 Evidence は次の順序で進めます。

1. **提供済みの Product Behavior** — Application、Test、Documentation、Release Artifact に裏付けられた、現在見える Capability。
2. **Founder Dogfooding** — Navide が Navide 開発の主要環境として使われていること。有効な First-party Evidence。
3. **Independent User Workflow** — 別のエンジニアが実プロジェクトで Navide を使用し、体験の共有を許可すること。
4. **Repeatable Outcome** — 複数ユーザーが一貫した価値ある Workflow を報告すること。
5. **Measured Product Evidence** — 定義され Review 可能な方法で裏付けられた Adoption、Retention、Performance、Quality の Claim。

Founder Dogfooding を Customer Validation と表現してはなりません。Future Direction を Shipped Behavior と表現してはなりません。

## 統制された用語

| 推奨 | 意味 | 避ける表現 |
|---|---|---|
| AI-native Engineering Environment | Product Category | 説明のない AI IDE |
| Agent 時代の Engineering Instrument | Vision と Brand Category | 一般的な AI Productivity Tool |
| AI Engineering Force | 一人の Engineer が指揮する複数 Agent | AI Employee、Autonomous Company |
| Session | 一つの Agent または Terminal Execution Context | Bot Thread |
| Private Project Intelligence | Local・Per-user の Workspace Context | Team Memory、Cloud Memory |
| Management by Exception | 意味ある判断のために Human Attention を戻す | Full Autonomy、No Supervision |
| Available Today | 検証済みの Current Capability | Release Evidence のない Production-ready |
| Product Direction | 意図された Future Outcome | 実際の Commitment のない Coming Soon |

## 現在裏付け可能な主張

- Navide は複数の独立した Coding Agent Pane と Terminal Pane をサポートします。
- 現在の Registry は 14 種類のコーディング CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）と Plain Terminal Session をサポートします。
- 対応 Session は検出、保存、再構築、再開できます。
- Pipeline では Stage、Parallel Slot、Role、Prompt、Question、Documentation Query、Completion Sentinel を定義できます。
- Workspace ごとの State、Run Event、Handoff、対応する Token Summary は `.agent-team/` に保存されます。
- Navide は Editor、Diff、Terminal、Diagnostics、Git、Test、Review Surface を提供します。
- Navide は Local-first で、Navide Account を必要としません。
- Navide は Apple silicon 上の macOS 13+、Linux x64、x64 および Arm 版 Windows をサポートします。v0.2.2 では Developer ID 証明書で署名し Apple の Notarization を受けた macOS 向けダウンロード、Windows x64 インストーラー、Linux x64 パッケージ、および Source Installation を提供します。Arm 版 Windows のネイティブインストーラーは Release CI でビルドされ、次のリリースから配布されます。Windows ビルドはまだコード署名されていません。
- Navide の創設者は Navide 開発の主要環境として利用しています。

## ラベルが必要な方向性の主張

- Navide は従来の IDE を主要な Engineering Environment として置き換える。
- Navide は Policy-driven な完全な Management by Exception を提供する。
- Navide は Conflict、Risk、Idle Session、Failure を包括的に検出する。
- Project Intelligence Layer は完全に Inspectable、Portable、Redactable、Controllable になる。
- エンジニアは、別の IDE を中心にせず、Idea から Trustworthy Delivery まで Product を進められる。

これらの Claim には `product direction`、`long-term direction`、`destination`、または同等の表現を付けます。

## 現在は裏付けられない主張

- すべての対応プラットフォームで署名済みまたは Notarization 済みのダウンロードがある（Windows ビルドは未署名）。
- Navide は完全な Workspace Sandbox を提供する。
- Navide は常に完全オフラインである。
- Navide によりエンジニアが特定倍率で速くなる。
- Navide には Customer Adoption、Retention、Performance の数値がある。
- 特定企業または Independent Engineer が Navide を推奨している。
- Navide は現在、すべての Professional IDE Workflow を置き換えている。

公開するには、新しい Product Evidence または Market Evidence が必要です。

## ドキュメントの役割

- Root README は簡潔な Public Product Story と Source Installation の入口です。
- Manifesto はプロダクトの背後にある歴史的変化と信念を説明します。
- Product Vision は Target User、Doctrine、Ownership、Success を定義します。
- Roadmap は現在の System と意図された Destination を分離します。
- User Guide は現在の挙動を説明します。
- Changelog と GitHub Releases は提供済みの変更を説明します。
- Privacy と Security 文書は現在の Boundary を定義し、将来の保証を表現しません。
