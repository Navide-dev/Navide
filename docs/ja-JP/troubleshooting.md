# トラブルシューティング

[English](../en-US/troubleshooting.md) | [繁體中文](../zh-TW/troubleshooting.md) | 日本語 | [ドキュメント](README.md)

## Application が起動しない

1. Node.js 22.12+（22.x）、pnpm 10+、Python 3.12+、uv 0.11+ を確認します。
2. Lock された Dependency を再インストールします。

   ```bash
   pnpm install --frozen-lockfile
   uv --project backend sync --locked
   ```

3. Terminal から `pnpm dev` で起動し、最初の Backend または Electron Error を確認します。
4. `pnpm typecheck` を実行して、Environment Problem と Source Error を区別します。

## Backend Health が利用不可のままになる

- 別 Process が Local Loopback Communication を Block していないか確認します。
- OS の Security Software（Gatekeeper、SmartScreen や Defender、Endpoint Agent）が Package 済み Python Backend を拒否していないか確認します。
- 開発時は `uv --project backend run python -m agent_team_backend` を別に実行して Startup Error を表示します。

## Agent CLI が見つからない

- 通常の Interactive Terminal で CLI の Version Command を実行します。
- Install 後に Navide を再起動し、更新された `PATH` を受け取らせます。
- Navide で Spawn する前に CLI 独自の Authentication Flow を完了します。
- Executable Name を確認します。Settings → CLI Agents は対応するすべての CLI を一覧し、検出済みのものは解決されたパスを表示し、未検出のものにはベンダーの Install Command を提示します。

## CLI が自身の Auto-update の失敗を報告する

Pane に `✘ Auto-update failed` のような CLI 自身のメッセージが表示されることがあります。CLI の Installation Directory はすべての Pane と Profile で共有されるため、複数の Pane が同時に更新すると衝突する場合があります。

- Settings → CLI Agents を開きます。失敗した更新は該当 CLI の行に、時刻・バージョン・記録した Config Home とともに表示されます。
- その行の更新アクションを使用します。CLI 自身の更新コマンド（例：`claude update`、`codex update`、`agy update`、`grok update`）を Terminal で実行します。Navide が CLI を更新することはありません。更新サブコマンドを持たない CLI は、代わりに公式ドキュメントへリンクします。
- 衝突が繰り返す場合は、その CLI の Auto-update を手動に設定します。Navide は Spawn ごとにベンダー自身の Opt-out 変数を渡し、更新はこのパネルから行います。
- 実行中の Session は起動時の Binary を保持します。更新後は Pane を再起動してください。

## Pane が「detecting session」のままになる

Codex、Antigravity、Grok は、Log または Database Discovery を利用して新しい CLI Session を Navide Pane に関連付けます。

- 通常の Message を送り、CLI に Pane Marker を保存させます。
- CLI が通常の Session Directory に書き込めることを確認します。
- 最初の Session が検出される前に、すぐ Rebuild または Resume しないでください。
- 検出が完了しない場合は、Issue を作成する前に Pane Output と関連 Backend Log を保存します。

## Resume が動作しない

- Pane が以前に Detected Session State へ到達したことを確認します。
- 元の CLI の History に Session が残っていることを確認します。
- Workspace Path が変更されていないことを確認します。
- CLI Upgrade により Resume Syntax や Session Storage が変わる場合があります。Bug Report に CLI と Navide の Version を含めてください。

## Token Stats が空、または重複する

- Token Tracking は Provider Log Format に依存し、CLI が対応 Record を書き込んだ後にのみ Usage を取得します。
- Navide が CLI Session を現在の Workspace と Pane に関連付けていることを確認します。
- Billing は Provider Dashboard と比較してください。Navide の表示は Operational Telemetry です。
- 重複が続く場合は、CLI Version、安全に共有できる場合は Session ID、Redact 済み Example Record を報告してください。

## Local Analyzer が利用できない

- Ollama では、Service が起動し設定 Model が存在することを確認します。
- GGUF Model では、File Path、Architecture Support、利用可能 Memory を確認します。
- Analyzer Failure は任意 Automation を縮退させるべきで、通常の Manual Terminal 使用を妨げるべきではありません。

## macOS 権限が Workflow を Block する

**システム設定 → プライバシーとセキュリティ**を開き、Automation、Files and Folders、Accessibility、Full Disk Access を確認します。特定の CLI と Workspace に必要な権限だけを付与してください。権限変更後は影響を受ける Application を再起動します。

## Windows が初回起動を Block する

Windows Installer は Code Signing されていないため、SmartScreen が「Windows によって PC が保護されました」と表示し、発行元は「不明」になります。**詳細情報 → 実行** を選んでください。Windows の Code Signing が整うまで、どの Navide Installer でも同じ表示になります。ダウンロードが改ざんされた印ではありません。不安な場合は GitHub Release ページから取得したファイルであることを確認してください。

## Linux の AppImage が起動しない

- まず実行権限を付けます：`chmod +x Navide-<version>-x86_64.AppImage`。AppImage は FUSE Runtime を同梱しているため、`libfuse` パッケージは不要です。
- `.deb` をインストールした場合は、Terminal から `navide` を起動して Startup Error を確認してください。このパッケージの更新はアプリ内更新ではなく `apt` 経由です。

## Terminal Pane のコピー＆ペーストがおかしい

- CLI が Mouse Reporting を有効にしている間、通常のドラッグはプログラム側に転送され、何も選択できません。**Option**（macOS）または **Shift**（Windows/Linux）を押しながらドラッグして、テキスト選択を強制してください。
- **Edit → Copy**、Pane の右クリック **Copy**、**⌘C / Ctrl+C** はいずれも Terminal の選択範囲をコピーします。Terminal の選択は OS からは見えないため、バックグラウンドで動作するサードパーティのアクセシビリティ／クリップボードツール（Edit メニューや Pasteboard を横取りする Typeless などのツール）がコピーを飲み込むことがあります。コピーが無反応の場合は、そのツールを終了する（または **システム設定 → プライバシーとセキュリティ → アクセシビリティ**で Navide を除外する）か確認してから再試行してください。
- CLI パネルで送信せずに改行を入れるには、**Shift+Enter**、**Ctrl+Enter**、**⌘Enter** を押します。通常のシェルのパネルでは Shift+Enter のみが改行になり、Ctrl+Enter は従来どおり送信になります（シェル本来の挙動のため）。修飾なしの Enter は常に送信です。

## Context7 または Documentation Injection が失敗する

Documentation Injection は Best-effort です。MCP Configuration、Package Runtime、Network Access を確認します。Fetch の失敗で Manual Task が Block されるべきではありません。Workspace を Offline に保つ必要がある場合は Integration を無効化してください。

## Git Authentication Prompt が完了しない

- `git remote -v` で Remote を確認します。
- 通常の Terminal で同じ Fetch または Push を試します。
- 既存の SSH Agent または Credential Manager 設定を優先します。
- Access Token を Issue Report や Terminal Screenshot に貼り付けないでください。

## 有用な Bug Report を作成する

次を含めてください。

- Navide の Commit または Version
- OS の Version と Architecture
- Agent CLI Name と Version
- Reproduction Step
- Expected Behavior と Actual Behavior
- Redact 済み Log または Screenshot

Repository の [Bug Report Template](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml)を使用してください。Vulnerability は [Security Policy（英語）](../../SECURITY.md)に従って非公開で報告してください。
