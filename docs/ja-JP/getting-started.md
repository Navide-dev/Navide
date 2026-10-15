# はじめに

[English](../en-US/getting-started.md) | [繁體中文](../zh-TW/getting-started.md) | 日本語 | [ドキュメント](README.md)

Navide は Apple silicon 上の macOS 13 以降、Linux x64、x64 および Arm 版 Windows をサポートします。[最新の GitHub Release](https://github.com/Navide-dev/Navide/releases/latest) では、Developer ID で署名され Apple の Notarization を通過した macOS 向けの DMG と ZIP、Windows x64 および Arm64 向けの NSIS Installer、Linux x64 向けの AppImage と `.deb` を提供しています。GitHub からのダウンロードが遅い、または失敗する場合は、同じファイルを dl.navide.dev のミラーからも配信しています。README のダウンロード一覧には各ファイルの隣に「ミラー」リンクがあり、navide.dev はミラーに到達できるとき自動的にそちらへ切り替えます。

macOS にインストールするには、DMG をダウンロードして Navide を Applications にコピーし、そのまま開きます。Gatekeeper の回避は不要です。

Windows Build は Code Signing されていないため、初回起動時に SmartScreen が警告します。

## Windows へのインストール

リリースから `Navide-<version>-win-x64.exe`（Arm 版 Windows では `Navide-<version>-win-arm64.exe`）をダウンロードして実行します。Installer は Code Signing されていないため、初回起動時に SmartScreen が「Windows によって PC が保護されました」と表示します。**詳細情報 → 実行** を選んでください。Windows の Code Signing は保留中のため、署名が整うまでは新しい Installer ごとにこの警告が出ます。Windows でもアプリ内更新は動作しますが、同じ理由で署名検証なしでインストールされます。

## Linux へのインストール

x64 向けに 2 種類のパッケージを配布しています。

- **AppImage** — `chmod +x Navide-<version>-x86_64.AppImage` してから実行します。FUSE Runtime を同梱しており、アプリ内更新で自己更新します。
- **`.deb`** — `sudo apt install ./Navide-<version>-amd64.deb`。`/opt/Navide/navide` にインストールされ、`PATH` 上の `navide` コマンドと Desktop Entry が追加されます。更新はアプリ内更新ではなく Package Manager 経由です。

## Source からインストールするために必要なもの

- Apple silicon 上の macOS 13+、Linux x64、または x64 / Arm 版 Windows
- Node.js 22.12+（22.x）
- pnpm 10+
- Python 3.12+
- uv 0.11+
- 対応する 14 種類の Coding CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）のうち一つ以上。一覧は [User Guide](user-guide.md) を参照
- 任意：Local Analysis 用の Ollama または Local GGUF Model
- Windows の場合：開発者モード（**設定 → 開発者向け**）、または Navide を管理者権限で実行すること。Pane ごとの CLI Home と管理対象の Skills を支える Symbolic Link の作成に必要です

各 Coding CLI には、それぞれ独自の Installation、Authentication、Subscription、Data Policy があります。Navide はそれらの要件を置き換えません。

## Source からインストール

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

`pnpm dev` は Electron Application、Vite Renderer、Python FastAPI Backend をまとめて起動します。

## 初回起動

Onboarding Wizard が必要な Runtime を確認し、利用可能な Agent CLI を検出します。次の手順を完了してください。

1. Block されている基盤 Dependency を解決します。
2. 対応する Coding CLI が一つ以上利用可能で、Authentication 済みであることを確認します。
3. Intent Detection と Automatic Answer を使う場合は Local Analyzer を設定します。
4. macOS では、使用する Workflow に必要な権限だけを付与します。
5. 信頼できる Project Folder を Workspace として開きます。

macOS では、Agent と Terminal が Workspace を操作する方法によって、Navide が Automation、Files and Folders、Full Disk Access を要求する場合があります。権限を付与する前に、macOS が表示する理由を確認してください。Windows と Linux に相当するプロンプトはありません。

Onboarding 後は Settings → CLI Agents に、検出された各 CLI のバージョン・Install 方法・最後の更新結果が一覧表示され、その CLI 自身の更新コマンドと診断コマンドを実行できます。

## 最初の Task を実行する

最小構成で動作を確認するには：

1. 破棄可能、または Version Control された Workspace を開きます。
2. Agent を一つ手動で Spawn します。
3. 「この Repository を要約する」など、Read-only の Task を与えます。
4. Terminal Output、Session Detection、History が更新されることを確認します。
5. CLI が対応する Usage Log を提供する場合は Token Stats を確認します。

Manual Flow が動作したら、小さな Task で Pipeline を試してください。Stage Definition を確認し、影響を理解するまでは YOLO または Full Auto を無効にしてください。

## 開発チェック

```bash
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests
```

Application、Backend、CLI、Session Binding、Analyzer、Token Tracking が期待どおり起動しない場合は、[トラブルシューティング](troubleshooting.md)を参照してください。
