# プライバシーとデータフロー

[English](../en-US/privacy.md) | [繁體中文](../zh-TW/privacy.md) | 日本語 | [ドキュメント](README.md)

Navide は **Local-first** ですが、常に完全オフラインという意味ではありません。Electron Application、Python Backend、Terminal Session、非公開の Project Intelligence、Workspace State、Orchestration Logic はお使いのマシン上で動作します。外部 Service を有効化または利用すると、データが端末外へ送られる場合があります。

## Navide がローカルに保存するデータ

有効な機能に応じて、Navide は次を保存します。

- `<workspace>/.agent-team/` 内の、ユーザーごとに非公開の Project Intelligence と Run Artifact
- Application Data Directory 内の Role、Pipeline、Recent Workspace、UI Setting、Analyzer Setting、AI Provider Setting
- Application Data Directory 内の Host 管理 Plugin Storage Partition。認証済みの Plugin/Package ごとに分離され、Workspace Scope では認証済み Workspace ごとに分離されます。Navide や Plugin Registry へ送信されません
- Local CLI Log から得た Token Attribution と Deduplication Metadata
- Local の `navide.db` 内の、サードパーティ Navide Plugin の Activity Log（`plugin_activity`）：Plugin、`namespace.method`、時刻、Workspace、許可／拒否／失敗、Workspace 相対の File Path（Workspace 外の Path は `<outside-workspace>` のみ。File の内容は保存しません）、Shell 呼び出しは実行ファイルと Subcommand のみ。詳細は 7 日間、その後は日ごとの件数のみ 90 日間保持します。同梱の Plans、Git、Mini-IDE は記録しません。この端末の外へは送信されません
- Local の `navide.db` 内の、pane がオフラインの間に届いたチャットメッセージのプレビュー（`channels.wake_kept`、再起動をまたぐ場合は `channels.wake_lost`）：バインドされたチャットから pane がオフラインの間に届いた各メッセージの先頭 40 文字で、送られなかったメッセージをチャットに伝えるために使います。マスクせずにそのまま保存するため、メッセージの先頭に機密があればそれも保存されます。メッセージが pane に送られた時、またはチャットに伝えた時点で削除し、チャットのバインド解除や bot の削除時にも削除します。bot が無効の間は、再び起動するまで保持します。この端末の外へは送信されません
- 任意の AI Provider API Key。制限された File Permission（対応 System では `0600`）で保護された Local Settings File に保存

Navide は Project Telemetry Service を運営せず、Navide Account を必要としません。

## 非公開の Project Intelligence

`.agent-team/` は、その Local Workspace を使う個々のユーザーに属します。Git から除外され、人間の Team Member 間で State を同期するためのものではありません。Private Prompt、Task Context、Session Identifier、Agent Output、Run Event、Handoff、Token Summary、将来の Coordination Metadata が含まれる場合があります。

`.agent-team/` を `.gitignore` から削除したり、意図的に作成した Project Documentation の代わりとして公開したりしないでください。Artifact を共有する必要がある場合は、必要な Specification、Decision、Report、Patch、Evidence だけを Review して Export してください。

将来の Portability Feature では、Redaction と Selection Control を伴う明示的な Local Export/Import を使用すべきです。Navide は Private Project Intelligence を暗黙に Cloud または Repository State へ変えてはなりません。

## 外部と通信する可能性がある機能

| 機能 | 送信先の可能性 | 関係するデータ |
|---|---|---|
| Coding Agent CLI | CLI Vendor または設定された Model Provider | Prompt、選択した Context、Tool Result、Provider 定義の Telemetry |
| Cloud AI（Inline 編集と Code Review） | Anthropic、OpenAI、Google、Groq、DeepSeek、Mistral、xAI、Custom Endpoint | 選択したコード、Prompt、Model Parameter |
| Context7 Injection | Context7 と MCP Distribution/Runtime Dependency | 検出された Library Name と Documentation Query |
| Web Search | Search Provider | Search Query Text |
| Git Operation と Issue Detection | 設定された Git Host。Local `git`、`gh`、`glab` CLI 経由 | Repository/Issue Data と、CLI または Host Account Flow が扱う Credential |
| Update Check | GitHub Releases | Application Version と通常の Network Metadata |
| Plugin Registry Trust Refresh | 選択した Official Registry、または明示的に承認した self-hosted Registry | インストール済み marketplace plugin の namespace/name。Refresh では Plugin Source や Archive を送信しない |
| Skills package retrieval | GitHub API and codeload | Requested repository/ref and normal network metadata; downloads a public archive without uploading local skill contents |
| CLI risk DNS lookups | Operating system resolver and its configured upstream service | Declared expected hostnames and configured allowed hostnames |
| MCP Server | 設定された MCP Server と、それが利用する Service | Server の Tool と Configuration に全面的に依存 |
| チャットチャンネル | pane を紐付けたチャットプラットフォーム（Telegram、Slack、Discord など）とそのチャットの全メンバー | チャットから送られたメッセージへの返信。ミラーの詳細度が「チャットへの返信のみ」より上なら、ローカル入力、各ターンの結果、委任内容、子 pane も含む。マスクされるのはそのチャンネル自身のボット認証情報だけで、プロンプトや結果に含まれる API キーなどの秘密情報はそのまま送信される |

Private Code や規制対象 Data を送信する前に、各 Provider の Policy を確認してください。

Production Git Package は Host 所有の argv Allowlist を通して `git`、`gh`、`glab`
をローカルで実行します。Navide がこれらの Service を Proxy したり、Repository
を Navide へ Upload したりすることはありません。Local CLI が Remote Operation
または Issue Query を実行すると、設定された Remote、CLI Login、Provider Policy
に従って GitHub または GitLab が Data を受け取る場合があります。Git Account
Credential は Host の保護された Local Account Store または CLI 自身の Credential
Flow に残り、Plugin Renderer Storage には書き込まれません。分離された v2 Git
Renderer が受け取るのは非 Secret の Account Metadata と Workspace Binding State
だけです。Remote Git Operation では、Host が Backend 呼び出しの直前に Bound
Credential を注入します。Workspace に Host Account の Binding がない場合でも、v2
は Host 所有の Interactive Credential Flow を使用できます。Host は Operation ごとに
Opaque で Instance-bound な Owner を作成し、Git の Prompt を発行元の正確な Git
View に転送し、Response を受け入れる前に Request Ownership を検証します。入力
された Secret はその Exchange の間だけ保持され、Plugin Storage には保存されません。
別の View または別の Workspace からの Credential Response は拒否されます。

インストール済みの marketplace plugin がある間、Navide は Application 起動時と
15 分ごとに、その Plugin の namespace/name を選択した Registry へ送信します。
これは、署名済みの Trust Metadata を取得し、Revoke された Publisher や Package を
検出してインストール済み Plugin を隔離するためです。送信先は設定した Registry URL
で決まります。Official URL を使う場合は App に Pin された Official Registry を、
self-hosted URL を使う場合はユーザーが明示的に承認した URL と Root だけを使います。
この Refresh で Plugin Source、Package Archive、Workspace File を Upload することは
ありません。

Navide は、再起動後の Check に使うため、最新の署名済み Trust Snapshot を Plugin
Installation とともにローカルに保持します。Registry 自身の Request Log の保持は、
その Registry の管理に委ねられます。現在、Refresh 専用の無効化設定はありません。
インストール済みの marketplace plugin をすべて削除すると、この Data Flow は停止
します。その他の外部 Service の Data Flow は、それぞれの設定に従います。

Issue 16 の Production Storage Integration が有効な場合、Plugin の Uninstall は
Cleanup が成功した後に、その Plugin の Local Storage を削除します。後で再インストール
しても、削除された Storage は復元されません。First-party `navide.git` の Migration
は Host 所有の明示的な Consumer であり、Git Preference は認証済みの Package と
Workspace Storage Partition を使用します。Upgrade 時には、以前の Active Snapshot
を新しい Candidate に複製し、Rollback 用に旧 Snapshot を保持する場合があります。

## CLI risk observation data

For vendors with declarations, the backend samples numeric endpoints of established TCP sockets attributed to active pane process trees and inventories declared local data roots. Format checks read at most 64 KiB from each candidate file locally. This feature does not intercept packets, decrypt TLS or upload file contents. Read buffers are used for format recognition; file contents and tokens are not stored in the risk records.

The local `navide.db` retains baseline and file-membership metadata, paths, sizes/classes, presence and absence observation times, network endpoint findings and counts, availability, and Ignore/Allow decisions. An allowed exact IP is also retained in that vendor's UI settings. Metadata can reveal local paths and contacted IPs even though it contains no copied file contents.

Building the expected-address snapshot performs forward DNS lookups for declared expected hostnames and any configured allowed hostnames through the operating system resolver. That resolver, and its configured upstream service, can receive those names. Numeric IP allowances need no hostname lookup. The feature does not infer destination names with reverse DNS; an address match or mismatch cannot establish traffic contents or intent.

## 認証情報

Agent CLI の Credential は各 CLI の Configuration に残ります。Cloud AI Key を Navide に入力すると、AI 機能（Inline 編集、Code Review）で利用できるようローカル保存されます。Settings Export では API Key と Token を Redact します。

**Portable Credential** はユーザーが自ら選ぶ例外です。各ベンダーが「別の Machine へ持ち運ぶ」ために公式に用意した値（例：`claude setup-token` が出力する Token）を、Settings → Accounts に貼り付けます。Navide はこの Device 上で暗号化して保存し、その CLI の新しい Pane を起動するときに環境変数としてのみ渡します。CLI 自身の Login File には書き込みません。ある Device から削除しても、その Device からだけ削除されます。

貼り付けた Credential がアップロードされることはありません。アカウントの Credential と Key はご自身の Machine から出ることはありません。Settings → Sync に Credentials セクションはなく、古いビルドでオンのまま残った Credentials スイッチはオフとして扱われ、Navide Cloud はどのバージョンから送られた Credential の Record も受け付けません。MCP 設定は、同期を有効にした場合、Machine 上で暗号化してからアップロードされ、サーバーは復号キーを持ちません。

Local File Permission は、同じ Machine 上の他 User による偶発的 Access を減らしますが、Malware、Compromised User Account、Unrestricted Agent、Backup、同等権限の Process からは保護しません。

## Agent の権限

External CLI が独自 Sandbox を提供して有効化しない限り、Agent は現在のユーザーの OS 権限で実行されます。Navide は現在、完全な Workspace Sandbox を提供していません。

YOLO Mode は CLI の Confirmation または Sandbox Protection を回避する場合があります。信頼でき、Version Control された Workspace でのみ使用し、後から Command と Diff を確認してください。

## Context Handoff

Agent 間の Handoff には Task Context と前 Stage の Output が含まれる場合があります。Automatic Secret Scrubbing は、まだ完全な Security Boundary ではありません。他の Agent へ渡される可能性がある Prompt、Generated Plan、Log、File に Credential を置かないでください。

## ローカルデータの削除

Active Session を停止した後、Workspace の `.agent-team/` Directory から Private Project Intelligence を削除できます。削除すると Source Repository は残りますが、Resumability、Run History、Attribution、蓄積 Context が失われる場合があります。Application 全体の Setting と History は Navide Application Data Directory にあります。保持したい Configuration は削除前に Backup してください。

Vulnerability の報告については、[Security Policy（英語）](../../SECURITY.md)を参照してください。

## Token Monitor local records

Token Monitor reads local Claude transcripts to summarize turn timestamps, session identifiers, models, and token counts. Its in-memory cache contains these summaries rather than prompt or response text. Local transcript records are not assigned to the current account because their account ownership cannot be verified.

Successful observations from the existing Claude quota polling service are saved in the application data directory as `claude-quota-history.sqlite3`. Records contain an account-slot identifier, observation time, plan type, quota percentages, and reset-window metadata; they contain no credentials or conversation text. Recording prunes observations older than 180 days and limits the database to 50,000 samples. This history is local to this installation and is not uploaded by Token Monitor. Opening or refreshing the monitor adds no external API or CLI requests; the existing usage service retains its own polling behavior.

### MCP による Skills インストール

GitHub public skill の準備では、repository、ref と通常の接続 metadata を `api.github.com` に送り、解決した commit の archive を `codeload.github.com` から取得します。入力は `owner/repo` または HTTPS の `github.com/owner/repo` URL です。Private repository、任意のダウンロード URL、redirect は拒否します。GitHub の認証情報を追加せず、取得時にローカル skill 内容をアップロードしません。システムの proxy 設定は適用される場合があります。ローカルの準備は指定した skill ディレクトリだけを読み、GitHub へ接続しません。

準備した bytes は backend メモリに保持され、15 分後または再起動時に失効します。有効なパッケージは最大 8 件で、メモリには別に最大 8 件の軽量な完了記録を保持します。インストールは確認済み snapshot を使用し、元のファイルを再読込せず既存の共有 Skills ルートに書き込みます。スクリプトや plugin hooks は実行しません。記録が残っている間の再送は元の結果だけを返し、再書き込みしません。記録は元の preview の期限で失効するか、それより先に破棄される場合があります。その後の再送は missing/expired を返し、再インストールしません。Inspect／prepare は skill の文章、ファイル情報、出所パスを要求した coding agent に返すため、CLI 自身のデータポリシーに従いモデルプロバイダーへ送られる可能性があります。パッケージに秘密情報を含めないでください。

Skills sync が有効なら、条件を満たす内容と配信設定を既存フローでペアリング済みデバイスへ同期できます。選んだパッケージは Skills 内容 export と同じ上限（64 ファイル、各 256 KiB、合計 512 KiB）を使用しますが、上限内であることは同期完了を保証しません。Backend が生成した source、digest、時刻の記録はローカルの Navide marker に残り、編集や再起動後も保持されます。Export／Skills sync には含まれません。

### MCP による Navide マーケットプレイスの照会

`marketplace_search` と `marketplace_detail` は、Navide マーケットプレイスのページと同じリクエスト（検索テキスト、カテゴリ、ページ、またはパッケージ名）を Navide アプリから設定済みの Registry に送らせます。`plugins_list_installed` は外部に何も送らず、ローカルの一覧を読むだけです。3 つとも結果（公開されている掲載データと、インストール済み Navide プラグインの id・バージョン・状態）を要求元の coding agent に返し、その CLI のデータポリシーに従って、設定されたモデルプロバイダーがそれを受け取る場合があります。

### MCP による Navide マーケットプレイスへの依頼

`marketplace_request_install`、`_update`、`_rollback` を使うと、Navide アプリは `marketplace_detail` と同じ方法でパッケージを照会します。依頼ツールはすべてローカルのインベントリを読みます。依頼は、依頼した pane の名前とワークスペース、エージェントの理由とともに、判断されるか期限切れになるまでバックエンドのメモリに保持され、Navide のウィンドウでユーザーに表示されます。`plugins_disable` と `plugins_enable` は外部に何も送りません。依頼、判断、無効化、有効化はすべて navide.db にローカルで記録され（`plugin_agent_actions`：プラグイン、操作、呼び出し元の種類、pane ID、pane 名、ワークスペース、結果）、30 日間保持され、その後は最新の 10,000 行が残ります。
