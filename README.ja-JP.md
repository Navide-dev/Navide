# Navide

> **Agent 時代のエンジニアリングツール。**
>
> 一人のエンジニア。AI エンジニアリングチーム全体の力。

Navide は、一人の人間が複数の Coding Agent を指揮するための、オープンソースかつ AI-native なソフトウェアエンジニアリング環境です。目標、Agent、Session、非公開のプロジェクトインテリジェンス、エンジニアリングツール、受け入れ根拠を、ひとつの Local-first Workspace に統合します。

従来の IDE にチャットパネルを追加したものではありません。Navide は、その次に来る開発環境を目指しています。

[English](README.md) | [繁體中文](README.zh-TW.md) | 日本語

[v0.2.19 をダウンロード](https://github.com/Navide-dev/Navide/releases/tag/v0.2.19) | [はじめに](docs/ja-JP/getting-started.md) | [ドキュメント](docs/ja-JP/README.md) | [ロードマップ](docs/ja-JP/roadmap.md)

[![Latest release](https://img.shields.io/github/v/release/Navide-dev/Navide?sort=semver&label=release&logo=github)](https://github.com/Navide-dev/Navide/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](docs/ja-JP/getting-started.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## AI は実行能力を変えた。次のボトルネックは協調である

従来の IDE は、エンジニア自身が実装作業の大部分を担うことを前提に設計されています。ファイルを開き、コードを書き、ツールを実行し、それを繰り返すという形です。

AI はこの前提を変えます。一人のエンジニアが複数の Agent に、調査、計画、実装、テスト、レビュー、改善を並行して依頼できるようになりました。制約となる問題は、コード入力から仕事の指揮へ移ります。

- それぞれの成果をどの Agent が担当するのか
- 各 Session にどのような文脈と制約が必要か
- どの Session が重複し、待機し、あるいは失敗しているのか
- どの判断に人間の意思決定が必要か
- 成果が完成したことを何が証明するのか

AI モデルは実行力を提供し、Navide はその力を指揮するためのエンジニアリングシステムを提供します。

```text
従来の IDE
エンジニア → ファイルを編集しツールを操作する → ソフトウェア

Navide
エンジニア → 目標、Agent、意思決定、根拠を指揮する → ソフトウェア
```

意図、アーキテクチャ、リスク、判断、最終的な受け入れには、引き続きエンジニアが責任を持ちます。Agent は反復可能な実行を担い、Navide は作業を可視化し、同期し、中断可能かつ復旧可能に保ちます。

## Navide が変えること

### 仕事を指揮する

エンジニアリング上の目標を、独立した Session、割り当てられた Role、並列実行、設定可能な開発 Stage へ変換します。Navide は、すべてのタスクを一つの会話に押し込むことなく、複数の Coding Agent を扱えます。

### プロジェクトインテリジェンスを保持する

Workspace ごとの状態、過去の Run、Session 情報、Handoff、History を、個々の Agent との会話をまたいで引き継ぎます。非公開のプロジェクトインテリジェンスは `<workspace>/.agent-team/` に保存され、Git から除外されます。

### 判断が重要な場所へ介入する

可逆的な作業は、可視性を保ったまま進行させます。曖昧さ、リスク、競合、外部への影響、不可逆な決定によって人間の判断が必要になったとき、エンジニアへ注意を戻します。Diff、Editor、Terminal、Diagnostics、Git、Test、Review を使って正確に介入できます。

## 一つの環境、三つのエンジニアリングループ

### Genesis — アイデアから最初に動く形へ

要件、計画、設計、実装、セキュリティレビュー、テストを含む設定可能な Pipeline から新しいプロジェクトを始めます。複数の Agent Slot が並行して作業し、Stage 間で文脈を引き継げます。

### Evolution — 継続的なプロダクト開発

協調する Session を通じて、機能開発、不具合修正、テスト、挙動調整、既存プロジェクトの保守を行います。一度きりの生成ではなく、繰り返される Evolution ループが日々のエンジニアリングの中心です。

### Intervention — 人間による正確な制御

必要なときに成果を直接確認し、変更します。編集は第一級の専門能力であり続けますが、ソフトウェア開発を進める唯一の方法ではなく、より大きなエンジニアリングシステムの中にある制御手段の一つになります。

## Navide は Navide で開発されている

Navide はすでに、創設者がこのプロジェクトを進化させるための主要な開発環境として使われています。

新規プロジェクトは要件と Pipeline から始まります。日々のプロダクト開発では、複数の Agent Session が実装、テスト、修正、レビュー、改善を進めます。統合された mini IDE は、成果の確認や精密な編集が必要な場合に選択的に開かれます。

これは開発者自身による Dogfooding の証拠であり、独立した顧客検証ではありません。次の証明は、他のエンジニアが自身の実プロジェクトで Navide を使うことから得る必要があります。

## 現在利用できる機能

- **Multi-agent Workspace：** 対応する 14 種類のコーディング CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）または通常の Terminal を、それぞれ独立した Pane で実行できます。
- **CLI 管理：** Install 済みの Coding CLI とそのバージョン・Install 方法を検出し、各 CLI 公式の更新コマンドと診断コマンドを実行できます。
- **Session Lifecycle：** 対応 CLI の Session を検出、保存、再構築、再開できます。
- **設定可能な Pipeline：** Stage、並列 Slot、Agent、Role、Kickoff Prompt、Question、Documentation Query、完了 Sentinel を定義できます。
- **Manager Coordination：** 構造化された Dispatch と Worker Question を転送し、Stage 間で文脈を引き継ぎます。
- **Automation Control：** Terminal Activity、Provider Log、Hook、任意の Local Analysis を、Manual、Strict、Continuous、Full Auto、YOLO Mode と組み合わせます。
- **非公開の Project History：** Workspace ごとの状態、Run Event、Handoff、対応する Token Summary を `.agent-team/` に保持します。
- **Engineering Surface：** ファイルの閲覧と編集、Plan と Diff の確認、競合解決、Terminal、Git と複数 Repository の Workflow、Issue 対応、変更 Review、組み込みの AI Terminal を利用できます。
- **Observability：** Workspace、Stage、Pane、Run ごとに、History と対応 CLI の Token 使用量を確認できます。

## 現在地と目指す先

Navide には Local-first の実用的な基盤がありますが、Agent 時代の完全な環境は長期的なプロダクト方針です。

| 現在利用できるもの | プロダクトの方向性 |
|---|---|
| 独立した Coding Agent と Terminal の Session | 意図に基づく Task と Dependency の Orchestration |
| 設定可能な Multi-stage Pipeline | 適応型 Genesis と継続的 Evolution Workflow |
| Local Workspace State と History | 検査・制御可能な Project Intelligence Layer |
| Manual および Analyzer 支援の Automation Control | Policy に基づく完全な Management by Exception |
| Editor、Diff、Terminal、Git、Test、Review Surface | 他の IDE を主要環境としない完全な専門的 Delivery |

プロダクトの方向性は意図を示すものであり、すでに提供済みの機能や提供日の約束ではありません。範囲と終了基準については[プロダクトロードマップ](docs/ja-JP/roadmap.md)を参照してください。

## デフォルトで非公開、境界については誠実に

Navide の Orchestration Process、非公開の Project Intelligence、Workspace State はローカルで動作します。Navide は Project Telemetry Service を運営せず、Navide Account も要求しません。

Local-first は常に完全オフラインという意味ではありません。外部 Agent CLI、Cloud AI Provider、Context7、Search、Git Hosting、MCP Server、Update Check は、使用時に第三者と通信する場合があります。Agent は通常、現在のユーザーの OS 権限を継承します。また Navide は、現時点で完全な Workspace Sandbox を提供していません。

機密コード、認証情報、YOLO、Full Auto を使用する前に、[プライバシーとデータフロー](docs/ja-JP/privacy.md)および[セキュリティポリシー（英語）](SECURITY.md)を確認してください。

## Navide を試す

Navide は Apple silicon 上の macOS 13 以降、Linux x64、x64 および Arm 版 Windows をサポートします。v0.2.19 では Developer ID で署名され Apple の Notarization を通過した macOS 版に加え、Windows x64 Installer と Linux x64 Package を提供しています。

- [DMG をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.dmg) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.dmg))
- [ZIP をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.zip) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.zip))
- [Windows x64 Installer をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-x64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-x64.exe))
- [Windows ARM64 Installer をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-arm64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-arm64.exe))
- [Linux AppImage をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-x86_64.AppImage) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-x86_64.AppImage))・[Linux .deb をダウンロード](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-amd64.deb) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-amd64.deb))

リンク先は dl.navide.dev で、アプリの自動更新と同じ配信元です。隣の「GitHub」リンクは GitHub Release 上の同じファイル（バイト単位で同一。リリースワークフローが両方に公開し、チェックサムの一致を確認しています）。

Navide を Applications にコピーすればそのまま開けます。Gatekeeper の回避は不要です。このリリース以降、アプリ内自動アップデートが利用できます。

Linux と Windows は macOS と同じ CI Gate を通過します。Arm 版 Windows のネイティブ Installer は Release CI でビルドされ、次のリリースから配布されます。それまで Arm 版 Windows では x64 Installer がエミュレーションで動作します。Windows Build はまだ Code Signing されていないため初回起動時に SmartScreen が警告し、Executions ウィンドウはこの Platform では設計上一覧する対象がなく（読み取るのは User の crontab と macOS の launchd で、Windows Task Scheduler は意図的に統合していません——Navide 自身が Scheduled Job を作ることはなく、Task Scheduler が既にマシンの Task を管理しているためです）、Pane ごとの CLI Home と管理対象の Skills は Symbolic Link で構成されるため Windows の開発者モードまたは管理者権限での実行が必要で、CLI は停止を通知されずに終了されるため Pane が閉じる前に Transcript を書き出せない場合があります。

開発用 Checkout では、代わりに Source からインストールしてください。

### Source からのインストール要件

- Node.js 22.12+（22.x）と pnpm 10+
- Python 3.12+ と uv 0.11+
- 対応する Coding CLI が一つ以上
- 任意：解析用の Ollama または Local GGUF Model

### Source からインストール

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

Onboarding Wizard は Runtime を確認し、Agent CLI を検出し、関連する macOS 権限を説明します。続きは[はじめに](docs/ja-JP/getting-started.md)と[ユーザーガイド](docs/ja-JP/user-guide.md)を参照してください。

## ドキュメントと詳細資料

- **Navide を使う：** [はじめに](docs/ja-JP/getting-started.md)、[ユーザーガイド](docs/ja-JP/user-guide.md)、[トラブルシューティング](docs/ja-JP/troubleshooting.md)
- **プロダクトを理解する：** [マニフェスト](docs/ja-JP/manifesto.md)、[ビジョン](docs/ja-JP/vision.md)、[ポジショニング](docs/ja-JP/product-positioning.md)、[ロードマップ](docs/ja-JP/roadmap.md)
- **境界を確認する：** [プライバシーとデータフロー](docs/ja-JP/privacy.md)と[セキュリティポリシー（英語）](SECURITY.md)
- **すべてを見る：** [日本語ドキュメント索引](docs/ja-JP/README.md)または[言語入口](docs/README.md)

## ライセンス

MIT © Navide Team
