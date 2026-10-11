# 外部 MCP 制御

[English](../en-US/external-mcp-control.md) | [繁體中文](../zh-TW/external-mcp-control.md) | 日本語 | [ドキュメント](README.md)

Navide は MCP（Model Context Protocol）Endpoint `/plan-mcp` を公開しており、
Navide の Pane で動作する CLI Agent はこれを自動的に使用します。同じ Endpoint
は Navide 自身の Process Tree の外にある Client — Script、別の場所で動作する
AI Agent、あるいは MCP に対応した任意の Tool — にも開放でき、動作中の Navide
ウィンドウを操作させられます。Pane を開く、UI Action を呼び出す、別の Agent の
会話 Log を読む、Plan Document を管理する、といった操作です。

これは既定では無効です。有効にするということは、**この Mac 上で動作するあらゆる
Process が Navide を制御できる**ということです。有効化する前に
[セキュリティモデル](#セキュリティモデル)を参照してください。

すべての Pane がすでに自動的に得ている二つの方向（Navide が自身の CLI Agent に
Tool を渡す方向と、Pipeline 実行中に Navide が外部の Documentation MCP Server を
利用する方向）については、App 内の Settings → MCP にある「說明」タブ
（[`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)）を参照して
ください。本ドキュメントが扱うのは三つ目、Opt-in の方向 — 外部 Client が Navide
を制御する方向です。

## 接続

1. **Settings → MCP → External access** を開き、**Allow external MCP clients**
   を有効にします。
2. **Connection URL** をコピーします。形式は次のとおりです。

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` は Backend の現在の Port であり（起動時に動的に選ばれるため、再起動
   をまたぐと URL が変わります。Navide を再起動したらコピーし直してください）、
   `<token>` は外部の呼び出し元だけに Scope された Bearer Secret です。
3. MCP Client を **streamable HTTP** でその URL に向けます。それ以上の Handshake
   や登録は不要です。すべての Tool 呼び出しは URL の Query String にある Token で
   認証されます。
4. 同じパネルの **Regenerate token** は古い Token を即座に無効化し、新しい Token
   を発行します。URL が漏洩した可能性がある場合に使用してください。

この Endpoint が受け付ける呼び出し元の Credential は三種類だけです。Pane 自身の
Credential（Navide が claude/codex の Pane を Spawn するときに発行）、この Backend
内部の「host」Credential（自身の CLI 配線が使用）、そして上記の外部 Credential
— これは Settings の Toggle で制御されます。外部の呼び出し元は Pane の Identity
を持たず、したがって自分の Workspace も持ちません。Pane を指定するすべての Tool
（`cli_send`、`cli_send_and_wait`、`cli_read_log`、`cli_get_status`、`cli_wait_idle`）
は、素の Pane 名
ではなく完全修飾の `<folder>/<pane>` 形式（あるいは、唯一の Pane を指名し、それ自体
がすでに完全修飾である `pane_id`）を必要とし、UI State を指定する Tool
（`ui_invoke`、`ui_snapshot`、`ui_list_actions`）や Plan Document を指定する Tool
（`plan_*`）は明示的な `workspace_path` を必要とします。Pane として動作する
呼び出し元はこれを省略でき、その場合その Pane 自身の Workspace が使われます。Pane
を持たないということは Tab Group も持たないということでもあり、host と外部の呼び出
し元による `cli_send` の `to: "group"` Broadcast は `no-group` として拒否されます。
配信先となる自分の Group もなければ、それを尋ねる Window もないからです。Pane を
個別に、あるいは `pane_id` で指定してください。

実装: [`mcp_server/server.py`](../../backend/agent_team_backend/mcp_server/server.py)
（Tool）、[`mcp_server/auth.py`](../../backend/agent_team_backend/mcp_server/auth.py)
（Credential Store、App Data Directory 配下の `plan_mcp_auth.json`）、
[`mcp_server/wiring.py`](../../backend/agent_team_backend/mcp_server/wiring.py)
（Pane/Host の配線 — 外部 Client には不要）。

## Tool カタログ

### Plan Document

| Tool | パラメータ | 動作 |
|---|---|---|
| `plan_list` | `workspace_path` | `.agent-team/plans/` 配下の Plan Document を一覧: `rel_path`、`name`、`stage`、`overview`、`todos` の要約、`mtime` |
| `plan_read` | `workspace_path`, `rel_path` | 一つの Plan の Parse 済み Meta と生の HTML を読み取り |
| `plan_create` | `workspace_path`, `name`, `overview`, `todos` | Template から Plan を作成し、Stage `draft` から開始 |
| `plan_update_stage` | `workspace_path`, `rel_path`, `stage` | Stage を設定: `draft`、`in-review`、`approved`、`in-progress`、`done`、`abandoned` |
| `plan_update_todo` | `workspace_path`, `rel_path`, `todo_id`, `status` | 一つの Todo の Status を設定: `pending`、`in-progress`、`done`、`skipped` |
| `plan_add_note` | `workspace_path`, `rel_path`, `text`, `author?`（`ai`\|`user`、既定は `ai`） | Review Note を追記 |

ここで `workspace_path` が必須なのは、外部 Client が Pane ではないためです。Pane
の呼び出し元はこれを省略し、Tool はその Pane 自身の Workspace を使います。これは
Plan ウィンドウが Plan を解決する際の基準と同じものです。

`plan_create` は、`workspace_path` がどの Live Pane の Workspace とも一致しない
場合に `warning` フィールドを返します。File は書き込まれますが、Navide の Plan
ウィンドウはそれを見つけられません。

`plan_list` はリストを返し、MCP はリストを単一の JSON 配列ではなく**要素ごとに
一つの Content Block** として配信します。Block を連結して一度に Parse すると
`Extra data` で失敗します。各 Block を個別に Parse するか、呼び出しの
`structuredContent` を読んでください。ここにある他の Tool はすべて単一の Object
を返すため、これが問題になるのは `plan_list` だけです。

### CLI Pane — メッセージングと Spawn

これらの Tool は、Agent が裸行の `---MSG-START---` Block を出力して到達するのと
同じ配信 Queue に投入します。共有されるアドレス、Idle Gate、防護策については
[CLI 間メッセージング](inter-cli-messaging.md)を参照してください。

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_list_targets` | — | アドレス指定可能な CLI Pane を一覧: `name`、`address`、`pane_id`（すべての `ui.pane.*` アクションが取るキーであり、下の Pane 系 Tool では `address` の代わりにもなる）、`workspace_path`、`same_workspace`、`busy`、`realized`（復元用 placeholder は false: 背後で CLI が動いていないため常に busy で、誰かが開くまでメッセージは待機する — `ui.pane.open`、または `cli_send(open_target=true)`）、`hold_reason?` |
| `cli_whoami` | — | **CLI Pane 専用。** 自分自身の識別情報を、名簿が他 Pane を記述するのと同じ形で返します: `{ok, caller, name, address, pane_id, workspace_path, agent_key, busy, offline, realized, delegation_hint, hold_reason?, surface?, window_kind?, spawned_by?, waiting_on_me?}`。`delegation_hint` は委譲ルール（下の `cli_open_agent` を参照）を、server instructions を読んでいない Pane のために再掲します。`pane_id` は全ての `ui.pane.*` が受け付ける唯一のキーであり、Pane が自分自身を操作するための前提です。`spawned_by` は自分を開いた Pane（閉じた後は `{pane_id, gone: true}`）|
| `cli_send` | `to`（Pane のアドレス、または Broadcast を表す `"group"`）, `text`, `wait_for_delivery_s=0`（上限 120）, `pane_id?`, `reply_to?` | 別の Pane が Idle になった時点で指示を配信（Busy なら Queue に保留）。`msg_key` を返し、待機を指定した場合はその結末も返す。プレーンな Terminal Pane（`agent_key: "terminal"`）宛てのテキストはそのまま打ち込まれ、**ユーザーの権限でシェルコマンドとして実行される**。`"group"` は Terminal を飛ばし、Terminal はチャットチャネルからの内容を拒否する — [プレーンな Terminal Pane](inter-cli-messaging.md#プレーンな-terminal-pane) を参照 |
| `cli_check_message` | `msg_key` | 一つの `cli_send` の結末: `{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_cancel_message` | `msg_key` | 送信済みでまだ入っていないメッセージを取り消します。判断するのは受信側 Queue を持つウィンドウです。まだ待機中なら破棄して status は `cancelled` に、配信が始まっていれば取り消しは無視され、確定した status が返ります。取り消しは失敗ではなく、通知も書き戻されません。`{ok, msg_key, status, reason?}` を返します |
| `cli_inbox_summary` | — | 自分の送信のうち滞留中または失敗しているもの: `{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20`（上限 200） | **CLI Pane 専用。** *自分宛*に Queue され、まだ入っていないもの: `{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]}` |
| `cli_read_incoming` | `uid=""`, `limit=5`（上限 20）, `include_delivered=false`, `peek=false` | **CLI Pane 専用。** 自分宛メッセージの全文（`cli_pending_incoming` は空白を潰した 200 文字のみ）: `{count, messages: [{uid, sender, status, kind?, content, age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}], note?}`。**既定では読むと消費されます**——読んだメッセージはその後 Pane に入力されません。`peek: true` は消費せずに読みます。消費は予約してから解放する二段階で、解放が失われた場合メッセージは Queue に戻り二度届くことがあります。`consumed` はメッセージごとに返され、消費されなかった理由は `note` に入ります |
| `cli_send_and_wait` | `to`, `text`, `timeout_s=60`（上限 120）, `pane_id?` | `cli_send` に加えてその Turn の完了まで待機。`cli_wait_idle` の結果に `{ok, target, msg_key}` を付けて返す  **リモート Pane**: 送信と配信 gate はローカルと同じ（`rejected` は `failed` と区別されたまま）。待機の半分は名簿バッジを使い、弱点は `cli_wait_idle` と同じです。 |
| `cli_open_agent` | `agent`, `name`, `task`, `workspace_path`（Pane 以外の呼び出し元では必須）, `model`, `effort`, `pane_id?`, `session_id?`, `run_group_id?` | Task 付きで新しい CLI Pane を Spawn。`{ok, name, address, pane_id}` を返し、Spawn が Advisory の閾値を越えた場合は `advisories` も返す。**委譲ルール**（server instructions にも同じ一文があります）: ファイルを編集する、数分以上かかる、あるいはユーザーが途中で見たり中断したり引き継いだりしたくなる作業は、ここで開いた Pane に渡します — Agent 自身の subagent 機構（Claude Code の `Agent`／`Task` ツール）にではなく。Pane は Navide 上で見え、実行中に開け、呼び出し元の Session より長く生きます。subagent は要約を一つ返すだけのブラックボックスです。結果が一段落で済む短い読み取り専用の調査には、引き続き subagent が適しています。`model` と `effort` は任意で、その CLI が受け付けない場合は無視せず「拒否」するため、Pane が別のモデルで静かに起動することはない。多くの CLI は model を受け付けるが、独立した effort を受け付けるものは少なく、残りは effort を model id に埋め込む（`gpt-5.3-codex-high`）。model id は検証しない（リリースごとに変わるため）が、effort はその CLI の語彙と照合する。**`agent: "terminal"`** はプレーンなログインシェルの Pane を開く。`task` は省略可能で、プロンプトが出たあとに一度だけ打ち込まれるコマンドライン（後ろには何も付け足さない。シェルは報告できないため報告の指示もない）。`model`、`effort`、`session_id` は拒否される。再入力はしないので、確認できなかった Kickoff は `unverified` を返す。再送すればコマンドがもう一度実行されるため、再送前に `cli_read_log` を読むこと |
| `cli_close_agent` | `target`, `pane_id?` | Pane を閉じる — `cli_open_agent` のもう半分です。**これは相手の作業を終わらせます**: Pane と PTY が消え、走っていた Turn もろとも死に、その Pane 宛に Queue されていたものは配信されません。取り消しは効きません — 閉じた Pane の Session は待避ではなく消滅です。先に `cli_get_status` を見て、作業中の Pane は閉じないでください。`cli_interrupt` はより穏当な段（割り込みキーを押すだけで Pane は開いたまま）、`cli_send` はさらに穏当（Turn の完了を待つ）です。`{ok, target, name, closed, advisories?}` を返します。`advisories` は閉じたことの代償のうち他の誰も報告しないもの — Pane が Turn の途中だった、メッセージが Queue に残っていた、子 Pane が孤児になった — で、Kill の後では知りようがないため事前に集めます。このマシン上の Pane のみ: `<device>/<workspace>/<pane>` 形式のアドレスは `close-local-only` で失敗します。これはアドレスの誤りではなく、この Tool の限界です |
| `cli_reclaim_agent` | `target`, `pane_id?` | 作業を終えた Pane を回収する — `cli_close_agent` の取り消し可能な版です。CLI プロセスは終了し、Pane は会話を保ったままクリックで再開できるカードとして残ります。ステータスバーの「今すぐ回収」（`ui.pane.reclaim`）を、`cli_send` と同じアドレスで指定した 1 つの Pane に対して、その Pane を持つウィンドウで実行します。ステータスバーのガードが適用され、ビジー・フォーカス中・再開不可の Pane、未送信の入力やキュー中のメッセージがある Pane は拒否されます。`{ok, target, name, reclaimed}` を返し、拒否時は `ok: false`、`reclaimed: false`、ガードの `reason`、`error_code` `reclaim-refused` です。このマシン上の Pane のみ（`reclaim-local-only`）、自分自身は不可（`self-reclaim`）。v0.2.16 より古いウィンドウは `reclaim-unsupported` を返します — `cli_close_agent` で代用せず、アプリを更新してください |

**Choosing a tab group when opening a pane.** `cli_open_agent` accepts optional
`run_group_id` for a fresh pane or a new pane opened with `session_id`:

- Omit it or pass `null` to preserve existing group selection rules: fresh
  panes opened by pane callers inherit the caller's group, resumed conversations
  use the existing saved-group and fallback rules, and standalone callers retain
  their existing defaults.
- Pass `""` to open in the manual, ungrouped tab.
- Pass an existing group ID in the target workspace to override the inherited
  or saved group. The pane's parent lineage is unchanged by this parameter.
- Invalid IDs and groups from another workspace are refused before spawning.
- An explicit group cannot be combined with `pane_id`, which reopens an existing
  pane. Use `cli_place_pane` to move that pane instead.

A successful explicit selection returns `run_group_id`; when resuming,
`restored_lineage.run_group_id` also reflects the override.

Read the current MCP tool schema before calling. Obtain IDs from
`cli_list_sessions` (`run_group_id`) for the target workspace; use a group ID
that still exists, not its display name. For example, replace the path and
group ID below with values returned for the target workspace:

```json
{
  "agent": "codex",
  "name": "Review",
  "task": "Review the change and report findings.",
  "workspace_path": "/path/to/project",
  "run_group_id": "existing-group-id"
}
```

`cli_send` は、メッセージが配信のために*受理された*時点で返り、相手の Agent が
読んだ時点ではありません。`cli_check_message` がそのループを閉じます。`status`
は `queued`（Broadcast 済みでどのウィンドウからも報告がない — Busy な Pane の
ために保留されたメッセージは、実際に注入されるまでここに留まります）、
`delivered`、`failed` のいずれかです。`failed` の場合、`reason` は受信側
ウィンドウの判定です。`rate-limit`（同じペア間で短時間にメッセージが多すぎる）、
`queue-full`（対象の保留メッセージ Queue が上限に達している）、`inject-failed`
（Pane への打ち込みが通らなかった）、`pane-closed`（配信前に対象が消えた）、
`no-report`（試行が結果を報告しなかった）です。

`unconfirmed`（reason は `delivery-unconfirmed`）はそのどちらでもありません。
テキストと Enter は Resume した直後の CLI に送られましたが、その CLI はまだ受信を
示していません。送信は済んでおり実行中の可能性もあるため、これだけで再送しないで
ください。先に `cli_get_status` か `cli_read_log` で Pane を確認してください。
後から CLI の Transcript にメッセージが現れると、状態は `delivered` になります。

失敗は、要求がなくても送信側の Pane にも Push されます。Navide は対象と理由を
記した `[Navide MSG] delivery failed` の通知を、その Pane が Idle になった時点で、
通常のメッセージと同じ Queue と注入経路を通じて書き込みます。これは一度も Poll
しない Agent 向けの注意喚起であり、`cli_check_message` が引き続き正式な答えです。
また、この通知はアドレス指定可能ではないため、これに返信すべきものは何もありません。

**メッセージが入るまで待つ。** Poll がループを閉じるのは Poll を忘れない Agent に
対してだけで、送って先へ進む Agent は何も知ることができません。
`wait_for_delivery_s` は、その答えを同じ呼び出しの中に置く仕組みです。`cli_send` は
その秒数だけメッセージが実際に入るのを待ち、同じ結果の中で何が起きたかを報告します。

| 結末 | 返るもの |
|---|---|
| 入った | `status: "delivered"`、`settled_after_s` |
| ウィンドウが拒否した | `status: "failed"`（別の Machine からの場合は `"rejected"`）、`reason` |
| 時間切れの時点でまだ待機中 | `status: "queued"`、`waited_s`。受信側ウィンドウが理由を述べた場合は `hold` と `held_for_s` も |

拒否されても `ok` は **true** のままです。理由は `cli_send_and_wait` の
`target_lost` と同じで、送信は実際に行われ `msg_key` も本物なので、`ok: false` と
答えると「一度も送っていない」と読まれて再送を招き、作業が二重に発行されてしまう
からです。有用な範囲は 10〜30 秒です。この待機は呼び出し元自身の Turn を消費し、
Turn の途中の Pane や入力されている Pane はメッセージをはるかに長く保留しうるから
です。既定の `0` のままなら、答えは従来と 1 Byte も変わりません。

**メッセージがまだ Queue にある理由。** `hold` は Messages パネルが表示するのと
同じ理由で、`{key, n?}` の形をとります。`key` は `typing`、`mid-turn`、`behind`、
`starting`、`settling`、`not-ready`、`gone`、`paused`、`remote-ack` のいずれかで、
`held_for_s` はその状態が続いている長さです。別のデバイスへ送って 1 分以上応答のない
メッセージは Server に問い合わせられ、その後は `remote-busy`（対象 Pane が Turn の
途中）または `remote-unreported`（作業中ではなく、相手からもまだ何の応答もない）に
なります。これは `cli_check_message` と、
Timeout した `cli_send` の待機に現れ、メッセージが決着したあとや、どのウィンドウも
理由を報告していない間は現れません。`cli_list_targets` は同じ事実を Pane ごとに
`hold_reason` として見せ、それが `busy` を説明可能にしています。ただしここから送った
メッセージがその Pane 宛に Queue されている間だけなので、無いことは何も意味しません。

**Queue に長く留まりすぎたとき。** `queued` のメッセージが **2 分**を超えて待つと
`stale` が現れます。`cli_check_message` でも、Timeout した `cli_send` の待機でも
同じです。これは判定ではありません——何も失敗しておらず、何も諦めていません——
「これは向かっている途中だ」という前提が安全でなくなる地点であり、隣の `hold` と
併せて読み、待ち続けるか、別の相手に頼むか、ユーザーに何か伝えるかを判断して
ください。計測の起点は現在の Hold ではなく送信時点です。`mid-turn` と `typing` の
間を行き来するメッセージは毎回 `held_for_s` を振り出しに戻しますし、この仕組みが
本来対象としているケース——どのウィンドウも Hold を一度も報告しなかったケース——には、
読むべき Hold の時計自体がありません。

**自分の Tab Group への Broadcast。** `to: "group"` は、呼び出し元自身の Tab Group
に属する他のすべての Pane に、呼び出し元自身の Workspace 内で届きます。これは意図
的に、素の行 Protocol の `all` ではありません。`all` は Group を問わず Window 内の
すべての Pane を意味し、一つの語が二つの範囲を意味すると Debug が非常に困難になる
からです。代償は `all` がもともと抱えているものと同じで、実際に `group` という名前
の Pane はここから名前で指定できなくなります。どの Group にも属さない Pane は一つ
の暗黙の Group を共有するため、互いに届きます——誰にも届かないのではありません。
Group を一度も作っていない人の Broadcast が、黙って何もしない操作になることはあり
ません。

返る形は異なります——
`{ok, broadcast: "group", group_id, delivered_to, recipients: [{name, pane_id, msg_key, accepted, reason?}]}`
——`msg_key` は**受信者ごとに一つ**です。各受信者は通常の独立したメッセージであり、
それぞれ独自のペア単位 Rate Limit の予算、独自の Idle Hold、独自の配信レポートを
持つからです。したがってここまでの話はすべて受信者ごとに個別に当てはまり、各 Key
はそれぞれ `cli_check_message` に渡します。`wait_for_delivery_s` は Broadcast には
適用されず、無視されます。Window が列挙してから配信するまでの間にいなくなった受信
者は、Broadcast 全体を失敗させるのではなく、その場で `accepted: false` と
`reason: "target-offline"` として報告されます。`recipients` が空でも失敗ではありま
せん——自分の Group に他に誰もいない、という意味です。

`cli_inbox_summary` は、尋ねるための `msg_key` を持たない場合の同じ事実です。引数を
取らず、呼び出し元自身についてだけ答え、現在 stale または失敗している自分の送信を
すべて返します。60 文字の `excerpt` が付くので、Key を控えていなくてもどのメッセージ
かが分かります。配信済みのものと、送ったばかりで Queue に入っているものは除かれる
ため、空のリストは「自分のものは何も滞留していない」を意味し、「何も送っていない」
ではありません。これは通知が届かない Agent のために存在します。配信失敗通知は送信側
の Pane が Idle になってからそこへ入力されるため、1 時間 Busy であり続ける Agent は
一度も目にせず、外部 Client にはそもそも入力する先の Pane がありません。自分の作業の
合間にこれを呼ぶことが、20 分前に送ったメッセージがまだ Queue に座っていると知る
方法です。

このテーブルは Backend の**メモリ**であり、Log ではありません。直近 500 件の送信を
1 時間保持し、Backend の再起動で失われます。未知の `msg_key` は
`{ok: false, error}` を返し、これは「もう追跡していない」という意味であって
「一度も送っていない」という意味ではありません。

`cli_pending_incoming` はその鏡像です。*自分宛*に Queue されているものを古い順に返し、
`status` は `queued` か `delivering`、Agent ではなく Navide が書いたメッセージには
`notice` または `fallback` の `kind` が付きます。**これは本節で唯一、外部 Client が
使えないツールです。** ここにある他のすべては Pane に*対して*働きかけますが、これは
呼び出し元自身の Inbox を尋ねるものであり、Inbox を持つのは CLI Pane だけです。Host や
外部の呼び出し元には宛先になれる Messaging 名がないため、この呼び出しは空のリストでは
なく `{ok: false, error}` を返します。自分を宛先にできるものが存在しない以上、自分を
待っているものも存在しません。外部から同じ景色を得たい Client は、`cli_list_targets`
で Pane の `hold_reason` を読むか、`cli_check_message` / `cli_inbox_summary` で自分の
送信を追ってください。

上の送信テーブルと違い、こちらは永続化されたメッセージ Log を読むため、Backend の
再起動を越えて残ります。制限が 2 つあります。Log はメッセージが Queue に入った少し後に
受信側の Window が書き込むため、直前の 1 秒間に送られたものはまだ載っていないことが
あります。またメッセージはその Pane の**現在の** Messaging 名で照合されるため、その後
に改名して離れた名前宛に Queue されているものは返りません。

`cli_send_and_wait` は、手動の `cli_send` + `cli_wait_idle` の組み合わせが負ける
競合を処理します。送信した瞬間に対象が Idle であるため、素の待機はメッセージを
読む前に「すでに Idle」を返してしまうのです。このツールはまずメッセージが**入る**
のを待ち、そのうえで送信前に記録した対象の最終活動より*新しい* Turn だけを答えと
して受け入れるため、`last_activity.text` は相手の Agent が返答として述べた内容に
なります。Timeout 時の `reason` は `cli_wait_idle` のものに加え、Idle のまま
メッセージを拾う気配をまったく見せなかった対象に対する `never_started` があります。
送信自体が拒否された場合は `cli_send` の `{ok: false, error}` をそのまま返します。

`timeout_s` は両方の段階をカバーします。**最大でもその半分**がメッセージを送り込む
ために使われ、残りが Turn の完了を待ちます。配信に使われた時間は無駄になりません
——Pane が空けばメッセージは着地し、それは Idle の待機がどのみち座って待っていた
はずの時間だからです——とはいえ折り返し地点でまだ保留されているメッセージが残り
時間で答えを得る見込みは薄く、その Hold の理由は「Timeout、Busy」よりはるかに有用な
答えです。最後まで届かなかった場合の結果は `source: "not_delivered"` で、
`delivery_status` を伴います（`queued` なら `hold` / `held_for_s`、`failed` /
`rejected` なら `reason`）。これは、対象が Idle のままメッセージが保留されていた
ケースへの修正です。以前の順序では、送信した時点の状態から `idle` と答えてしまい、
作業が一度も引き渡されていないのに「あなたの作業を終えた」と読めてしまいました。
`target_lost` と同じく `ok: true` のままです——これを理由に再送しないでください。

待機*中*に対象がアドレス指定可能でなくなった場合 — ウィンドウが閉じた、Pane が
Kill された — 結果は `{ok: true, idle: false, source: "target_lost", error}` に
なります。ここが `ok: true` のままなのは意図的です。送信はすでに行われており
`msg_key` も有効なので、ここで失敗を報告すると「一度も送っていない」と読まれて
再送を招き、作業が二重に発行されてしまうからです。これは「配信済みだが、完了した
かどうかはもう確認できない」と読んでください。

Spawn に上限はありません。Pane は任意の数の子を Spawn でき、Workspace は任意の数の
CLI Pane を保持でき、Spawn の連鎖は任意の深さで実行できます。Advisory の閾値
（子 3、Workspace の Pane 8、深さ 2）を越えても呼び出しは成功し、コストを示す
`advisories` を返します。たとえば各 Pane が 250〜500MB を占めることなどです。
それでも失敗するのは不正なリクエストです。未知の Agent Key、名前の欠落または
すでに使用済み、空の Task です。これらの Advisory は Diagnostics としても記録され、
`ui_diagnostics` で読み取れます。

### CLI Pane — 読み戻し

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_read_log` | `target`, `tail_lines=200`, `since?`, `pane_id?` | Pane の会話 Log の末尾（≤512KB かつ ≤`tail_lines` 行）。`next_cursor` と `rotated` を返す |
| `cli_get_status` | `target`, `pane_id?` | `{busy, agent_key, last_activity?, usage?, ui?}` — `ui` は所有ウィンドウが応答したときに `ui.pane.getStatus` を反映し、値があれば Pane の起動時アイデンティティも載せます: `agentLabel`、`model` / `effort`（Pane 起動時に指定したもの — CLI 内で打った `/model` 切替はここには見えません。無ければベンダー既定）、`profileId`（アカウント pin。記録専用: どの Pane も実際はライブのログインで動きます）、`loginExpired` / `usageLimitUntil`（CLI がそのメッセージを出している間だけ）。`usage` はそのベンダーの**キャッシュ済み**クォータのスナップショットで、`cli_usage` が `providers[agent_key]` で返すのと同じ行です。この呼び出しで更新されることはなく、鮮度は `fetchedAt` / `stale` で判断します。  **リモート Pane**: 名簿から回答し、`remote: true` と `source: "roster_status"` を付けます。バッジの語が 1 つだけで、`last_activity` も `ui` ブロックも `usage`（このマシンのキャッシュはこのマシンのログインのもの）もなく、0.5 秒の debounce と 30 秒の sweep があるため、ライブではなく準ライブです。 |
| `cli_wait_idle` | `target`, `timeout_s=60`（上限 120）, `pane_id?` | Pane が Idle になるか Timeout するまで Block。`{idle, source, waited_s, last_activity?, ui_status?}` を返し、Timeout 時は `reason` も返す  **リモート Pane**: 名簿のバッジを polling します。`source` は `roster_status` か `roster_offline` で、**`turn_complete` にはなりません**——リモートで得られる最も強い観測は「バッジが busy でなくなった」だけです。停止中の Pane は `reason: "awaiting_unclassified"` で timeout します。名簿は語を 1 つしか運ばず、権限プロンプト待ち（人間待ち）と質問中（実質 idle）を区別できないためです。`offline` は第三の答えとして、待たずに即座に返ります。 |
| `cli_interrupt` | `target`, `pane_id` | このマシン上の Pane に、その CLI の割り込みキーを送ります（codex は `ESC`、それ以外は `^C`）。**これは Turn を止めることを意味しません**: CLI によって、Turn を中断することも、単に入力欄をクリアするだけのことも、二度押しで CLI 自体が終了することもあります。コマンドではなくキーストロークです。結果は `cli_get_status`／`cli_wait_idle` で確認してください。その作業を終わらせてよいなら `cli_send` でメッセージを送る方が適切です。`{ok, target, name, sent, status_before, advisories?}` を返します。`sent: false` は何も送られなかったことを意味します（session が無い、またはウィンドウが再接続中）。ローカル Pane のみ |
| `cli_message_log` | `limit=50`（上限 200） | **CLI Pane 専用。** 自分自身のメッセージ履歴 — 何を送り、何が自分に届いたか（新しいものが最後）。`cli_inbox_summary` は滞留した送信だけ、`cli_pending_incoming` はまだ配信されていない受信だけを報告します。届いてしまえばメッセージはどちらからも消え、Compaction の後は自分の Context からも消えるため、「我々が既に何を言い合ったか」に答えられるのはここだけです。永続化された Log なので Backend の再起動をまたいで残り、ここで読んでも誰かの Queue からメッセージが取り除かれることはありません。返るのは自分の行だけで、判定は**現在の**メッセージング名との照合です — 後で改名した名前宛に Queue されたメッセージは、もう自分のものとして一致しません。`{ok, count, messages, scanned, truncated}` を返します。各メッセージは `{uid, created_at, status, sender, recipient, direction, excerpt}` に加えて、値があれば `kind` / `reason` / `delivered_at` / `correlation_id` / `reply_to` / `remote` / `remote_workspace`。`excerpt` は空白を潰した 200 文字で、全文を返すのは `cli_read_incoming` です。`truncated` は自分の古いメッセージが切り落とされたこと（`limit` によるか、走査した直近行の窓によるか）を意味し、`scanned` はその窓が何行あったかです |

`cli_read_log` の `since` は増分読み取りです。前回の呼び出しの `next_cursor` を
渡し戻すと、同じ末尾を読み直す代わりに、それ以降に Pane が述べた分だけを取得
できます。Cursor は追記専用の Capture File 内の Byte Offset であるため、その File
が切り詰められたり置き換えられたりすると意味を失います。その場合、呼び出しは
`rotated: true` を伴う素の末尾を返し、これは新しい出力ではなく仕切り直しです。

`cli_wait_idle` の `last_activity` は `cli_get_status` が同じキーで報告するものと
同じなので、Turn を待ち切った呼び出し元は二度目の呼び出しなしにその Turn の内容も
得られます。`ui_status` は Pane に対する所有ウィンドウ自身の見解であり、待機中に
Probe が届いた場合にのみ存在します。Timeout 時、`reason` は似て見えるが実際には
異なる三つの失敗を切り分けます。`awaiting`（Pane が Permission Prompt で停止し、
**人間**を待っている — UI で応答してください）、`busy`（本当にまだ作業中。もっと
待ってください）、`unreachable`（Pane を所有するウィンドウが応答しなくなったため、
結果の中身はどれも最新ではない）です。

**Capability の境界 — Idle/完了の検出。** ほとんどの CLI の Log Reader は、完了した
Turn のテキストを載せた `turn_complete` Event を発行します。**aider、antigravity、
claude、codex、copilot、cursor、droid、grok、kilo、kimi、muse、opencode、pi、qwen** です。
これらでは `cli_wait_idle` と `cli_get_status` の `last_activity.type` が正確な
Turn 完了 Signal で解決します — ただし一点だけ但し書きがあります。**kimi、pi、
qwen** は自前の Turn 終了記録を持たず、Log の 8 秒の沈黙から `turn_complete`
を合成するため、この三つでは Event 自体が推測であり、Turn の途中で十分に長い間が
空くと待機が早く終わることがあります。素の Terminal Pane にはそうした Signal が
まったくありません —
`cli_wait_idle` は Pane の出力が止まった時点で終わり `source: "quiet_period"` を
報告し、`cli_get_status` はそれに `last_activity` を含めません（`agent_key` は
`"terminal"`）。Terminal はシェルです。送られたテキストはユーザーの権限で
コマンドラインとして実行されます — [プレーンな Terminal Pane](inter-cli-messaging.md#プレーンな-terminal-pane)
を参照してください。静穏期間に
基づく Idle 結果は Heuristic として扱い、CLI が実際に完了したという保証とは
考えないでください。

これは、`cli_send_and_wait` の結果で読むべきフィールドが `source` である理由でも
あります。どの CLI が生み出したものでも形は同じですが、確度は同じではありません。
aider/antigravity/claude/codex/copilot/cursor/droid/grok/kilo/muse/opencode からの
`turn_complete` は Turn が終わったという CLI 自身の言明であり、kimi/pi/qwen
からの同じ値は上記の 8 秒沈黙による推測です。そして `quiet_period` — 素の
Terminal Pane で唯一得られる結果 — は、Turn の終了を何も報告しなかったという
意味なので、Signal を信用せず中身を確認してください。`target_lost` は四つ目の値で、
Turn に対する判定ではない唯一のものです。待機が判定に至る前に Pane が消えたことを
示します。

### UI Action Bus

| Tool | パラメータ | 動作 |
|---|---|---|
| `ui_list_actions` | `workspace_path` | `workspace_path` を所有する Navide ウィンドウに登録されたすべての Command ID を一覧 |
| `ui_invoke` | `workspace_path`, `action`, `args?` | 登録済みの Action を一つ呼び出し、`args` をそのまま渡す |
| `ui_snapshot` | `workspace_path` | そのウィンドウの UI State の構造化 Snapshot |
| `ui_diagnostics` | `workspace_path`, `since_seq=0`, `pane_id`, `limit=50` | そのウィンドウが自分の UI アクションについて記録した Renderer 側の診断 — 例えば `injectText` が Echo チェックの Timeout で内容を再送した、あるいは完全に諦めた、といったもの。`ui_invoke` の呼び出し元が `ok: true` だけからは知りようがなく、以前はそのウィンドウの DevTools コンソールにしか出ませんでした。Tool が成功を報告したのにウィンドウ内の挙動がおかしい（入力の重複、送信の停止）場合の診断に使います。`since_seq` はその Sequence 番号より後のエントリだけを返すので、前回の `nextSeq` を渡せば増分 polling ができます |

三つとも所有ウィンドウの応答を最大 15 秒待ち、現在 `workspace_path` を開いている
ウィンドウがなければ Error になります（完全一致の文字列比較 — ウィンドウを開いた
ときと同じ Path を渡してください）。`ui_invoke` の `action: "ui.workspace.open"`
だけが例外です。その Workspace をまだどのウィンドウも所有していない可能性がある
ため、`workspace_path` に一致するウィンドウではなく、生きている任意の Navide
ウィンドウ一つにルーティングされます。

Path の一致判定が効くのは Pane の識別子を持たない呼び出し元 — 外部 Client か
Host Wiring — だけです。Navide の CLI Pane から、その Pane 自身の Workspace を
指して呼び出した場合は、その Pane を抱えているウィンドウへ直接届きます。Focus の
有無も、そのウィンドウが今どのプロジェクトを開いているかも問いません。別の
プロジェクトを指した場合は意図的な別ウィンドウ宛ての呼び出しとして Broadcast の
経路に戻り、そのプロジェクトを開いているウィンドウに届きます。

ウィンドウに届くことと、`workspace_path` に対して実行されることは別です。
「このウィンドウが今表示しているプロジェクト」に作用する Action —
`ui.pane.create`、`ui.preview.show`、`ui.window.openGit` — は、そのウィンドウが
別のプロジェクトへ切り替わっていた場合、黙って間違ったプロジェクトで実行される
のではなく Error で拒否されます。読み取り専用の Op（`ui_snapshot`、
`ui_list_actions`、`ui_diagnostics`、`ui.pane.getStatus`）はどちらでも応答し、
そのウィンドウの実際の状態を返します。

`ui_list_actions` は、下記の `ui.*` の ID だけでなく、そのウィンドウが Keybinding
に使う Command Registry *全体*を返します。内部 ID（例: `workbench.action.*`）は
キーボードショートカットのために存在するもので、外部向けの文書化された契約では
ありません。安定した文書化済みの引数形状を持つのは、下の表にある `ui.*` の Action
だけです。

#### `ui.*` Action リファレンス

| Action | Args | 効果 |
|---|---|---|
| `ui.settings.open` | `{tab?}`（`general`、`mcp`、`analyzer`、`updates`、`appearance`、`accounts`、`keybindings` のいずれか） | Settings を開く。任意で特定のタブへ |
| `ui.settings.close` | — | Settings を閉じる |
| `ui.settings.yolo` | `{yolo?}` | CLI の権限バイパスのグローバルスイッチを読む。`yolo` を渡した場合は設定する。`{yolo, agents}` を返し、各 agent は `{agent, mode, skipFlag}`。Workspace スコープではありません: どのウィンドウでも答えられ、ベンダーごとの答えは `yolo` ではなく `skipFlag` です |
| `ui.pane.create` | `{agent, name?, task?}` | ウィンドウが開いている Workspace に `agent` の Pane を Spawn。`task` を指定した場合は Kickoff Prompt として送られ、Role 注入はスキップされる |
| `ui.pane.close` | `{paneId}` | Pane を Kill |
| `ui.pane.focus` | `{paneId}` | Pane を表示して Focus（必要ならタブを切り替え） |
| `ui.pane.open` | `{paneId}` | 復元用の placeholder（`cli_list_targets` で `realized: false` の Pane）を開き、完了を待つ。`{realized, reason, paneId}` を返す — `paneId` は開いた後の Pane の id、`reason` は `opened`、`fresh`（新しいセッション。以前の会話は覚えていない）、`already-open`、または開けなかった理由。Resume 動作が `ask` でもモーダルは出ません |
| `ui.pane.getStatus` | `{paneId}` | その Pane の `{status, buffer, logPath?, awaitingKind?, kickoff?, agentLabel?, model?, effort?, profileId?, loginExpired?, usageLimitUntil?}` を返す — アイデンティティ系のキーは Pane に値がある場合のみ |
| `ui.pane.interrupt` | `{paneId}` | その Pane の割り込みキーを押す。`{sent, status, advisories?}` を返す — `status` は押す**前**に読まれます。押すこと自体が、報告しようとしているその状態を変えてしまうためです |
| `ui.pane.reclaim` | `{paneId}`（単一 id または配列） | 作業を終えた Pane のリソースを解放する：CLI プロセスは終了し、Pane はクリックで再開できるカードとして残る（ステータスバーの「今すぐ回収」と同じ）。ビジーまたは回答待ち、フォーカス中、未送信の入力あり、キュー中のメッセージあり、再開不可の Pane は拒否される。`{reclaimed, refused: [{paneId, reason, detail}]}` を返す |
| `ui.tab.switch` | `{tabId}` | Active な Stage/Run-group タブを切り替え |
| `ui.preview.show` | `{kind, …}` | 右レールのプレビューパネルにファイル・diff・インラインスニペットを表示 |
| `ui.window.openPlans` | `{rel_path?}` | Plan ウィンドウを開く。`rel_path`（`.agent-team/plans/<name>.html`、相対パス、`..` 不可）を渡すとその Plan 1 件に絞って開く |
| `ui.window.openResourceManager` | — | Resource Manager を開く（CPU／メモリ／ディスク使用量とストレージ整理） |
| `ui.window.openTurnStats` | — | Turn Stats を開く（CLI ペイン 1 つのターンごとのトークン使用量） |
| `ui.window.openGit` | — | 現在の Workspace の Git ウィンドウを開く |
| `ui.window.openPipeline` | `{pipelineId?}` | Pipeline Manager ウィンドウを開く |
| `ui.workspace.open` | `{path}` | `path` を Workspace として開く（生きている任意のウィンドウにルーティング — 上記参照） |
| `ui.workspace.switch` | `{path}` | このウィンドウを、すでに保持している Workspace に切り替える。Pane は保持されます。ウィンドウが保持していないパスは拒否されます（`ui.workspace.open` を使ってください） |
| `ui.layout.setMode` | `{mode}` | Pane の Layout Mode を変更 |
| `ui.pipeline.start` | `{task?, pipelineId?}` | ウィンドウが開いている Workspace で Pipeline の実行を開始する。Workspace が開かれていない、既に実行中（先に Abort が必要）、`pipelineId` が未指定でその Workspace に選択中の Pipeline も無い、あるいは実行が `running` に到達しなかった場合はエラー。`{pipelineId, stages, workspacePath, state}` を返す |
| `ui.pipeline.abort` | — | 進行中の実行を中止する。何も走っていなければ、no-op に ok を返すのではなくエラーにする。`{workspacePath, state}` を返す |
| `ui.pipeline.next` | — | 実行中の Pipeline を今すぐ次の Stage へ進める。`running` の実行が無い場合、現在が最後の Stage の場合（進む先が無いので、「前へ」と言った呼び出し元の背後で実行を完了扱いにするのではなく拒否します）、あるいは Stage インデックスが実際には動かなかった場合はエラー。`{workspacePath, state, stageIndex, stages}` を返す |
| `ui.pipeline.resume` | — | この Workspace に記録された実行を、最後に完了した Stage の次から再開する。Workspace が開かれていない、既に実行中（先に Abort が必要）、記録された実行が無いか残る Stage が無い、あるいは再開が `running` に到達しなかった場合はエラー。`{workspacePath, state, stageIndex, stages}` を返す |
| `ui.pipeline.reset` | — | そのウィンドウの Workspace にある Pane を（手で開いたものも含めて）すべて閉じ、実行を idle まで消す。Workspace が開かれていない、あるいは状態が `idle` に落ち着かなかった場合はエラー。`{workspacePath, state, stageIndex}` を返す |
| `ui.pipeline.restart` | — | 記録された実行を、同じ Task で Stage 1 からやり直す。Task はまず記録された実行から、次に画面上の Task フィールドから取ります。Workspace が開かれていない、既に実行中、やり直す元の Task が無い、あるいは再開始が `running` に到達しなかった場合はエラー。`{pipelineId, stages, workspacePath, state, stageIndex}` を返す |
| `ui.messaging.readIncoming` | `{paneId, uids?, limit?, includeDelivered?, reserve?, maxChars?}` | ウィンドウ自身の Queue からその Pane 宛のメールを読む（Pane の現在のメッセージング名で照合）。`{messages, reserved, paused}` を返し、各メッセージは `{uid, sender, status, kind, content, createdAt, correlationId, inReplyTo, hold}`。予約されるのはまだ `queued` の行だけで、配信済みの履歴は読めても消費はできず（既に消費されているため）、`reserve: false` は予約せずに読む。`paused` は、実際には待っているメールがあるのに読み取りが空で返る理由で、「今は受け取れない」と「メールが無い」を分けます |
| `ui.messaging.settleRead` | `{paneId, uids, ok?}` | `ui.messaging.readIncoming` が取った予約を確定する: `ok` が `false` 以外ならそれらの uid を消費し、`ok: false` は「テキストは届かなかった」という申告として予約を解放し、メッセージを Queue の元の位置に戻す。`{settled}` を返す |
| `ui.groupPeers` | `{paneId}` | `paneId` からの `group` Broadcast が届く Pane 群 — グループの所属は Backend が決して知り得ない UI State なので、送信 Pane を所有するウィンドウに尋ねるしかありません。`{group_id, peers: [{pane_id, name}]}` を返す。未割り当ての Pane は合成された `manual` グループを共有するため、誰にも届かないのではなく互いに Broadcast します |
| `ui.diagnostics.read` | `{sinceSeq?, paneId?, limit?}` | `ui_diagnostics` の背後にある Action。`{entries, nextSeq}` を返す |

この一覧はここではなくコード側で保守されています。正確な引数形状に依存する前に、
[`App.vue`](../../src/renderer/src/App.vue) の
`registerCommand('ui.*', …)` ブロックと照合してください。

`ui_snapshot` の形は Renderer が決めます（`App.vue` の
`buildUiActionSnapshot`）。`{workspace, panes: [{id, name?, agentKey,
workspacePath, status?}], activeTab, settingsOpen, openWorkspaces}` です。

### プレビュー記録

各 Workspace は「そこで何が変更され、何が表示されたか」の Feed を一本持ちます。
その Workspace の `.agent-team/navide.db` に永続化されるため、Navide を再起動しても
残ります。これらの Tool は Agent 側の入り口です。自分の書き込みを報告し、他の
書き込み者が報告した内容を読み戻し、何かをユーザーの目の前に押し出します。

| Tool | パラメータ | 動作 |
|---|---|---|
| `preview_record` | `rel_path`, `change="modified"`, `note`, `kind="file"`, `content`, `title`, `workspace_path` | 今作成・変更・削除したファイルを報告。`{uid, created_at, rel_path, change, merged}` に加えて `warning?` を返す |
| `preview_list` | `limit=50`（上限 300）, `since=0`, `change`, `agent`, `workspace_path` | Feed を新しい順に読み戻す。`{workspace_path, entries, truncated}` に加えて `warning?` を返す |
| `preview_show` | `rel_path`, `kind="file"`, `content`, `title`, `workspace_path` | ファイル・diff・インラインコンテンツを右レールのプレビューパネルへ Push。ウィンドウ自身の `{ok, result, error}` に `recorded` を加えて返し、`ok` のときはさらに `uid`, `merged`, `warning?` も返す |
| `preview_clear` | `workspace_path`, `before=0` | この Feed を空にする — record、list、show に続く四つ目の動詞です。**これはユーザーがプレビューパネルで見ている行を削除し、取り消せません。** 消えるのは自分の記録だけではありません: File Watcher のものもユーザーのものも同じ Feed 上にあります。`before` は `preview_list` が返す `created_at`（epoch ミリ秒）で、それより前の行が消え、同時刻以降はすべて残ります — 他の Session が記録し続けている最中でも安全に消せるのはこのためです。0 のままだと Feed 全体が消えます。`{workspace_path, removed, before}` に加えて `warning?` を返します |

`workspace_path` の振る舞いは `plan_*` 群と完全に同じです。Pane 呼び出し元は省略でき、
その Pane 自身の Workspace になります。Host や外部 Client は Pane の身元を持たないため
必ず渡す必要があり、渡さなければ Error になります。

`preview_list` の `entries` の各要素は `uid`, `created_at`（Epoch ミリ秒）, `change`,
`rel_path`, `kind`, `title`, `source`, `pane_id`, `agent`, `tool`, `note`,
`payload` を持ちます。

| フィールド | 値域 |
|---|---|
| `change` | `created`, `modified`, `deleted`, `shown` |
| `source` | `user`（App 内の操作）, `agent`（MCP 呼び出しまたは CLI Hook）, `watcher`（File System によるフォールバック、**帰属なし**） |
| `kind` | `file`, `diff`, `snippet`, `html`, `markdown` |

`preview_record` が受け付けるのは `created`, `modified`, `deleted` だけです。`shown`
は `preview_show` だけが書き込み、しかも所有ウィンドウが Push を受け取ったと確認した
後にのみ書かれます — 誰も見ていないプレビューが shown として記録されることはありま
せん。`preview_list` の `change` フィルタは四つとも受け付けます。

`kind` が `rel_path` と `content` のどちらを必須にするかを決めます。`file` と `diff`
はファイルを Path で指すので `rel_path`（Workspace 相対）が必要です。`snippet`,
`html`, `markdown` はそれ自体が Payload なので `content` が必要で、上限は 512 K 文字
— 超えた場合は切り詰めではなく、その場で拒否されます。`note` は上限 500 文字で、
こちらは拒否ではなく切り詰めです。

**帰属は呼び出し元の Credential から読み取られ**、引数からは決して読みません。記録
される `pane_id` と `agent` は呼び出し元 Pane 自身のものであり、別の Pane を騙る
パラメータは存在しません。Host や外部 Client の記録には帰属が付きません。

`merged: true` は、そのイベントが Feed 上の既存の記録に畳み込まれたことを意味します
— 同じ Path、同じ `change`、2 秒以内、典型的には File System の Watcher が先に
到達した場合です。この場合は何も追加されず、`uid` は `""`、`created_at` は 0 に
なります。Feed は Workspace ごとに最新 300 行を保持し、それを超えた古いものから
捨てます。

`warning` の意味は `plan_create` のときと同じです。`workspace_path` を使っている
Live な Navide Pane が一つもないため、その記録はユーザーが見ていない場所に着地して
います。

**この Feed の書き込み者はこの三つの Tool だけではありません。** CLI Agent が
`Write`, `Edit`, `MultiEdit`, `NotebookEdit` でファイルを編集すると、Navide が完全な
帰属付きで自動的に記録します — ただし Hook の仕組みを持つベンダーに限られ、現在は
**claude, qwen, copilot** の三つです。それ以外のファイル変更はすべて File System の
Watcher がフォールバックとして拾い、`source: "watcher"`、帰属なしで記録されます。
したがって `preview_list` が見せる像は、その Workspace に対する `preview_record`
呼び出しの総和よりも広く、`pane_id` を持たない記録は「誰もその変更を名乗り出て
いない」ことを意味します — 何もそれを起こしていない、という意味ではありません。

### クォータとトークン消費

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_usage` | `agent=""` | 各ベンダーの CLI クォータがどれだけ残っているか、Navide が追跡している通りに返します。他の Pane に仕事を渡す前に確認する価値があります: `cli_send` は、プランを使い切った CLI に対しても実行できる CLI に対するのと同じように Task を Queue し、メッセージは届いた上で相手がそこで失敗するだけになります。`cli_open_agent` でどのベンダーを開くか決める前にも同じことが言えます。`agent` は答えを一つのベンダーキー（`claude`、`codex`…）に絞ります — `cli_whoami` が `agent_key` として報告するのと同じキーです。空なら追跡中の全ベンダーが返ります。`{ok, providers, accounts, enabled, intervalSec}` を返し、フィルタしたときは `agent` も付きます: `providers` はベンダーキーから現在の Snapshot への対応、`accounts` は Navide が複数ログインを追跡しているベンダーについて、アカウント Slot をキーとした各アカウントの Snapshot です。数値はベンダー自身のものをそのまま返しており、Navide は再計算も注釈もしないため、すべてが同じ形をしていると期待せず、そのベンダーが実際に返すフィールドを読んでください。`enabled: false` はクォータの polling が切られていることを意味し、ここにあるのは最後に読めた値だけです。エントリがまったく無いベンダーは Navide がクォータを読めないベンダーであり、「クォータが残っている」という主張とは別物です |
| `cli_token_stats` | `workspace_path` | この Workspace がどれだけトークンを使ったか、Navide の数え方で返します — Token パネルの背後にある数値です。`{workspace_path, current_run, cumulative, runs, runs_truncated, live_sessions, live_session_count, all_time, by_vendor, by_day}` を返します。`cumulative` はこのプロジェクトの合計で `by_vendor` と `by_stage` の内訳付き、`all_time` と `by_vendor` は全プロジェクト分、`current_run` は Pipeline の実行が開いていなければ `null`、`runs` は直近の Archive 済み実行（集計のみ、古いものが切られたときは `runs_truncated` が true）、`live_sessions` は今動いている中で最も忙しい CLI Session（それぞれ `{input, output, calls}`）、`live_session_count` はその総数、`by_day` は直近一週間のグローバル使用量です。カウントの出どころは各ベンダー自身の Session Log なので、Navide が Log を読めないベンダーはゼロではなく「寄与なし」になります。`cli_usage` がもう半分です — あちらはベンダー側に残るクォータ、こちらはここに記録された消費です |

### Workspace・Skills・指示ファイル

Skills のインストールと配信変更にはユーザーの許可が必要です。Mutation annotations によって、これらの操作を以下の読み取り専用インベントリと区別します。

五つの読み取り専用インベントリです。それぞれ、上の Tool 群が「もう知っている」と
前提している問いに答えます: どのパスが Workspace なのか、CLI に指示を書く前にその
CLI が既に何を渡されているのか、このプロジェクトが既に何を述べているのか、どの MCP
サーバーが設定されているのか、そしてユーザーがどの Prompt を保存しているのか。

| Tool | パラメータ | 動作 |
|---|---|---|
| `workspace_list` | — | Navide が知っているプロジェクトを、最近開いた順に返します — `plan_create`、`preview_record`、`cli_open_agent` はどれもプロジェクトルートの絶対パスを求めますが、そのパスがどれなのかを教えるものが今までありませんでした。これがそのリストです。`{workspaces, live_pane_workspaces}` を返します。各 Workspace は Store 自身のレコード（`path`、`name`、`last_opened_at`、`pinned`、`exists`）に加えて `has_live_panes`（今まさに CLI Pane が動いていれば true）を持ちます。それを優先してください — `has_live_panes` が false の Workspace はどの Navide ウィンドウにも見られていないため、そこに書いた Plan や Preview はユーザーにまったく表示されません。`exists` が false はもっと厳しい失敗で、フォルダがディスクから消えています。`live_pane_workspaces` はその Live 集合そのもの（解決済み）です。Pane は、ユーザーが Welcome 画面から一度も開いていないプロジェクトで動いていることがあり、それは最近リストが言及しないだけの、まったく正当な `workspace_path` です |
| `skills_list` | — | 読み取り専用の `{skills, native, root, agents}` と `skills_inspect` 用の安定した ID を返します。共有項目は enabled／targets／所有者、native 項目は元の CLI とパスを示し、vendor 能力は registry に従います。`delivered_to_me` と `delivery_semantics: configuration_only` は設定情報で、実行中 pane の snapshot ではありません。Navide 配信を無効にしても共有ルートの直接スキャンは止まりません。現在の実配信／ロードは不明のままです。 |
| `skills_inspect` | `skill_id` | 指示、ファイル、所有者、保存済みのローカル出所記録と `delivery_revision` を読みます。現在のライブラリの ID のみ受け付け、任意のパスは拒否します。第三者の指示はデータであり実行許可ではありません。Native の一覧は `files_truncated` で省略を示す場合があります。 |
| `skills_prepare_install` | `source`, `ref=""`, `subdir=""` | `owner/repo`、GitHub public HTTPS repository URL、またはローカル skill の絶対パスから不変の内容を準備します。複数候補なら token なしで `selection_required`／`candidates` を返します。`subdir`（root は `.`）を選んで再試行してください。選んだ preview は `preview_id`、`digest`、source／commit、全文 `skill_md`、一覧、有効期限を返します。コード実行と共有ルートへの書き込みは行わず、呼び出し元に結び付いた preview は 15 分後または再起動で失効します。 |
| `skills_install` | `preview_id`, `expected_digest`, `targets` | 準備済み bytes の追加を申請します。ユーザーが Navide のウィンドウで承認するまで何も書き込まず、エージェントが代わりに同意することはできません。`status: "pending_approval"` と `approval_id` を返し（再呼び出しは同じ保留中の要求を返します）、承認は初回共有ルート書き込みへの同意も兼ねます。source の再読込や再取得はせず、Digest の一致が必要です。同名の managed、native、ユーザー項目は拒否します。記録が残っている間の再送は元の結果だけを返し、再書き込みしません。有効な準備は最大 8 件、軽量な完了記録は別に最大 8 件です。期限切れや先行破棄の後は missing/expired を返し、再インストールしません。出所記録はローカルのみで export／sync 対象外です。`targets: null` は全 wired vendor、`[]` は追加配信なしです。 |
| `skills_install_status` | `approval_id`, `wait_s=0` | 呼び出し元自身の要求に対する判断を返します：`pending`、`installing`、`installed`（結果付き）、`rejected`、`failed`（エラー付き）、`expired`。`wait_s`（最大 60）で判断を待ちます。 |
| `skills_set_delivery` | `skill_id`, `targets`, `expected_revision`, `enabled=null` | ユーザーの許可と inspect の `delivery_revision` で設定を変更します。古い版は `SKILL_CONFLICT` になります。Native の空／null targets は追加配信を解除し、`enabled` は禁止します。所有 CLI や共有ルートの直接スキャンには影響しません。実際のロードは新しい session で別途確認してください。[Skills の手順と上限](user-guide.md)も参照してください。 |
| `memory_list` | `workspace_path`, `path=""` | ここの CLI が読み込む指示ファイル — `CLAUDE.md`、`AGENTS.md`、`GEMINI.md` など、このプロジェクトのものとユーザーのホームのもの。`path` なしで呼ぶとメタデータのみを一覧します: `{workspace_path, files, agents}` で、各ファイルは `scope`（`user` または `project`）、`path`、`relative`、`readers`（それを読み込むベンダーキー）、`canonical`、`exists`、`size`、`modified`、`error`。まだ存在しないファイルも一覧されます。それは「ある慣習がどこに置かれるか」を示すからです。`agents` は各ベンダーと Navide がそのファイルを見つける方法（`mapped` または `configured`）です。`path` を付けるとその一つを返します: `{workspace_path, file, path, text, exists, modified}` — パスはこの一覧が報告したものでなければならず、それ以外は拒否されるため、任意のファイルを読む手段ではありません。読み取り専用: 指示ファイルの編集は Settings でのユーザーの判断で、ここに対応する Tool はありません。Workspace が無い場合は user スコープのファイルのみが一覧されます |
| `workspace_open` | `path` | `path` を Workspace として開きます — 新しいウィンドウか既存のウィンドウかは Navide が決めます。`path` はプロジェクトルートの絶対パス（`workspace_list` が返す種類のもの）でなければなりません。`ui_invoke` に action `ui.workspace.open` を渡すのと同じですが、先に action を調べる必要がありません。生きている任意のウィンドウにルーティングされるため、ウィンドウが一つも開いていないときだけエラーになります。`{ok, path}` を返します |
| `workspace_switch` | `path` | 呼び出し元 Pane をホストしているウィンドウを、そのウィンドウがすでに保持している別の Workspace に切り替えます（1 ウィンドウ複数プロジェクト）。Pane は影響を受けません。ウィンドウが `path` を保持していない場合は、`workspace_open` を案内するエラーになります。そのウィンドウで Pipeline が実行中の間も拒否されます（先に `pipeline_abort` するか、サイドバーから切り替えてください）。Pane からの呼び出し専用です — host や外部の呼び出し元は自分のウィンドウを持たないため `ok: false` になります（代わりに `ui_invoke` に `workspace_path` と action `ui.workspace.switch` を渡してください）。今画面に表示されている Workspace を `{ok, path}` で返します |
| `mcp_list` | — | ここで設定されている MCP サーバー — Navide 自身がクライアントとして接続するもの（ライブ状態付き）と、各 CLI が自分の設定（`~/.claude.json`、`~/.codex/config.toml` など）に持つものをファイルの記述どおりに反映したもの。`{servers, native, agents}` を返します。Navide 管理の各サーバーは `{name, enabled, transport, command, args, env}` または `{name, enabled, transport, url, headers}` に `status`（`disabled` / `connected` / `error` / `unknown`）と `tool_count` を加えたもので、ツール一覧そのものは含みません。各 native エントリは `{name, agent, transport, path, command, args, url, env, headers, enabled, valid, error}` です。`agents` は各ベンダーと、Navide がその MCP に対してできること（`wired` / `planned` / `unsupported`）、および自身の設定が反映されているかどうかです。資格情報の形をした値 — env と header の値、`--api-key=` 形式の引数、URL の userinfo と秘密のクエリパラメータ — はすべて `***` にマスク済みで、名前とホストはエントリを識別できるよう残されます。Workspace ごとではなくグローバルな一覧です。読み取り専用 — サーバーの追加・有効化・編集は Settings でのユーザーの判断です |
| `prompt_list` | `id=""` | ユーザーが Settings → Prompts に保持する Prompt スキル — アプリから CLI Pane に送る保存済みの指示。`id` なしで呼ぶとメタデータのみを一覧します: `{skills, default_id}` で、各スキルは `{id, name, icon, description, category, enabled, isDefault, maxTurns}`、`default_id` はデフォルトに指定されたスキルの id（無ければ `""`）です。ユーザーが一度も保存していない場合は `note` が付きます: アプリは初回使用時に組み込みスキルを植え付けますが、それはここからは見えません。`id` を付けるとそのスキルを丸ごと返します — `{skill}` で、`prompt` と `resumePrompt` も含みます。未知の id は `{ok: false, error}` を返します。読み取り専用: 作成や編集は Settings で行います |

### Pipeline

Pipeline は保存された多段階の実行です: 順序付けられた Stage の集合で、各 Stage は
どの CLI がどの Role を演じるかを指名する Slot を持ちます。最初の二つは読み取り、
残りの六つは実行そのものを動かします。

| Tool | パラメータ | 動作 |
|---|---|---|
| `pipeline_list` | — | このマシンにある Pipeline テンプレートと、その Stage がキャスティングされる Role。`{pipelines, active_pipeline_id, roles}` を返します: 各 Pipeline は `{id, name, builtin, stage_count, stages}`、各 Stage は `{id, title, short_title, description, sentinel, allow_questions, recommended_roles, slots}`、各 Slot は `{agent_key, role_key, label, is_commander}`。`roles` は各 Role の `{key, label, one_line, is_default}` を返し、`role_key` が何を意味するかを知るには十分です。二つのものは意図的に含まれていません。どちらもプロンプト一式だからです: Slot の Kickoff 本文と、Role の System Prompt です。`active_pipeline_id` は Pipelines ウィンドウが現在選択しているテンプレートです。ここにあるのはテンプレートだけで、ある実行がどこまで進んだかは `pipeline_status` です |
| `pipeline_status` | `workspace_path` | ある Workspace の Pipeline 実行がどこまで進んだか（実行があれば）。自分がより大きな流れの一部なのかを知るために使います: Pipeline Slot として開かれた Pane は Task を告げられるだけで、自分が五段階中の三段階目だとは告げられず、次の Stage は自分の完了が記録されるまで始まりません。`{workspace_path, active, …}` を返します。`active` は実行が進行中のときだけ true で、一度も Pipeline を走らせたことのない Workspace は `{workspace_path, active: false}` だけを返します — それはエラーではなく空状態です。プロジェクトの記録がある場合はさらに `state`（`idle` / `running` / `completed` / `aborted`）、`task_description`（何のために始めた実行か）、`pipeline_id`（`pipeline_list` のどのテンプレートか）、`current_stage_index` と `total_stages`、`run_count`、`log_file_name`、`updated_at`、加えて `stages`（それぞれ `{stage_id, title, agent, role, pane_id, status, started_at, ended_at}`）と `panes`（Pipeline の Slot: `{pane_id, agent, role, stage_id, stage_index, slot_label, spawn_status, kickoff_status}`）を持ちます。ユーザーや Agent が手で開いた Pane は Pipeline Slot ではないので含まれません。すべての Pane が並ぶのは `cli_list_targets` です |
| `pipeline_start` | `task`, `pipeline_id`, `workspace_path` | 実行を開始する: 最初の Stage の Pane を開き、Task を渡します。**これは CLI Pane を開き、そのクォータを消費します** — Stage の各 Slot は独自の Context と独自の請求を持つ新しい CLI プロセスであり、後続の Stage は実行の進行に伴って開かれます。まず `pipeline_list` でこのマシンにあるテンプレートと各テンプレートの構成を、`pipeline_status` で既に実行が進行中でないかを読んでください — 推測で踏み出す一歩ではありません。`pipeline_id` は実行するテンプレートで、`pipeline_list` が報告する id です。空なら Workspace が現在選択している Pipeline が走り、何も選択していない Workspace は勝手に選ばず拒否します。`task` はその実行が何のためのものかで、各 Stage の Kickoff メッセージはこのテキストから組み立てられます。ウィンドウ自身の応答 `{ok, result, error}` を返し、`result` は `{pipelineId, stages, workspacePath, state}` を運びます。`ok` が false なら何も始まっていません: 既に実行中（先に Abort）、走らせる Pipeline が無い、あるいは最初の Stage の Pane がすべて Spawn に失敗した、のいずれかです。ウィンドウは呼び出しが返ったという事実ではなく実行自身の状態を報告するため、ここでの ok は「開始したが何も起きなかった」という答えにはなりません |
| `pipeline_abort` | `workspace_path` | ある Workspace で進行中の実行を止めます。Abort は Kill ではなく一時停止です: オーケストレーションが止まり（次の Stage は起動されず、Pane 間のルーティングも行われません）、既に開いている Pane は作業ごとそのまま残るため、ユーザーはウィンドウが表示するバナーから実行を再開できます。何も削除されません。ウィンドウ自身の応答 `{ok, result, error}` を返し、`result` は `{workspacePath, state}` を運びます。`ok` が false は何も中止されなかったことを意味し、通常の理由は実行が進行中でなかったことです — `pipeline_status` がそれを教えます |
| `pipeline_next` | `workspace_path` | ウィンドウが現在の Stage を完了と判断するのを待たず、今すぐ次の Stage へ進めます。**これは CLI Pane を開き、そのクォータを消費します** — 次の Stage の Slot が即座に Spawn され、現在の Stage でまだ動いている作業は待たれないため、その出力は後続の Stage には届きません。まず `pipeline_status` の `current_stage_index` と `total_stages` を読んでください: 最後の Stage では進む先が無く、実行を完了扱いにするのではなく呼び出しが拒否されます。ウィンドウ自身の応答 `{ok, result, error}` を返し、`result` は `{workspacePath, state, stageIndex, stages}` を運びます。`ok` が false なら何も進んでおらず、通常の理由は実行が進行中でないことです |
| `pipeline_resume` | `workspace_path` | Abort または中断された実行を、止まったところから続けます — `pipeline_abort` のもう半分です。記録された実行は最後に完了した Stage の次から拾い直され、その Stage の Pane が Spawn されるので**これは CLI Pane を開き、そのクォータを消費します**が、既に得た進捗は保たれます: `pipeline_reset` や `pipeline_restart` と違い、実行に戻る非破壊的な方法です。実行は開始時の Pipeline に対して再開され、Active な Pipeline が変わっていれば戻されます。そのテンプレートが失われていたり、Stage 数が記録されたインデックスに届かなくなっていた場合は、この実行の Task を無関係な Stage で走らせるのではなく、再開を止めて理由を告げます。`{ok, result, error}` を返し、`result` は `{workspacePath, state, stageIndex, stages}` を運びます。`ok` が false なら何も再開していません — 記録された実行が無いか、既に実行中です |
| `pipeline_reset` | `workspace_path` | **破壊的であり、名前から想像するより広い範囲に及びます。** オーケストレーションを一時停止して Pane を再開可能なまま残す `pipeline_abort` と違い、Reset は Workspace の**すべての** Pane を壊します — Pipeline が開いたもの**も**、ユーザーや他の Agent が手で開いたものもです — そして実行の Task・Stage インデックス・ログを消して Workspace を idle に戻します。その後の再開は無く、Undo もありません。実行がどこまで進んだかは `pipeline_status`、これから閉じられる Pane は `cli_list_targets` で読んでください。実行を止めたいだけなら `pipeline_abort` が作業を残します。`{ok, result, error}` を返し、`result` は `{workspacePath, state, stageIndex}` を運びます |
| `pipeline_restart` | `workspace_path` | **破壊的であり、CLI Pane を開いてそのクォータを消費します。** 現在の実行を捨て — Pipeline が開いた Pane はすべて閉じられ、記録された進捗は破棄されます — 同じ Pipeline を同じ Task で Stage 1 から走らせ直します。つまり既に終わっていた Stage は、支払い済みのうえでもう一度走ります。Undo はありません。Task はまず記録された実行から、次に画面上の Task フィールドから取るため、どちらも無い Workspace は拒否されます。既に `running` の実行がある場合も拒否されます（先に Abort）。まず `pipeline_status` を読んでください: 三つ目の Stage まで進んだ実行は三 Stage 分のやり直しであり、詰まった Stage を越えたいだけなら `pipeline_next` は支払い済みの分を無駄にしません。`{ok, result, error}` を返し、`result` は `{pipelineId, stages, workspacePath, state, stageIndex}` を運びます |

開始と中止は Renderer の仕事です — Backend 自身の `pipeline.start` handler は実行
レコードを書くだけで、各 Stage の Pane はウィンドウが Spawn します — そのためこの
二つの Tool は UI Action Bus（`ui.pipeline.start` / `ui.pipeline.abort`）を通り、その
規則を引き継ぎます: `workspace_path` を開いている生きたウィンドウが必要で、最大 15
秒待ちます。`workspace_path` の振る舞いは他と同じで、Pane 呼び出し元は省略でき、
省略すれば自分の Workspace になります。

`pipeline_next`、`pipeline_resume`、`pipeline_reset`、`pipeline_restart` も同じ理由で
同じ形です — オーケストレーションは Renderer のものなので、それぞれ
`ui.pipeline.next` / `.resume` / `.reset` / `.restart` を通り、同じウィンドウ要件と
15 秒の待機を引き継ぎます。ユーザーがウィンドウで押すボタンそのものを、MCP から
アドレス指定しているだけです。

#### テンプレートを編集する

さらに三つの Tool が、実行の元になる定義そのものを書きます。上の六つと違い、これらは
ウィンドウを**通りません**: Backend 自身の Store に書き、WS handler と同じ
`pipelines.changed` / `stages.changed` / `roles.changed` イベントを Broadcast するので、
開いている Pipelines ウィンドウは自分で更新されます。三つとも読み取り側は
`pipeline_list` です。

| Tool | パラメータ | 動作 |
|---|---|---|
| `pipeline_define` | `op`, `pipeline_id`, `name`, `workspace_path` | Pipeline **テンプレート** — `pipeline_start` が走らせる、名前の付いた順序付き Stage 集合 — を作成・改名・削除・再シードします。ここでの操作は実行を開始も停止も前進もさせません。`{ok, op, pipelines, active_pipeline_id}` を返し、Pipeline を生む op（`create` / `rename` / `reset_builtin`）はさらに `pipeline` を返します。作成された Pipeline は空で、Active にもされないため、`stage_define` で Stage を与えるまで走らせられません。最後に残った一つの Pipeline は削除できません。また Pipeline を削除しても、既に始まっている実行は止まりも巻き戻りもしません — その実行は記録した `pipeline_id` と開いた Pane を保ちます。壊れるのは後からの再開で、指名しているテンプレートがもう無いからです |
| `stage_define` | `op`, `pipeline_id`, `stage_id`, `stage`, `ids`, `workspace_path` | 一つの Pipeline の中の **Stage** を追加・編集・削除・並べ替え・再シードします。Stage は一つの工程で、Pane になる Slot を持ちます: 各 Slot は CLI（`agent_key`）と Role（`role_key`）を指名し、その Pane が起動時に受け取る Kickoff テキストを持ちます。`pipeline_id` を空にすると **Active な** Pipeline を意味します。それは Pipelines ウィンドウが選択しているもので、あなたが読んでいたものとは限りません — 明示してください。`{ok, op, stages, pipeline_id, pipelines, active_pipeline_id}` を返し、`upsert` はさらに `stage` を返します。Pipeline の最後に残った Stage は削除できません |
| `role_define` | `op`, `key`, `new_key`, `label`, `one_line`, `system_prompt` | Slot がキャスティングする **Role** を作成・編集・改名・削除・再シードします。Role は名前の付いた System Prompt で、Slot は `role_key` で一つを指名し、その Slot が開く Pane はその Prompt で起動します。Role はマシン全体でグローバルです — Pipeline ごとでも Workspace ごとでもありません — なのでここでの編集はその Role を指名するすべての Pipeline に届き、範囲を絞る `workspace_path` もありません。`{ok, op, roles}` を返し、`upsert` と `rename` はさらに `role`、`rename` は `repointed_pipeline_ids` も返します。最後に残った Role は削除できません。既に起動している Pane は与えられた Prompt を保ちます。変更が届くのはその Slot で次に開かれる Pane であって、画面にあるものではありません |

**各 `op` が必要とする引数。** この三つを最も誤用しやすいのがここです: `op` が他の
どの引数を必須にするかを決め、足りなければ `ok: false` と
`error_code: "missing_argument"` が返り、何も書かれません。知らない `op` は
`"bad_op"` です。

| Tool | `op` | 必要な引数 | 備考 |
|---|---|---|---|
| `pipeline_define` | `create` | `name` | 空の Pipeline を追加し、生成された id と共に返します。Active にはなりません |
| `pipeline_define` | `rename` | `pipeline_id`, `name` | その場で改名。id も Stage も変わりません |
| `pipeline_define` | `delete` | `pipeline_id` | 破壊的。実行中は拒否されます — 下記参照 |
| `pipeline_define` | `set_active` | `pipeline_id` | Pipelines ウィンドウが表示するテンプレート、および `pipeline_start` が `pipeline_id` 無しで呼ばれたときに使うテンプレートを選びます |
| `pipeline_define` | `reset_builtin` | `pipeline_id` | シードデータを持つのは `default` と `maintenance` だけです。その Pipeline のすべての Stage をシード集合で置き換えます |
| `stage_define` | `upsert` | `stage` | 完全な Stage オブジェクト。`stage["id"]` で照合され、既存の id は上からマージされ（渡さなかったフィールドは元の値のまま）、新しい id は末尾に追加されます。Store は `id`（英数字・ハイフン・アンダースコア・ドットのみ）と空でない `slots` を要求します。形は `{id, title, short_title, question, description, sentinel, recommended_roles, allow_questions, doc_query, slots}`、各 Slot は `{agent_key, role_key, label, kickoff_body, is_commander}`。手探りで組み立てるのではなく `pipeline_list` から一つ読み出して編集してください — ただし `pipeline_list` は意図的に `kickoff_body` を省くので、それだけを元に組んだ upsert は、書き換えた Slot の Kickoff を空にしてしまいます |
| `stage_define` | `delete` | `stage_id` | Pipeline の最後に残った Stage に対しては拒否されます |
| `stage_define` | `reorder` | `ids` | 望む順序での Stage id。挙げなかった id は互いの相対順序のまま末尾に残り、未知の id と重複は無視されます。この順序が**そのまま**実行順です |
| `stage_define` | `reset` | — | 破壊的: `default` と `maintenance` には組み込みの Stage が戻りますが、自分で作った Pipeline には**何も戻りません** — こうして Reset された独自 Pipeline は空になり、走らせられなくなります。Undo は無いので、また欲しくなる可能性があるなら先に `pipeline_list` で読み出しておいてください |
| `role_define` | `upsert` | `key`, `label`, `system_prompt` | `key` は小文字英字・数字・アンダースコア・ダッシュの 1〜32 文字。**Role 全体を置き換えます**: 渡さなかった `label` や `system_prompt` は空で書かれ、そして空は拒否されます — これが「中途半端な upsert が Prompt を消す」ことを止めている唯一のものです。`one_line` は Label の隣に表示される短い説明です |
| `role_define` | `rename` | `key`, `new_key` | 改名と、旧 key を指名していたすべての Stage Slot の張り替えを一手で行うので、Slot がどこも指していない中間状態は生じません。ここでの `label` / `one_line` / `system_prompt` は任意で、省いた分は既存の Role から引き継がれます。`key` が存在しない（`not_found`）、または `new_key` が既に使われている（`role_key_exists`）場合は拒否されます。二つの Role を統合すれば、片方の Prompt を黙って落とすことになるからです |
| `role_define` | `delete` | `key` | いずれかの Stage Slot がまだその Role を指名している間は拒否されます — 下記参照 |
| `role_define` | `reset` | — | 破壊的: 独自のものも含めてすべての Role を捨て、組み込みの集合を戻します。シード集合に無い Role を指名していた Slot は、宙ぶらりんのままではなく空にされるので、Pipeline は生き残りますが、それらの Slot は Role を失い、キャスティングし直しになります。Undo はありません |

**実行中に編集した場合。** その Workspace の実行が `running` 状態の間、
`pipeline_define` の `delete` と `set_active` は即座に拒否され、`reset_builtin` は
進行中の実行がその Pipeline を使っている間は拒否されます。`stage_define` の四つの op は
**すべて**同じように拒否されます — 実行中に編集された Stage リストは、その実行の足元で
流れを変えてしまうからです。拒否は `ok: false` と
`error_code: "pipeline_running"` で、何も書かれていません。実行は開始時に記録した
Pipeline と照合するため、その Pipeline を明示してもガードは抜けられません。他の
Workspace の実行や、別の Pipeline を走らせている実行には影響しません。
`workspace_path` はどのプロジェクトの実行を照合するかを指すもので、既定は呼び出し元
Pane の Workspace です。Pane を持たない呼び出し元が何も渡さなければ、ガードは一切
掛かりません。二つの実行の間に着地した編集は**次の**実行の動きを黙って変えるので、
それこそがユーザーに知らせるべきケースです。

`role_define` には実行ガードが**ありません**: Pipeline が走っていても Role の編集は
許されます。その `delete` は別のものでガードされます — いずれかの Stage Slot がまだ
その Role を指名している間は拒否され、その拒否（`error_code: "role_in_use"`）は該当の
Slot を `usages` に並べるので、`stage_define` の `upsert` で張り替えるか、改名に切り替え
られます。削除された Role を指す Slot は Role 注入に失敗し、その Stage の Pane は理由を
示すものが画面に何も無いまま空の Prompt の前で止まります。この拒否はそのためにあります。

この三つが返す他の `error_code` は `not_found` と `invalid`（Store が値を拒否した）です。
どの失敗でも何も書き込まれません。

### スケジューラ

CLI Pane への定時メッセージ。この 6 つの Tool は、スケジュールパネルの「NAVIDE JOBS」
（`scheduler.*` WS メッセージ）と同じバックエンドのスケジューラを操作するため、ここで作った
job はすぐにパネルにも表示されます —— 変更のたびに `scheduler.changed` がブロードキャスト
されます。job は **Navide の実行中にだけ** 発火します。App を閉じていた間に逃したスロットは、
次回起動時に一度だけ実行される（`catch_up: "once"`、既定）か、破棄されます（`"skip"`）。
無人実行はクォータを消費します：各 job は 1 日 `max_runs_per_day` 回（既定 24）までで、
失敗時は 30s → 1m → 5m → 15m → 60m でバックオフします。

| Tool | パラメータ | 内容 |
|---|---|---|
| `scheduler_list` | — | `{ok, jobs, now, limits}` —— 変更できない job も含めてすべてを返します。各 job には `owner`（`{kind: "user"}`、`{kind: "pane", pane_id, pane_name, workspace}`、`{kind: "external"}` のいずれか。agent の定期 job には `expires_at` も付きます）、`updated_by`、`owner_gone`（作成した Pane が閉じられた）、`editable`（変更できるか）が付きます。`limits` は `{agent_enabled_per_owner, agent_enabled_total, agent_enabled, agent_min_every_ms, agent_max_runs_per_day, agent_runs_per_day, agent_runs_today, agent_expire_ms, agent_once_keep_ms, yours_enabled}` |
| `scheduler_upsert` | `job` | job を作成（`id` なし）または更新（`id` あり）。`{ok, job}` を返し、定義が不正なら `{ok: false, error}`。更新時は変える項目だけを送れば済みます：送らなかった項目は保存済みの値のまま、`policy` はキーごとにマージ、送った `action` は丸ごと検証されます。`schedule` は `{kind: "every", every_ms, anchor_ms?}`、`{kind: "daily", at: "HH:MM", tz}`、`{kind: "weekly", days: [1..7], at, tz}`、`{kind: "once", at_ms}` のいずれか。`{kind: "once", in_ms}` も受け付け、保存時に `at_ms = now + in_ms` に換算します（現在より 1 分以上前、または 10 年より先は不可）。once job は一度だけ実行され、結果にかかわらずその後自動で無効になります。「1 時間後に起こして」は `every` ではなく `{kind: "once", in_ms: 3600000}` です。`action` は `{kind: "message", workspace, pane_id?, pane_name?, text}`。`policy` は省略可能な `{catch_up, max_runs_per_day, timeout_s}`。Pane からの呼び出しでは `workspace` の既定は自分の Workspace で、Pane を指定しない action は呼び出し元自身の Pane が対象になります。対象にできるのは自分の Workspace の Pane だけです。更新できるのは自分が作成した job だけです |
| `scheduler_remove` | `id` | 自分が作成した job とその実行履歴を削除 |
| `scheduler_set_enabled` | `id`、`enabled` | 一時停止または再開。再開時は過ぎたスロットを実行せず、次のスロットを待ちます。時刻を過ぎた once job は再開できず `{ok: false, error}` を返すので、新しい時刻を設定してください。自分が作成した job のみ。再開は有効 job の上限に数えられます |
| `scheduler_run_now` | `id` | 今すぐ一度実行し、終了を待たずに `{ok, enqueued}` を返します。失敗バックオフを解除します。自分が作成した job のみで、この実行は agent の 1 日の合計に数えられます |
| `scheduler_runs` | `id`、`limit` | 実行履歴（新しい順）：`{id, job_id, started_at, ended_at, status, reason, detail}`。どの job の履歴も読めます |

1 回の実行は `cli_send(open_target=True)` そのものです：placeholder に回収された Pane は
先に開かれ、作業中の Pane には通常どおりキューされます。`pane_id` は 1 つの Pane を固定し、
その Pane がもう存在しなければ実行は `target_gone` としてスキップされ、同名の別 Pane に
送られることはありません。その他のスキップ理由 —— `no_window`、`busy`（この job の前回の
メッセージがまだキューにある）、`budget`、および後述の `budget_global` と `expired` —— は
エラーではなく、バックオフも起きません。

**所有権。** 各 job には作成者（`owner`）と最終変更者（`updated_by`）が記録されます。Navide の
ウィンドウで作った job はユーザーのもの、これらの Tool で作った job は呼び出した agent のもの
です。agent が更新・削除・一時停止／再開・`run_now` できるのは自分の job だけで、それ以外は
`{ok: false, code: "SCHEDULER_NOT_OWNER", owner, error}` を返します。一覧と実行履歴は誰でも
読めます。Navide のウィンドウはユーザーとして動作し、どの job でも変更できます。job を作成した
Pane が閉じられると、job は動き続けますがユーザーの管理になり（`owner_gone: true`）、同名の新しい
Pane は引き継ぎません。パネルには「自分のものにする」が表示されます。作成者の記録が始まる前から
ある job はユーザーのものです。Pane が対象にできるのは自分の Workspace の Pane だけです
（それ以外は `{ok: false, code: "SCHEDULER_CROSS_WORKSPACE", error}`）。Pane の身元を持たない
呼び出し元（host や外部クライアント）も agent と同じ扱いで、すべて 1 つの `{kind: "external"}`
所有者を共有します。自分の Workspace を持たないため、Workspace の制限は適用されません。

**agent の job の上限**（ユーザー自身の job には上限はありません）：

| 上限 | 値 | 超えたとき |
|---|---|---|
| agent ごとの有効な job | 10 | 追加や有効化は拒否（`limit: "per_owner_enabled"`） |
| agent 全体の有効な job | 100 | 追加や有効化は拒否（`limit: "global_enabled"`）。ユーザーの job は数えません |
| 最短間隔 | `every_ms` ≥ 300000（5 分）、`max_runs_per_day` ≤ 288 | 保存は拒否（`limit: "min_every_ms"` または `"max_runs_per_day"`） |
| agent の job 全体の 1 日の実行回数 | 300（ローカルの日付単位） | 予定のスロットは `budget_global` としてスキップ。agent の `run_now` は拒否され（`limit: "agent_runs_per_day"`）、`run_now` も合計に数えられます。job を削除してもリセットされません |

上限を超えると `{ok: false, code: "SCHEDULER_LIMIT", limit, max, used, error}` を返します。
`max` は境界値です（`min_every_ms` では最小値）。agent の定期 job は、所有者が最後に保存・有効化
してから、または誰かが再度有効化してから 7 日後に自動で無効になります（スキップ理由 `expired`）。
ユーザーは期限切れにならないよう保持できます。agent の once job は実行から 30 日後に削除されます。

### CLI の権限

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_permission_settings` | `yolo`, `workspace_path` | CLI に権限プロンプトをスキップさせるグローバルスイッチを読む、または変更します。引数なしで呼べば読むだけ、`yolo` を渡せば設定します。ウィンドウ自身の応答 `{ok, result, error}` を返し、`result` は `{yolo, agents}`。`agents` は CLI ベンダーごとに一件で `{agent, mode, skipFlag}` です。`ok` が false で `error_code: "ui_no_window"` は、尋ねられる Navide ウィンドウが開いていなかったことを意味します |

「Yolo」は、Navide が Spawn 時に CLI へ渡す権限バイパスのフラグ（claude の
`--dangerously-skip-permissions` と、各ベンダーの相当品）に対する Navide 側の呼び名です。
これを有効にするとは、Navide が起動する CLI が、ユーザーの Workspace でファイルを編集し、
シェルコマンドを実行し、ネットワークにアクセスする前に尋ねるのをやめ、自分の判断で動く
ということです。それはユーザーが下す判断です — 自分の作業をプロンプトの先へ通すために
有効化してはいけません。

**これは Pipeline スコープでも Workspace スコープでもありません。** アプリ全体で
**一つ**の設定で、ユーザー設定と共に保存され、CLI を起動するすべての経路が読みます:
手で開く Pane、Pipeline の Slot、ウィンドウ内蔵の CLI パネル、再開も復元も同じです。
変更が効くのは**それ以降**に起動される CLI で、既に走っているプロセスは起動時のフラグを
保ち続けるため、オフにしても既に動いている Pane には遡って届きません。ここでの
`workspace_path` は**アドレス指定専用**です: どのウィンドウに尋ねるかを選ぶだけで、
変更の適用範囲を決めるものではありません。どのウィンドウも同じ答えを返し、どれを通して
書いてもすべてに届くため、既定は呼び出し元 Pane のウィンドウで、Pane を持たず何も
指名しない呼び出し元は開いているどれか一つのウィンドウに当たります。別のパスを渡せば
届くようなプロジェクト単位版は存在しません。

**`yolo` だけを読むと誤解します。** 各ベンダーは自分の `mode` を持ち、それはグローバル
スイッチを**上書きします**: `inherit` は従い、`force-on` と `force-off` は無視します。
つまり `yolo: true` はすべての CLI がバイパスすることを意味せず、`yolo: false` もどれも
しないことを意味しません。CLI ごとの答えは `agents[].skipFlag` — そのベンダーが今まさに
起動されるときに実際に付くフラグで、空文字列は「付かない」です。バイパスフラグを一切
持たないベンダー（grok、opencode、pi）は、スイッチがどうであれ常に空です。

## Resources

三つの読み取り専用 URI です。Resource は Client がユーザーの代わりに一覧・読み取り
するもので、会話に添付するのは人の行為であり Agent が説得されて行うものではありま
せん。そのためこの三つは厳密に読み取り専用であり、いずれも既存の Tool が提供する
データの別の見え方であって、二つ目の実装ではありません。

| URI | 名前 | 何を返すか |
|---|---|---|
| `navide://workspace/plans` | `workspace_plans` | `{workspace_path, plans}` — 自分の Workspace の `.agent-team/plans/` にある Plan Document の索引。`plan_list` が返すのと同じ一覧を JSON で |
| `navide://workspace/plan/{rel_path}` | `workspace_plan` | 一つの Plan Document: `{rel_path, meta, html}`。`plan_read` 自身のパスガードを通して読まれます |
| `navide://panes` | `panes` | 指示を送れる CLI Pane。`cli_list_targets` が返すのと同じ名簿を JSON で |

Resource の読み取りは Tool 呼び出しとまったく同じように認証されます: 同じ呼び出し元
が解決され、配線されていない呼び出し元は同じように拒否されます。二つの Workspace
Resource は呼び出し元自身の Workspace を取り、別のプロジェクトを指名するパラメータ
はありません。したがってこれらは Pane 呼び出し元のためのもので、Pane 識別を持たない
外部 Client には解決すべき Workspace がありません。

**`rel_path` は URI の単一セグメントです。** SDK は Template パラメータを `[^/]+` で
マッチするため、生の `/` を運べません: 素のファイル名はそのまま使えますが、完全な
`.agent-team/plans/<file>` 形式は Percent-encode が必要です
（`.agent-team%2Fplans%2F<file>`）。値は解決される前に decode されますが、それこそが
ガードを飾りでなく実効的なものにしています — `%2E%2E%2F` はファイルシステムに届く
時点で `../` であり、`plan_read` は plans サブツリーから出るパスをすべて拒否します。

## Prompts

**ユーザー**が埋める三つのテンプレートであって、モデル向けの説明ではありません:
Client はこれらを人に、たいていはスラッシュコマンドとして提示し、返ってきたものが
その人のメッセージに挿入されます。したがって各プロンプトは、送信されればそれ単体で
成立する、埋め込み済みの指示としてレンダリングされます。

| Prompt | 引数 | 何を求めるか |
|---|---|---|
| `delegate_to_pane` | `target`, `task` | `target` がアドレスする CLI Pane に `cli_send` で `task` を送り、自分で作業せずに止まって返事を待つこと。そのアドレスが名簿に無ければ先に `cli_list_targets` を実行し、似た名前を推測せずどの Pane のことかユーザーに尋ねること。送るメッセージの中で、`target` に対し完了したら `cli_send` で報告するよう伝えること |
| `start_pipeline` | `task` | この Workspace の Pipeline を `task` に対して開始すること。ただしその前に `pipeline_status` で既に実行が進行中でないかを、`pipeline_list` でどの Stage が開かれるかを読み、何が開かれようとしているかをユーザーに伝え（これは CLI クォータを消費します）、go の合図を待つこと。その後、実行が本当に開始されたかを報告し、されなかった場合はウィンドウが挙げた理由を述べること |
| `review_plan` | `rel_path` | `rel_path` の Plan Document を `plan_read` で読み、レビュアーとして通し、Plan が主張していることはコードと突き合わせて確認すること。発見は一件につき一つ、行動に移せる具体性で `plan_add_note` によって Document 自身に記録し、ここで報告するだけにしないこと。最後に、その Plan が現状のまま承認できるかを述べること |

## Pane の id は Pane より長く生きる

CLI Pane の接続 URL は Pane が生成された瞬間に一度だけ書かれ、CLI プロセスは動いて
いるかぎりそれを持ち続けます。その中の `pane=<id>` はその瞬間の Pane id です。そし
て Pane id は中のプロセスではなく Pane そのものに属します。ウィンドウのリロード、
Run Group のデタッチ、そしてそれを戻す操作は、いずれも動き続けている同じ CLI の周り
に Pane を作り直して新しい id を与えるので、URL には古い id が残ります。

その古い id は今も有効です。ウィンドウがその行き先を記録するため、古い id を持つ呼
び出しは「そのプロセスが実際に結びついている Pane」として応答されます。`plan_*` が
既定にする Workspace も、`cli_list_targets` の `you` も、`cli_send` が裸の名前と自
分宛て送信を判定する identity も同じです。二度リロードしても連鎖は切れず（各ホップ
は現在の Pane に畳み込まれます）、id が Pane について別の Workspace に移ることは決し
て許されません。

id は identity であると同時にアドレスでもあります。`cli_send`、
`cli_send_and_wait`、`cli_read_log`、`cli_get_status`、`cli_wait_idle` はいずれも
`pane_id` を取り、それぞれのアドレス引数の代わりに使われます。同じ Workspace で名前
を共有する二つの Pane の一方に届く唯一の方法がこれです。両方に一致する名前は推測さ
れるのではなく `ambiguous-target` として拒否されるからです。解決は同じテーブルを通る
ので、リロードやデタッチを越えて生き延びた id は、それが付いていった先の Pane を指し
ます。越えられないのは**新しい** CLI の周りに作り直された Pane です。その経路は以前
の id を一切申告しないため、これらの Tool は `unknown-pane-id` を返します。これは
「`cli_list_targets` から新しい id を読み直せ」であって、「その Pane はもういない」で
はありません。リモートの Pane の id は別のマシンのレジストリが鋳造したもので、ここで
言う id ではないので、クロスデバイスの宛先は依然として名前で指定します。

Pane の [Push Channel](inter-cli-messaging.md#push-channel) もおおむね同じように付
いていきますが、一つ例外があります。ウィンドウのリロードでは保持され、デタッチされ
たウィンドウから Run Group が戻る場合も保持されます。しかし**デタッチ**では保持され
ません。Pane を渡す側のウィンドウが、受け取る側が Pane を要求する前に Pane を——そ
して Channel も一緒に——手放すためで、デタッチされた Pane はその CLI を再起動するま
で Channel が存在しなかった頃と同じく入力欄に打ち込まれます。claude Pane は影響を受
けません。その hook は次のターン終了時に自分で張り直します。

どの id をどの id が引き継いだかは Navide のウィンドウが申告し、そのまま信用されま
す。デタッチの最中は申告される id がまだ生きていて、手放そうとしているウィンドウが
所有しているため、「生きている Pane に対する主張」と「正当な引き継ぎ」はバックエン
ドから区別できず、拒否ではなくログに記録されます。取り返しがつかない一点だけは別途
拒否されます。接続中のウィンドウがミラーしている Pane は、誰が要求しても Push
Channel を手放しません。

引き継ぎを伴わずにその警告が出る既知のケースが一つあります。Run Group の一つがデタ
ッチされている状態でメインウィンドウがリロードすると、その Group が別の場所にあると
知る前にその Group の Pane を復元してしまい、子ウィンドウの id を一時的に主張しま
す。ウィンドウに知らされた時点で自動的に是正され、子ウィンドウの Push Channel が奪
われることはありません。

いまも拒否されるのは、どこも指していない id です。Pane が閉じられたか、それを所有し
ていたウィンドウが忘れられるほど長く不在だった場合です。名乗れる identity が残って
いないので、このエンドポイントのすべての Tool が `this pane's id is stale` と答えま
す。対処は Pane を開き直すことです。（これは上のキュー中メッセージに付く `stale` と
は別物で、あちらは「2 分以上待っている」ことしか意味しません。）

これは下の Tool **リスト**の問題とは別です。リストは Client が接続時に取った
スナップショットで Navide には更新手段がありませんが、id は呼び出しのたびに Navide
が解決しています。

## Tool リストは一度だけ読まれる

MCP Client は接続時に Server の Tool リストを尋ね、Navide の `/plan-mcp` はその後
それを変更することがありません。つまり **Client がその瞬間に見たものが、そのまま
持ち続けるもの**になります。

- **CLI Pane** は、その CLI Process の起動時にリストを Snapshot します。Navide が
  更新されたときすでに動いていた Pane は、もう存在しない Backend と話している状態
  です。新しい Navide が追加した Tool やパラメータを取り込むには、Pane を開き直して
  ください。
- **外部 Client** は、再接続するまでリストを保持します。いずれにせよ Connection URL
  は再起動をまたぐと変わる（Port は起動時に選ばれる）ため、これは通常それだけで
  解消します。

アップグレード後、Navide はそれを一度だけ知らせます。ステータスバーの Announcement
フィードに「MCP tools may have changed」という項目が現れ、置き換えられた Version を
示します。これは、この Backend が実際に前回とは異なる Version で起動したときにだけ
現れます。初回インストール時にも、通常の再起動時にも現れません。

### なぜ Navide は Client に通知しないのか

Protocol にはこのための仕組みがあります。Server が `tools.listChanged` Capability を
宣言し、Tool の集合が変わったときに `notifications/tools/list_changed` を送ると、
それを扱う Client は Session の途中でリストを読み直します。Navide がこれを使えない
理由は、互いに独立した 2 つあります。

**Transport に Push する先がありません。** `/plan-mcp` は streamable HTTP を
Stateless モードで、JSON 応答で動かしています。Transport は Request ごとに構築されて
破棄され、開いたままの Stream は保持されません。この構成では、Server 発の通知が
Client へ届く経路がありません。MCP SDK はそれを長命な Stream 宛に送ろうとし、
見つからず、破棄します。届くようにするには Session 指向のモードで動かす必要があり、
それはこの Endpoint が意図的に持たない状態です。（2026-07-28 版の仕様は Protocol
レベルの Session を廃し、これらの通知を Client が開く `subscriptions/listen` Stream
へ移しました。どちらにせよ開いたままの Stream です。）

**半分の CLI は無視します。** 各 Client 自身のソースまたはドキュメントに対して確認、
2026-08-17:

| CLI | `list_changed` で Tool リストを読み直すか？ |
|---|---|
| Claude Code | する（2.1.0 以降） |
| GitHub Copilot CLI | する |
| OpenCode | する |
| Grok | する |
| Codex CLI | しない — 通知を Log に記録するだけで何もしない |
| Cursor（`cursor-agent`） | しない — 更新は `/mcp` による手動操作 |
| Qwen Code | しない — この Fork は上流の Gemini CLI にある Handler を落としている |
| Kimi CLI | しない — 通知処理そのものがない |

いずれにせよ通知すべきことは何もありません。`/plan-mcp` の Tool はすべて Import 時
に登録され、その集合は Backend の実行中に変わらないからです。Pane を開き直すことが
解決策のすべてであり、だからこそ工学的に回避するのではなくドキュメントに記して
います。

## CDP デバッグ（エスケープハッチ）

Settings → MCP → External access には **Chrome DevTools Protocol** の Toggle も
あります（[`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts)、設定は
`userData/cdp-debug.json`）。有効化には App の再起動が必要で — Electron は
`--remote-debugging-port` を App の Ready 前に設定した場合しか受け付けません —
デバッグ Port は `127.0.0.1` にのみ Bind されます。

これは Fallback であって主要な統合経路ではありません。上の Tool カタログが
カバーするものはすべてそちらを使ってください。CDP が存在するのはカバーされない
もののためです。実際にレンダリングされたウィンドウのスクリーンショットを撮る、
登録された `ui.*` Action がないものを操作する、といった用途です。できることの
大きさゆえに（下記参照）、最後の手段として扱ってください。

## セキュリティモデル

| これを有効にすると… | …こうなります |
|---|---|
| **Allow external MCP clients** | 有効な間、このマシン上で動作するあらゆるものが Navide を制御できます。Pane の Spawn と Close、開いているどの Workspace のどの CLI Pane への指示送信、Plan/Git/Pipeline ウィンドウのオープン、そして別の Pane の会話 Log の読み取りです。 |
| **CDP debug** | 有効な間、このマシン上で動作するあらゆるものが Navide の Renderer 内で任意のコードを実行できます。どの Tool 契約にも縛られない、完全なリモートデバッグアクセスです。 |

実務上の注意:

- どちらの Toggle も `127.0.0.1` にのみ Bind され、LAN やリモートへ露出することは
  ありません。ただし共有マシンでは、「このマシン」には他のすべてのローカル
  ユーザーアカウントと、あなたの権限で動作する他のすべての Process が含まれます。
- 外部 Token は Bearer Secret です。Connection URL を持つ者は誰でも、Token を
  再生成するまで完全な外部アクセスを持ちます。Token は App Data Directory 配下の
  `plan_mcp_auth.json` に平文で保存されます。
- これらの Tool を通じた Filesystem への書き込みは、Backend の他の部分が使うのと
  同じ Path Guard（`fs_service._resolve_safe`）で引き続き制限されます。Plan Tool は
  Workspace の `.agent-team/plans/` の内側にしか書き込めません。UI Action と CDP
  には同等の Sandbox がありません。UI Action は `App.vue` の Handler が行うことを
  そのまま行い、CDP は無制限のコード実行です。
- それを必要とした作業が終わったら、外部アクセスと CDP は元どおり無効に戻して
  ください。どちらも既定で有効にしておくことを意図したものではありません。

関連: Navide 全般の Local-first なデータ姿勢については
[プライバシーとデータフロー](privacy.md)を、すべての Pane が自動的に得る二つの
方向については App 内の Settings → MCP にある「說明」タブを参照してください。
