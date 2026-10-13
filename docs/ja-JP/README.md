# Navide 日本語ドキュメント

[English](../en-US/README.md) | [繁體中文](../zh-TW/README.md) | 日本語 | [言語入口](../README.md)

Navide は Agent 時代のエンジニアリングツールです。一人の人間が、創造、継続的な進化、正確な人間の介入を通じて複数の Coding Agent を指揮するための、AI-native なソフトウェアエンジニアリング環境です。

ルートの[日本語 README](../../README.ja-JP.md)はプロダクトと現在の配布方法を紹介します。このページは、現在のローカライズ方針に基づく日本語ドキュメント構造を整理します。「English」と記載された項目には、まだ日本語版がありません。

## プロダクト

| ドキュメント | 目的 |
|---|---|
| [Navide マニフェスト](manifesto.md) | Navide が応える時代の変化と、プロダクトを導く信念 |
| [プロダクトビジョン](vision.md) | 対象ユーザー、プロダクトモデル、責任、運用哲学、成功の定義 |
| [プロダクトポジショニングと公開表現](product-positioning.md) | カテゴリー、メッセージ階層、用語、根拠、公開表現の境界 |
| [プロダクトロードマップ](roadmap.md) | 現在のシステムから完全な AI-native エンジニアリング環境へ進む方向 |

## Navide を使う

| ドキュメント | 目的 |
|---|---|
| [はじめに](getting-started.md) | 署名済み macOS ビルドまたは Windows／Linux Installer のダウンロード、または Source からのインストールと初回起動 |
| [ユーザーガイド](user-guide.md) | Workspace、Pane、Pipeline、協調、Git、History、Editor Workflow の理解 |
| [トラブルシューティング](troubleshooting.md) | 起動、権限、Agent Session、Analyzer、Token Tracking の問題解決 |

## 信頼と安全

| ドキュメント | 目的 |
|---|---|
| [プライバシーとデータフロー](privacy.md) | ローカルに残るデータ、第三者へ送られる可能性、認証情報の保存場所を理解する |
| [Security Policy — English](../../SECURITY.md) | 現在のセキュリティ境界を理解し、脆弱性を非公開で報告する |

## 開発とメンテナンス

| ドキュメント | 目的 |
|---|---|
| [Contributing — English](../../CONTRIBUTING.md) | 開発環境を構築し、変更を提出する |
| [Architecture — English](../en-US/architecture.md) | Process Boundary、State Ownership、主要 Service を理解する |
| [Adding a CLI Vendor — English](../adding-a-cli-vendor.md) | AI Coding CLI を追加する：2 つの Spec ファイル、登録、CI が強制するチェック |
| [CLI Integration Records — English](../en-US/cli-extension-guide.md) | ベンダーごとの統合記録：インストール経路、Resume 構文、Session 保存形式 |
| [CLI Vendor Matrix — English](../en-US/cli-vendor-matrix.md) | 対応済み CLI の一覧：実際に実行されるコマンドと、各 spec が宣言する機能 |
| [Plugin Development — English](../en-US/plugin-development.md) | フロントエンド View プラグインまたはバックエンドプラグインを開発し、パッケージ化して署名する |
| [Plugin Development v2 — English](../en-US/plugin-development-v2.md) | 公開 Contracts、SDK、UI Package、外部 Frontend Package Workflow を使用する |
| [Publishing to the Navide Marketplace — English](../en-US/marketplace-publishing.md) | `navide-plugin` でプラグインを作成・パッケージ化・署名し、Navide Marketplace に公開して審査を通す |
| [外部 MCP 制御](external-mcp-control.md) | 外部 MCP クライアントを接続して実行中の Navide ウィンドウを操作し、セキュリティモデルを理解する |
| [Release Guide — English](../en-US/releases.md) | Version、Package、署名、Notarization、公開、Release 復旧を行う |

## リファレンス

| ドキュメント | 目的 |
|---|---|
| [CLI 間メッセージング](inter-cli-messaging.md) | CLI Agent 間のアドレス指定、送信、受信、トラブルシューティング |
| [Keyboard Shortcuts — English](../en-US/keybindings.md) | デフォルトの Keyboard Command と操作方法を確認する |
| [Editor Design — English](../en-US/editor-design.md) | 現在の Editor Architecture と設計方針を理解する |
| [Historical Milestone Record — English](../en-US/spec.md) | 当初の実装 Milestone 記録を確認する |
| [Changelog — English](../../CHANGELOG.md) | Version ごとに提供済みの変更を確認する |

## ドキュメントモデル

- `README.md` は公開英語版のプロダクト／配布入口、`README.zh-TW.md` と `README.ja-JP.md` はそれぞれ繁體中文版と日本語版です。
- `docs/en-US/` が英語ドキュメントの canonical source です。
- `docs/zh-TW/` と `docs/ja-JP/` は、ローカライズ済みの公開プロダクトおよび主要ユーザー導線を反映します。未翻訳の技術文書は English と明記します。
- プロダクトと技術上の事実は英語版を Source of Truth とします。機能を変更するときは、まず英語版を更新し、同じ変更内で既存のローカライズ版を同期します。
- Vision と Roadmap は将来の成果を説明できますが、README の機能一覧と User Guide は現在の挙動のみを説明します。
- 提供済みの挙動は Changelog と GitHub Releases に記録し、Roadmap は方向性を示すもので日付を約束しません。
- `.agent-team/` 内の Private Project Intelligence は各ユーザーに属し、デフォルトでローカルに保持され Git から除外されます。人間のチーム間同期レイヤーではありません。
