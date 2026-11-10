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

Codex と Antigravity は、Log または Database Discovery を利用して新しい CLI Session を Navide Pane に関連付けます。（Grok Build の Pane は自前の session id で起動するため、ここで待つことはありません。）

Codex では、`/hooks` を開いて保留中の Hook Review を確認します。MCP の起動失敗や、サードパーティの `SessionEnd` タイムアウト警告は別途調査が必要で、それだけで Session ID の衝突を示すわけではありません。Codex 0.154 は `SessionStart` を最初のターンまでキューに入れるため、TUI を開いただけではそのイベントが実行済みとは限りません。

Codex のビルドによっては、Navide がコマンドラインで渡す `SessionStart` Hook を未レビューの Hook として扱い、すべての Pane で **Hooks need review** を表示します。バージョン番号からはどのビルドが該当するか分かりません（ここでは 0.155 は該当せず、0.154 は該当すると報告されました）。そのため Navide は観測で判断します。この画面を最初に表示した Pane がそれを記録し、以降の Codex Pane はその Hook なしで開き、Pipeline Log にもその旨が記録されます。

- Navide は `~/.codex/config.toml` を書き換え**ません**。また `--dangerously-bypass-hook-trust` も渡し**ません**。このフラグは、あなた自身の `hooks.json` の Hook までレビュー対象から外してしまいます。
- Hook を外すことで失うのは、Pane を Session に対応付ける近道だけです。Session は引き続き Log と Marker から特定されるため、動作しなくなるものはありません。
- 画面がすでに表示されている場合は、その Pane で回答する（`2` = すべて信頼して続行）か、Pane を閉じてください。再びブロックされることはありません。

- 通常の Message を送り、CLI に Pane Marker を保存させます。
- CLI が通常の Session Directory に書き込めることを確認します。
- 最初の Session が検出される前に、すぐ Rebuild または Resume しないでください。
- 検出が完了しない場合は、Issue を作成する前に Pane Output と関連 Backend Log を保存します。

## Grok Build の Pane

- **「Do you trust the contents of this directory?」** Navide は、Pane 自身のワークスペースについての確認であれば、起動するすべての Grok Pane に代わって回答し、その回答を `~/.grok/trusted_folders.toml` を通じてほかの Grok Pane と共有します（便利機能 `grok.folder-trust`、[Convenience features](../en-US/convenience-features.md) を参照）。`~/.grok` に共有されるのは、Pane を開いたワークスペース、またはその中のフォルダーだけです。プロンプトが画面に残っている間、Pane は待機中として表示され、メッセージはプロンプトに入力されず待機します。フォルダーの信頼は持続するため、agent やチャットのリレーができるのは拒否だけです（`cli_answer_prompt` の "deny"、Grok の "No, quit" にあたります）。受け入れる場合は Pane の中で自分で行ってください。
- **`[startup probe] … does not identify as Grok Build`** は、`PATH` 上の `grok` が同名の別プログラム（たとえばコミュニティ版の `grok-cli`）であることを示します。公式 CLI を `curl -fsSL https://x.ai/cli/install.sh | bash` でインストールしてください。
- **Credits が利用不可と表示される。** Grok Build は Credits をほかのプログラムに報告しません。Grok の Pane で `/usage` と入力してください。
- **Grok の作業中に送ったスラッシュコマンドは後で実行される。** Grok Build は現在のターンが終わるまでそれをキューに入れるため、`cli_send_and_wait` で待っている返信が前のターンのものである場合があります。
- **ターンの終了が遅い。** Grok Build は既定で `~/.claude` の hooks、skills、MCP サーバーをインポートし、ターンの終わりごとに Claude の stop hooks を実行します。これを避けたい場合は、`~/.grok/config.toml` に次を追加します。

  ```toml
  [compat.claude]
  hooks = false
  ```

## Resume が動作しない

- Pane が以前に Detected Session State へ到達したことを確認します。
- 元の CLI の History に Session が残っていることを確認します。
- Workspace Path が変更されていないことを確認します。
- CLI Upgrade により Resume Syntax や Session Storage が変わる場合があります。Bug Report に CLI と Navide の Version を含めてください。

## Codex の会話が History に表示されない

- Pane ごとに分離された `~/.codex-panes/<session_home_id>/sessions` ディレクトリにある Codex の Rollout ファイルは、Navide の History メタデータとは別に保存されています。History に項目がなくても、元の会話ファイルが削除されたとは限りません。
- History 検索は読み込み済みの項目が対象です。現在の検索結果が空でも、さらに項目を読み込めば古い会話の検索を続けられます。内容の検索は、新しく読み込んだ項目に対してもう一度実行されます。
- Navide の外で既知の会話を再開するには、元の `CODEX_HOME` と正確な Session ID を使ってください。同じ Home に複数の会話がある場合、最新の Session を選ばないでください。
- **Session** 行のない削除済みの Codex 項目には resume id がないため、History に **Resume** ボタンは表示されません。よくある原因は、起動時の **Hooks need review** 画面が session marker を飲み込んだことと、再起動で Pane が marker なしの新しい会話として開き直されたことでした。Rollout は残っています。時刻と `cwd` から `sessions/` 以下で見つけ、同じ `CODEX_HOME` で `codex resume <id>` を実行してください。

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

### MCP サーバーが「starting」のまま、または起動に失敗する

`npx` や `uvx` で起動するローカル（stdio）MCP サーバーは、初回実行時にパッケージをダウンロードしてから、Navide のハンドシェイク（`initialize`）に応答します。サーバーのプロセスが動いている間、Navide は待ち続けるため、初回のダウンロードが遅くても失敗とは見なされません。

- **Settings → MCP** にはサーバーが **starting** と表示されます。15 秒後（`backend/agent_team_backend/mcp_manager.py` の `SLOW_START_NOTE_AFTER`）に、どれだけ待ったかと、初回の `npx`/`uvx` 実行ではパッケージをダウンロードしている可能性があることを示す注記が加わります。サーバーが接続するか失敗するまで、画面は自動で更新されます。
- 応答する前にプロセスが終了した場合、起動はすぐに失敗し、理由に終了コードが示されます。
- プロセスは動き続けているのに応答しない場合、Navide は **300 秒**後にあきらめます（同じファイルの `STDIO_INIT_HARD_CAP`）。この上限は安全策であり、遅いサーバーを制限するものではありません。リモート（`http`/`sse`）サーバーのハンドシェイクは 15 秒のままです。
- サーバーは並列に起動するため、遅いサーバーがほかのサーバーを止めることはありません。

起動に失敗したサーバーには **Failed to start:** と理由が表示されます。次に MCP 設定が再読み込みされたとき（たとえば Settings → MCP で変更を保存したとき）に、もう一度試されます。

stdio サーバーが stderr に出力する内容（npm のダウンロードメッセージ、クラッシュ）は、Navide のデータフォルダーの `logs/mcp-<name>.log` に書き込まれます。このファイルはこのコンピューター上にとどまり、読めるのはあなたのユーザーアカウントだけです（0600）。保持されるのは最新の起動分だけです。起動のたびに空になり、1 回の実行中はサーバーが出力し続ける限り大きくなり、サイズの上限はありません。英字・数字・`_`・`.`・`-` 以外の文字や大文字を含む名前は、安全なファイル名に、名前の短いハッシュを加えたものになるため、2 つのサーバーが同じファイルを共有することはありません。Settings → MCP からサーバーを削除するとそのファイルも削除され、オフに切り替えただけの場合は残ります。Settings → MCP には最後の数行が **Last lines the server printed** として表示されます。そのテキストはサーバー自身の出力であり、サーバーが出力することにしたあらゆる内容を含む可能性があります。Navide 自身がサーバーの設定をそこに書くことはなく、`env` や `headers` の値も書きません。agent が `mcp_list` ツールで読む起動エラーでは、設定済みの URL と同様に、含まれる URL がマスクされます。

## Git Authentication Prompt が完了しない

- `git remote -v` で Remote を確認します。
- 通常の Terminal で同じ Fetch または Push を試します。
- 既存の SSH Agent または Credential Manager 設定を優先します。
- Access Token を Issue Report や Terminal Screenshot に貼り付けないでください。

## Plans が旧版の表示に切り替わる

Plans ウィンドウがパッケージの Backend を起動できない場合、または Backend が終了し続ける場合、Navide はそのワークスペースに前の Plans 表示を出します。表示には **旧版で復旧** というラベルが付き、`forced`、`storage-migration-failure`、Backend 自身の起動エラーなどの理由が 1 行で示されます。プランはワークスペースの `.agent-team/plans/` フォルダにある通常のファイルで、旧版への切り替えで変換や削除はされません。Plans パネルの **再試行** で新しい表示をもう一度試せます（1 Session あたり最大 2 回）。

- **旧版の表示を強制**すると、新しい Plans Backend が原因かどうかを確認できます。Navide を終了し、環境変数 `NAVIDE_PLANS_RECOVERY=legacy` を付けて起動し（macOS では `open --env NAVIDE_PLANS_RECOVERY=legacy -a Navide`）、問題を再現します。変わるのは Plans の表示だけです。強制中は **再試行** がすぐに拒否され、理由が表示されます。新しい表示に戻すには、Navide を終了し、変数なしで起動し直します。
- **Plans の状態は編集しないでください。** Plans の絞り込み・並べ替え・折りたたみの設定は、アプリの user-data フォルダ内の `plugin-storage-v2/` に保存されています。その中の `plans-lifecycle.json` は、旧版の表示がどのパッケージ Version に戻るかを記録します。これらのファイルには触れないでください。旧版の表示は以前の設定を読み取るだけで、現在の設定を上書きすることはありません。
- **Bug Report には**、Plans プラグインの Version（Settings → Navide Plugins）、**旧版で復旧** の理由の行、`main.log` の Plans 関連の行、再起動の前後の `plans-lifecycle.json` を含めてください。認証情報、Token、その他の保存データは含めないでください。
- **受け入れ確認。** 旧版の表示を強制すると、同じワークスペースが開き、そのプランを一覧して開けます。変数を外して再起動すると、Plans タブは通常の表示に戻り、**旧版で復旧** のラベルは出ません。プランフォルダに `_template.html` がない場合、プランの作成は`BACKEND_UNAVAILABLE` という明確なエラーになり、Navide がプラン用のファイルを復元するまで続きます。簡略化したプラン文書が書き出されることはありません。

## 有用な Bug Report を作成する

次を含めてください。

- Navide の Commit または Version
- OS の Version と Architecture
- Agent CLI Name と Version
- Reproduction Step
- Expected Behavior と Actual Behavior
- Redact 済み Log または Screenshot

Repository の [Bug Report Template](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml)を使用してください。Vulnerability は [Security Policy（英語）](../../SECURITY.md)に従って非公開で報告してください。
