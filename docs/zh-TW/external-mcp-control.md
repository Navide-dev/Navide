# 外部 MCP 控制

[English](../en-US/external-mcp-control.md) | 繁體中文 | [日本語](../ja-JP/external-mcp-control.md) | [文件中心](README.md)

Navide 提供一個 MCP（Model Context Protocol）Endpoint `/plan-mcp`，在 Navide
Pane 中執行的 CLI Agent 會自動使用它。同一個 Endpoint 也可以開放給 Navide
自身 Process Tree 以外的 Client —— 一段 Script、在別處執行的 AI Agent，或任何
支援 MCP 的 Tool —— 讓它可以驅動執行中的 Navide 視窗：開啟 Pane、呼叫 UI
Action、讀取另一個 Agent 的對話記錄，以及管理 Plan 文件。

這項功能預設關閉。開啟它代表**你 Mac 上任何執行中的 Process 都能控制
Navide** —— 啟用前請先閱讀[安全模型](#安全模型)。

每個 Pane 本來就自動具備的另外兩個方向（Navide 把 Tool 交給自己的 CLI
Agent，以及 Navide 在 Pipeline 執行期間使用外部文件 MCP Server），請見 App 中
Settings → MCP 底下的「說明」分頁
（[`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)）。
本文件涵蓋的是第三個、需要主動啟用的方向：由外部 Client 控制 Navide。

## 連線方式

1. 開啟 **Settings → MCP → External access**，開啟 **Allow external
   MCP clients**。
2. 複製 **Connection URL**。格式如下：

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` 是 Backend 目前的 Port（在啟動時動態選定，因此 URL 會隨重新啟動
   而改變 —— 重新啟動 Navide 後請重新複製），`<token>` 則是只限外部呼叫端使用
   的 Bearer Secret。
3. 將你的 MCP Client 以 **streamable HTTP** 指向該 URL。不需要額外的 Handshake
   或註冊 —— 每一次 Tool 呼叫都由 URL Query String 中的 Token 驗證。
4. 同一個面板中的 **Regenerate token** 會立即讓舊 Token 失效並產生新的；
   若 URL 可能外流就使用它。

這個 Endpoint 只接受三種呼叫端憑證：Pane 自己的憑證（Navide spawn claude/codex
Pane 時產生）、Backend 自身的內部「host」憑證（供其自有 CLI 接線使用），以及
上述的外部憑證 —— 由 Settings 的開關控管。外部呼叫端沒有 Pane 身分，因此也
沒有自己的 Workspace：每個定址到 Pane 的 Tool（`cli_send`、`cli_send_and_wait`、
`cli_read_log`、`cli_get_status`、`cli_wait_idle`）都必須使用完整的 `<folder>/<pane>` 形式，
而不是裸的 Pane 名稱（或是給一個 `pane_id`：它指名唯一一個 Pane，本身就已經是完整
限定的，因此不受這條規則約束）；每個定址到 UI 狀態（`ui_invoke`、`ui_snapshot`、
`ui_list_actions`）或 Plan 文件（`plan_*`）的 Tool 都必須明確給定
`workspace_path` —— 以 Pane 身分執行的呼叫端可以省略，並取得該 Pane 自己的
Workspace。沒有 Pane 也意味著沒有分頁群組：host 與外部呼叫端呼叫 `cli_send` 的
`to: "group"` 廣播會以 `no-group` 被拒絕 —— 它既沒有自己的群組可以扇出，也沒有視
窗可以問。請改成逐一定址，或用 `pane_id`。

實作：[`mcp_server/server.py`](../../backend/agent_team_backend/mcp_server/server.py)
（Tool）、[`mcp_server/auth.py`](../../backend/agent_team_backend/mcp_server/auth.py)
（憑證儲存，位於 App Data 目錄下的 `plan_mcp_auth.json`），以及
[`mcp_server/wiring.py`](../../backend/agent_team_backend/mcp_server/wiring.py)
（Pane／host 接線 —— 外部 Client 不需要）。

## Tool 目錄

### Plan 文件

| Tool | 參數 | 功能 |
|---|---|---|
| `plan_list` | `workspace_path` | 列出 `.agent-team/plans/` 底下的 Plan 文件：`rel_path`、`name`、`stage`、`overview`、`todos` 摘要、`mtime` |
| `plan_read` | `workspace_path`、`rel_path` | 讀取單一 Plan 已解析的 meta 與原始 HTML |
| `plan_create` | `workspace_path`、`name`、`overview`、`todos` | 依 Template 建立 Plan，起始 stage 為 `draft` |
| `plan_update_stage` | `workspace_path`、`rel_path`、`stage` | 設定 stage：`draft`、`in-review`、`approved`、`in-progress`、`done`、`abandoned` |
| `plan_update_todo` | `workspace_path`、`rel_path`、`todo_id`、`status` | 設定單一 todo 的狀態：`pending`、`in-progress`、`done`、`skipped` |
| `plan_add_note` | `workspace_path`、`rel_path`、`text`、`author?`（`ai`\|`user`，預設 `ai`） | 附加一則 Review Note |

這裡必須給 `workspace_path`，因為外部 Client 不是 Pane；Pane 呼叫端省略它時，
這些 Tool 會使用該 Pane 自己的 Workspace，而那正是 Plan 視窗用來解析 Plan 的
依據。

當 `workspace_path` 不符合任何 Live Pane 的 Workspace 時，`plan_create` 會回傳
`warning` 欄位 —— 檔案仍會寫入，但 Navide 的 Plan 視窗找不到它。

`plan_list` 回傳的是一個 List，而 MCP 傳遞 List 的方式是**每個項目一個 Content
Block**，不是單一 JSON 陣列。把這些 Block 串接起來一次解析會出現 `Extra data`
錯誤；請逐個 Block 各自解析，或改讀該次呼叫的 `structuredContent`。這裡其他每個
Tool 都回傳單一物件，因此這個問題只會在 `plan_list` 上出現。

### CLI Pane —— 傳訊與 Spawn

這些 Tool 進入的是與 Agent 印出裸行 `---MSG-START---` 區塊相同的遞送佇列；
[CLI 之間的訊息傳遞](inter-cli-messaging.md)
文件說明了它們共用的位址、Idle 閘門與防護機制。

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_list_targets` | — | 列出可定址的 CLI Pane：`name`、`address`、`pane_id`（每個 `ui.pane.*` action 都吃這個鍵，也可以在下面那幾個 Pane Tool 上取代 `address`）、`workspace_path`、`same_workspace`、`busy`、`realized`（還原用 placeholder 為 false：背後沒有 CLI 在跑，所以永遠 busy，訊息會停到有人打開它——`ui.pane.open`，或 `cli_send(open_target=true)`）、`hold_reason?` |
| `cli_whoami` | — | **僅限 CLI Pane。** 自己的身分，形狀與名冊描述別人時完全相同：`{ok, caller, name, address, pane_id, workspace_path, agent_key, busy, offline, realized, delegation_hint, hold_reason?, surface?, window_kind?, spawned_by?, waiting_on_me?}`。`delegation_hint` 重述派工原則（見下方 `cli_open_agent`），給沒讀過 server instructions 的 Pane 看。`pane_id` 是所有 `ui.pane.*` 動作唯一接受的鍵，所以這是 pane 能對自己動作的前提；`spawned_by` 是開出你的那個 pane（它關掉後回 `{pane_id, gone: true}`）|
| `cli_send` | `to`（Pane 位址，或 `"group"` 表示廣播）、`text`、`wait_for_delivery_s=0`（上限 120）、`pane_id?`、`reply_to?` | 在另一個 Pane 進入 Idle 後遞送一則指令（忙碌則排入佇列）；回傳 `msg_key`，若有等待則一併回傳它的結果。寄給一般 Terminal Pane（`agent_key: "terminal"`）時文字會裸打進去，**以使用者的權限當成 shell 指令執行**；`"group"` 會略過 Terminal，且 Terminal 會拒絕聊天管道來的內容 —— 見[一般 Terminal Pane](inter-cli-messaging.md#一般-terminal-pane) |
| `cli_check_message` | `msg_key` | 某次 `cli_send` 的結果：`{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_cancel_message` | `msg_key` | 收回一則你送出、但還沒送進去的訊息。由擁有收件佇列的視窗裁決：還在排隊就丟棄、狀態轉為 `cancelled`；已經開始投遞則忽略撤回並回報它最終的狀態。撤回不是失敗，也不會寫任何通知回給你。回傳 `{ok, msg_key, status, reason?}` |
| `cli_inbox_summary` | — | 你自己送出、目前卡住或失敗的訊息：`{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20`（上限 200） | **僅限 CLI Pane。** 目前排給*你*、還沒送進來的訊息：`{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]}` |
| `cli_read_incoming` | `uid=""`、`limit=5`（上限 20）、`include_delivered=false`、`peek=false` | **僅限 CLI Pane。** 寄給你的訊息**全文**——`cli_pending_incoming` 只給 200 字元且壓平空白：`{count, messages: [{uid, sender, status, kind?, content, age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}], note?}`。**預設讀取即消費**，讀過的訊息不會再注入你的輸入框；`peek: true` 只讀不消費。消費採「先保留、後釋放」，釋放若遺失，訊息會退回佇列並可能再送達一次；`consumed` 逐則回報，未消費的原因寫在 `note` |
| `cli_send_and_wait` | `to`、`text`、`timeout_s=60`（上限 120）、`pane_id?` | `cli_send` 再加上等待該回合結束；回傳 `cli_wait_idle` 的結果，外加 `{ok, target, msg_key}`  **遠端 Pane**：送出與送達閘門與本機相同（`rejected` 仍與 `failed` 分開）；等待那半用名冊狀態字，弱點與 `cli_wait_idle` 相同。 |
| `cli_open_agent` | `agent`、`name`、`task`、`workspace_path`（非 Pane 呼叫端必填）、`model`、`effort`、`pane_id?`、`session_id?`、`run_group_id?` | 帶著一項任務 Spawn 新的 CLI Pane；回傳 `{ok, name, address, pane_id}`，若該次 Spawn 跨過 Advisory 門檻則另附 `advisories`。**派工原則**（server instructions 也有同一句）：會改檔案、跑超過幾分鐘、或使用者可能想看、中斷或接手的工作，要派給這裡開出的 Pane —— 不是 Agent 自己的 subagent 機制（Claude Code 的 `Agent`／`Task` 工具）。Pane 在 Navide 裡看得到、跑到一半可以打開、比呼叫端的 Session 活得久；subagent 是只交回一段摘要的黑盒。純唯讀、整個結果只有一段話的短查詢仍適合用 subagent。`model` 與 `effort` 為選填，該 CLI 不支援時會「拒絕」而非忽略，Pane 不會悄悄用別的模型啟動。多數 CLI 接受 model；接受獨立 effort 的較少，其餘把 effort 編在 model id 裡（`gpt-5.3-codex-high`）。model id 不做驗證（每次改版都會變），effort 則會對照該 CLI 的合法值檢查。**`agent: "terminal"`** 會開一個一般登入 shell Pane：`task` 可省略 —— 是提示字元出現後打進去一次的指令列，後面不附加任何東西（沒有回報說明；shell 無法回報）—— 而 `model`、`effort`、`session_id` 會被拒絕。指令絕不重打，所以無法確認的 kickoff 會回 `unverified`；重送前先讀 `cli_read_log`，因為重送會讓指令再跑一次 |
| `cli_close_agent` | `target`、`pane_id?` | 關掉一個 Pane —— `cli_open_agent` 的另一半。**這會直接終結對方的工作**：Pane 與它的 PTY 一併消失，正在跑的回合跟著死掉，排給它的訊息永遠不會送達，而且無法復原 —— 關掉的 Pane 是 Session 沒了，不是暫存起來。動手前先用 `cli_get_status` 看它是不是正在做事；`cli_interrupt` 是比較軟的一階，`cli_send` 更軟（它會等回合做完）。回傳 `{ok, target, name, closed, advisories?}`，`advisories` 說明這次關閉的代價，而且是別人不會回報的那些：Pane 正在回合中、有訊息排在它的佇列裡、它底下有子 Pane 現在變成孤兒。這些都在 Kill 之前先蒐集，因為事後就再也問不到了。僅限本機 Pane：`<device>/<workspace>/<pane>` 這種位址會以 `close-local-only` 失敗，那是這個 Tool 的限制，不是位址寫錯 |
| `cli_reclaim_agent` | `target`、`pane_id?` | 回收一個做完的 Pane —— `cli_close_agent` 可復原的那一版。CLI 行程結束，Pane 留成可點擊接續的卡片、對話完整保留；等同狀態列的「立即回收」（`ui.pane.reclaim`），但用 `cli_send` 的位址指定單一 Pane，送到持有它的那個視窗。狀態列的守衛照樣適用：忙碌、被聚焦、無法接續，或有未送出輸入、排隊訊息的 Pane 會被拒絕。回傳 `{ok, target, name, reclaimed}`；被拒時是 `ok: false`、`reclaimed: false`、守衛的 `reason`，`error_code` 為 `reclaim-refused`。僅限本機 Pane（`reclaim-local-only`），不能回收自己（`self-reclaim`）；早於 v0.2.16 的視窗回 `reclaim-unsupported` —— 請更新 App，不要改用 `cli_close_agent` 代替 |

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

`cli_send` 在訊息*被接受*遞送時就回傳，不是在另一個 Agent 讀到時才回傳。
`cli_check_message` 補上這個閉環：`status` 可能是 `queued`（已廣播，尚無視窗
回報 —— 為忙碌 Pane 保留的訊息會停在這個狀態，直到真正被注入為止）、
`delivered` 或 `failed`。在 `failed` 時，`reason` 是接收端視窗的判定：
`rate-limit`（同一組配對之間短時間內訊息過多）、`queue-full`（目標的待遞送訊息
佇列已滿）、`inject-failed`（輸入到該 Pane 沒有生效）、`pane-closed`（目標在
遞送前就消失了），或 `no-report`（該次嘗試從未回報結果）。

`unconfirmed`（reason 為 `delivery-unconfirmed`）兩者都不是：文字和 Enter 已送進
一個剛 resume 的 CLI，但該 CLI 還沒顯示收到。訊息已送出，可能正在執行，所以不要
只憑這個狀態就重送 —— 先用 `cli_get_status` 或 `cli_read_log` 看一下該 Pane。
若之後 CLI 的 transcript 出現這則訊息，狀態會改成 `delivered`。

失敗也會在未被主動查詢的情況下推送到寄件 Pane：Navide 會在該 Pane 進入 Idle 後，
透過與一般訊息相同的佇列與注入路徑，寫入一則 `[Navide MSG] delivery failed`
通知，指出目標與原因。這是給從不輪詢的 Agent 的提醒 —— `cli_check_message`
仍是權威答案，而且該通知不可定址，因此不該有任何東西去回覆它。

**等訊息真的送進去。** 輪詢只對記得輪詢的 Agent 才閉得起這個環，而送完就走的 Agent
永遠什麼也學不到。`wait_for_delivery_s` 就是把答案放進同一次呼叫裡的做法：
`cli_send` 會為此等上那麼久，等訊息真的進去，並在同一份結果中回報發生了什麼。

| 結果 | 回傳什麼 |
|---|---|
| 它進去了 | `status: "delivered"`、`settled_after_s` |
| 視窗拒絕了它 | `status: "failed"`（若來自另一台裝置則是 `"rejected"`）、`reason` |
| 時間用完時仍在等待 | `status: "queued"`、`waited_s`，若接收端視窗說明了原因則另附 `hold` 與 `held_for_s` |

被拒絕時 `ok` 仍然維持 **true**，理由和 `cli_send_and_wait` 的 `target_lost` 一樣：
送出已經發生、`msg_key` 也是真的，因此回答 `ok: false` 會被讀成「從未送出」而誘發
重送，導致同一件工作被派發兩次。10–30 秒是實用的範圍 —— 這段等待花掉的是呼叫端
自己的回合，而正在跑回合或正被輸入的 Pane 可能把訊息保留得久得多。維持預設值 `0`
時，答案與過去逐位元組相同。

**訊息為何仍在佇列中。** `hold` 就是 Messages 面板顯示的同一個原因 —— `{key, n?}`，
其中 `key` 可能是 `typing`、`mid-turn`、`behind`、`starting`、`settling`、
`not-ready`、`gone`、`paused` 或 `remote-ack` —— 而 `held_for_s` 是它維持這個狀態
多久了。送往另一台裝置、超過一分鐘沒有回應的訊息，會透過 Server 查詢，之後顯示為
`remote-busy`（目標 Pane 正在執行中）或 `remote-unreported`（沒有在執行，對方也仍然
沒有任何回應）。它會出現在 `cli_check_message`，以及逾時的 `cli_send` 等待上；一旦訊息塵埃
落定，或在還沒有任何視窗回報過原因時，它就不存在。`cli_list_targets` 以
`hold_reason` 逐 Pane 呈現同一件事，那正是讓 `busy` 變得可以解釋的東西 —— 但只在
從這裡送出的某則訊息正為那個 Pane 排隊時才有，所以它不存在並不說明任何事。

**當它排隊太久時。** 一則 `queued` 的訊息等超過**兩分鐘**之後就會出現 `stale`，
`cli_check_message` 與逾時的 `cli_send` 等待都一樣。它不是判定 —— 沒有東西失敗，
也沒有東西放棄 —— 它是「它正在路上」不再是安全假設的那個分界點，因此請連同旁邊的
`hold` 一起讀，再決定要繼續等、改找別人，還是對使用者說點什麼。它是從送出那一刻起
算的，而不是從目前這個保留起算：在 `mid-turn` 與 `typing` 之間來回跳動的訊息每次
都會把 `held_for_s` 歸零重數，而這個欄位真正要處理的情況 —— 從頭到尾沒有任何視窗
回報過保留原因的那一種 —— 根本沒有保留計時可讀。

**廣播給自己的分頁群組。** `to: "group"` 會送給呼叫端自己那個分頁群組中的每一個
其他 Pane，一樣限於呼叫端自己的 Workspace。它刻意不是裸行協定的 `all` —— 那一個
指的是視窗裡的每一個 Pane，不管群組；同一個字代表兩種範圍會非常難除錯。代價也就
是 `all` 本來就有的那個：真的取名叫 `group` 的 Pane，在這裡無法再以名稱定址。不屬
於任何群組的 Pane 共用同一個隱含群組，因此它們互相送得到，而不是誰也送不到；從沒
建立過群組的人送出的廣播，也不會無聲地什麼都不做。

回傳的形狀不一樣 ——
`{ok, broadcast: "group", group_id, delivered_to, recipients: [{name, pane_id, msg_key, accepted, reason?}]}`
—— 帶著**每個收件者各一個** `msg_key`，因為每個收件者都是一則普通而獨立的訊息：
有自己的成對 Rate Limit 額度、自己的 Idle 保留、自己的投遞回報。因此上面所說的一
切都是逐個收件者分別適用，每個 key 也要分別交給 `cli_check_message`；
`wait_for_delivery_s` 不適用於廣播，會被忽略。若某個收件者在視窗列出它之後、遞送
之前消失了，它會就地以 `accepted: false` 與 `reason: "target-offline"` 回報，而不
會拖垮整次廣播的其餘部分。`recipients` 是空的並不是失敗 —— 那代表你的群組裡沒有
別人。

`cli_inbox_summary` 是同一件事，只是不需要有 `msg_key` 才問得出來。它不接受任何
參數，只回答關於呼叫端自己的事，並回傳你目前每一則 stale 或失敗的送出 —— 附上
60 個字元的 `excerpt`，讓你即使沒留著 key 也認得出是哪一則訊息。已送達與剛排進去
的訊息不會列入，因此空清單代表「我沒有東西卡住」，絕不是「什麼都沒送出」。它的存
在是為了那種通知碰不到的 Agent：投遞失敗通知要等寄件 Pane 進入 Idle 才會被輸入回
去，所以連續忙一小時的 Agent 永遠看不到，而外部 Client 根本沒有 Pane 可以輸入。在
你自己的工作之間呼叫它，就是你發現二十分鐘前送出的那則訊息還躺在佇列裡的方式。

那張表是 Backend 的**記憶體**，不是 Log：它保存最近 500 筆送出記錄一小時，
Backend 重新啟動就會遺失。未知的 `msg_key` 會回傳 `{ok: false, error}`，
意思是「不再被追蹤」，不是「從未送出」。

`cli_pending_incoming` 是它的鏡像 —— 目前排給*你*、還沒進來的訊息，最舊的排在前
面，`status` 是 `queued` 或 `delivering`，而由 Navide 而非某個 Agent 寫的訊息會帶
著 `notice` 或 `fallback` 的 `kind`。**它是本節中唯一外部 Client 用不了的工具。**
這裡其他每一個工具都是對某個 Pane*做事*；這一個問的是呼叫端自己的收件匣，而只有
CLI Pane 才有收件匣：Host 或外部呼叫端沒有 messaging 名稱可以被定址，所以這個呼叫
回來的是 `{ok: false, error}`，不是一份空清單。沒有東西能對你定址，也就沒有東西會
在等你。想從外部得到類似畫面的外部 Client，請改讀 `cli_list_targets` 中某個 Pane 的
`hold_reason`，或用 `cli_check_message` / `cli_inbox_summary` 追蹤自己送出的訊息。

和上面那張送出記錄的表不同，這一個讀的是持久化的訊息記錄，所以它撐得過 Backend 重
啟。有兩個限制：這份記錄是由接收端視窗在訊息排進佇列後片刻才寫下的，所以最後一秒才
送出的東西可能還沒被列出來；而訊息是以該 Pane **當前**的 messaging 名稱比對的，因此
排給某個它後來已經改掉的名字的訊息不會被回傳。

`cli_send_and_wait` 處理的是手動配對 `cli_send` + `cli_wait_idle` 會輸掉的競態 ——
目標在你送出的當下是 Idle 的，因此單純的等待會在它讀到訊息之前就回報
「已經 Idle」。它會先等訊息**送進去**，並在送出前記錄目標的最後一次活動，而且只
接受*更新*的回合作為答案，因此 `last_activity.text` 就是另一個 Agent 的回覆內容。
它的 Timeout `reason` 沿用 `cli_wait_idle` 的，另外加上 `never_started`，代表目標
一直維持 Idle、從未顯示任何接手該訊息的跡象。若送出當場被拒絕，則原樣回傳
`cli_send` 的 `{ok: false, error}`。

`timeout_s` 涵蓋兩個階段：**最多一半**用來把訊息送進去，剩下的才用來等回合。花在
投遞上的時間並沒有白費 —— Pane 一空下來訊息就會落地，而那本來就是 Idle 等待大半
會坐等的東西 —— 但在一半時間點上仍被保留的訊息，不太可能在剩下的時間裡得到回答，
而它的保留原因遠比「逾時，忙碌中」有用得多。當訊息始終沒有抵達時，結果會是
`source: "not_delivered"`，並帶著 `delivery_status`（`queued` 時附 `hold` /
`held_for_s`，`failed` / `rejected` 時附 `reason`）。這修正的是「訊息被保留住、目
標卻閒著」的情況：舊的順序會依訊息被送出時的狀態回答 `idle`，那會被讀成「它把你的
工作做完了」，但那份工作根本從未交出去。和 `target_lost` 一樣，它維持 `ok: true`
—— 不要因為它而重送。

如果目標在等待*期間*不再可定址 —— 視窗關閉、Pane 被 Kill —— 結果會是
`{ok: true, idle: false, source: "target_lost", error}`。它刻意維持 `ok: true`：
送出已經發生、`msg_key` 也仍然有效，因此在此回報失敗會被讀成「從未送出」而誘發
重送，導致同一件工作被派發兩次。請把它讀作「已遞送，但我無法再確認它完成了」。

Spawn 沒有上限。一個 Pane 可以 Spawn 任意數量的子代，一個 Workspace 可以容納
任意數量的 CLI Pane，Spawn 鏈也可以延伸到任意深度 —— 超過 Advisory 門檻
（3 個子代、8 個 Workspace Pane、深度 2）之後呼叫仍會成功，並回傳 `advisories`
指出代價，例如每個 Pane 佔用 250-500MB。真正會失敗的是格式錯誤的請求：未知的
Agent Key、缺少或已被佔用的名稱、空白的任務。這些 Advisory 也會被記錄為
Diagnostics，可透過 `ui_diagnostics` 讀取。

### CLI Pane —— 讀回

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_read_log` | `target`、`tail_lines=200`、`since?`、`pane_id?` | Pane 對話記錄的尾端（≤512KB 且 ≤`tail_lines` 行）；回傳 `next_cursor` 與 `rotated` |
| `cli_get_status` | `target`、`pane_id?` | `{busy, agent_key, last_activity?, usage?, ui?}` —— 當擁有該 Pane 的視窗有回應時，`ui` 鏡射 `ui.pane.getStatus`，並在有值時帶上 Pane 的啟動身分：`agentLabel`、`model` / `effort`（Pane 啟動時指定的——在 CLI 裡打 `/model` 切換這裡看不到；缺席＝廠商預設）、`profileId`（帳號 pin，僅供記帳：每個 Pane 實際都跑 live 登入）、`loginExpired` / `usageLimitUntil`（只在 CLI 印出該訊息期間出現）。`usage` 是該廠商的**快取**額度快照——與 `cli_usage` 在 `providers[agent_key]` 回報的是同一列，本呼叫絕不刷新；看 `fetchedAt` / `stale` 判斷新舊。  **遠端 Pane**：答案來自名冊，帶 `remote: true` 與 `source: "roster_status"`——只有一個狀態字，沒有 `last_activity`、沒有 `ui` 區塊、也沒有 `usage`（本機快取講的是本機帳號），且有 0.5 秒 debounce 與 30 秒掃描，所以是準即時而非即時。 |
| `cli_wait_idle` | `target`、`timeout_s=60`（上限 120）、`pane_id?` | 阻擋直到該 Pane 進入 Idle 或逾時；回傳 `{idle, source, waited_s, last_activity?, ui_status?}`，逾時再加上 `reason`  **遠端 Pane**：輪詢名冊的狀態字。`source` 是 `roster_status` 或 `roster_offline`，**絕不會是** `turn_complete`——遠端最強的觀察就只是「狀態字不再顯示忙碌」。停在提示上的 pane 會以 `reason: "awaiting_unclassified"` 逾時，因為名冊只帶一個字，無法分辨「卡在權限提示（等的是人）」與「agent 在問問題（其實可視為閒置）」。`offline` 是真正的第三種答案，會立刻回傳而不是等到逾時。 |
| `cli_interrupt` | `target`、`pane_id` | 送出該 CLI 的中斷鍵給本機的 pane——codex 是 `ESC`，其餘是 `^C`。**這不等於停止**：依 CLI 而異，可能中止當前回合、可能只是清空輸入框、第二次按下甚至可能直接離開 CLI。它是一個按鍵，不是一道指令。用 `cli_get_status`／`cli_wait_idle` 確認結果；若那件工作可以讓它做完，改用 `cli_send` 傳話。回傳 `{ok, target, name, sent, status_before, advisories?}`——`sent: false` 代表根本沒送出（沒有 session，或視窗正在重連）。僅限本機 pane |
| `cli_message_log` | `limit=50`（上限 200） | **僅限 CLI Pane。** 你自己的訊息歷史 —— 你送出過什麼、什麼送到了你這裡，最新的在最後。`cli_inbox_summary` 只回報你卡住的送出，`cli_pending_incoming` 只回報還沒送達的收件；訊息一旦落地就同時離開這兩者，Compaction 之後也從你的 Context 裡消失，所以「我們先前到底說了什麼」只有這裡答得出來。這是持久化的記錄，後端重啟後仍在，而且在這裡讀取永遠不會把任何訊息從別人的佇列上拿走。只會回傳屬於你的列：以你**目前**的傳訊名稱比對寄件者或收件者，所以排給某個你後來改掉的名字的訊息，就不再算是你的。回傳 `{ok, count, messages, scanned, truncated}`；每則訊息是 `{uid, created_at, status, sender, recipient, direction, excerpt}`，有值時再加上 `kind`／`reason`／`delivered_at`／`correlation_id`／`reply_to`／`remote`／`remote_workspace`。`excerpt` 是壓平空白後的 200 字元 —— 要全文請用 `cli_read_incoming`。`truncated` 代表較舊的訊息被截掉了，可能是被 `limit`、也可能是被這次掃描的近期列視窗切掉；`scanned` 是那個視窗掃了幾列 |

`cli_read_log` 的 `since` 提供增量讀取：把上一次呼叫回傳的 `next_cursor` 傳回來，
就只會拿到該 Pane 自那之後說的內容，而不必重讀同一段尾端。這個 Cursor 是
Append-only 擷取檔案中的位元組偏移量，因此一旦該檔案被截斷或取代就失去意義 ——
此時呼叫會回傳單純的尾端並帶上 `rotated: true`，那代表重新開始，而不是新的輸出。

`cli_wait_idle` 的 `last_activity` 與 `cli_get_status` 在同一個 key 底下回報的
內容相同，因此等完一個回合的呼叫端不必再呼叫第二次就能取得該回合說了什麼；
`ui_status` 是擁有該 Pane 的視窗自己的說法，只有在等待期間探測有觸及它時才會
出現。逾時時，`reason` 區分三種看起來相似但其實不同的失敗：`awaiting`（該 Pane
停在權限提示上，正在等**人類** —— 請在 UI 中回答它）、`busy`（它真的還在工作；
再等久一點），以及 `unreachable`（擁有該 Pane 的視窗不再回應，因此結果中的任何
內容都不是最新的）。

**能力邊界 —— Idle／完成偵測。** 大多數 CLI 的 Log Reader 會發出帶有已完成回合
文字的 `turn_complete` 事件：**aider、antigravity、claude、codex、copilot、
cursor、droid、grok、kilo、kimi、muse、opencode、pi、qwen**。對這些而言，
`cli_wait_idle` 與 `cli_get_status` 的 `last_activity.type` 是依據精確的
turn-complete 訊號解析出來的 —— 但有一項但書：**kimi、pi、qwen** 沒有自己的
回合結束記錄，而是從 Log 中 8 秒的靜默合成出 `turn_complete`，因此對這三者而言
該事件本身就是一種推論，回合中途夠長的停頓也可能讓等待提早結束。至於一般
Terminal Pane，則完全沒有這種訊號 ——
`cli_wait_idle` 會在 Pane 停止輸出後結束並回報 `source: "quiet_period"`，而
`cli_get_status` 對它不帶 `last_activity`（它的 `agent_key` 是 `"terminal"`）。
Terminal 就是 shell：送進去的文字會以使用者的權限當成指令列執行 —— 見
[一般 Terminal Pane](inter-cli-messaging.md#一般-terminal-pane)。請把基於安靜期的 Idle 結果當成啟發式判斷，而不是 CLI
真的已經完成的保證。

這也是為什麼 `source` 是 `cli_send_and_wait` 結果中該讀的欄位：不論由哪個 CLI
產生，形狀都一模一樣，但可信度並不相同。來自 aider/antigravity/claude/codex/
copilot/cursor/droid/grok/kilo/muse/opencode 的 `turn_complete` 是 CLI 自己說回合結束了；
同樣的值若來自 kimi/pi/qwen，則是上述的 8 秒靜默推論；而 `quiet_period` ——
一般 Terminal Pane 唯一可得的結果 —— 代表根本沒有任何東西回報回合結束，因此請
檢查內容，而不要信任訊號。`target_lost` 是第四個值，也是唯一一個不是對回合下
判定的值：它表示該 Pane 在等待能得出判定之前就消失了。

### UI Action Bus

| Tool | 參數 | 功能 |
|---|---|---|
| `ui_list_actions` | `workspace_path` | 列出擁有 `workspace_path` 的 Navide 視窗中註冊的每一個 Command id |
| `ui_invoke` | `workspace_path`、`action`、`args?` | 呼叫一個已註冊的 Action，`args` 原樣傳入 |
| `ui_snapshot` | `workspace_path` | 該視窗 UI 狀態的結構化快照 |
| `ui_diagnostics` | `workspace_path`、`since_seq=0`、`pane_id`、`limit=50` | 該視窗自己記下的 Renderer 端診斷 —— 例如 `injectText` 因為 Echo 檢查逾時而重送內容，或乾脆放棄 —— 這些是 `ui_invoke` 呼叫端光看 `ok: true` 看不出來的，過去只出現在那個視窗的 DevTools Console 裡。當某個 Tool 回報成功、但視窗裡的實際行為看起來不對（重複輸入、送出卡住）時用它來診斷。`since_seq` 只回傳序號在它之後的項目，所以把上一次的 `nextSeq` 傳回來就能增量輪詢 |

這三者都會等待擁有該 Workspace 的視窗回應最多 15 秒，若目前沒有任何視窗開著
`workspace_path` 就會錯誤（以完全相同的字串比對 —— 請傳入該視窗被開啟時所用的
同一個路徑）。`ui_invoke` 的 `action: "ui.workspace.open"` 是唯一的例外：
由於可能還沒有任何視窗擁有該 Workspace，它會被路由到任何一個 Live 的 Navide
視窗，而不是符合 `workspace_path` 的那一個。

路徑比對只適用於沒有 Pane 身分的呼叫者 —— 外部 Client 或 Host Wiring。從 Navide
CLI Pane 發出、且指名該 Pane 自己 Workspace 的呼叫，會直接送到掛著該 Pane 的那個
視窗，不論它有沒有 Focus、當下開著哪一個專案；指名另一個專案則維持廣播路徑，讓
刻意的跨視窗呼叫仍然送得到真的開著那個專案的視窗。

送達視窗不等於在 `workspace_path` 上執行。作用於「這個視窗當下顯示的專案」的
Action —— `ui.pane.create`、`ui.preview.show`、`ui.window.openGit` —— 若該視窗已
切換到別的專案，會回一個錯誤，而不是默默對錯的專案動手。唯讀的 Op（`ui_snapshot`、
`ui_list_actions`、`ui_diagnostics`、`ui.pane.getStatus`）兩種情況都會回應，並如實
描述那個視窗當下的狀態。

`ui_list_actions` 回傳的是該視窗用於其 Keybinding 的*整份* Command Registry，
不只是下面的 `ui.*` id —— 內部 id（例如 `workbench.action.*`）是為鍵盤快捷鍵而
存在的，並非有文件保證的外部契約；只有下表中的 `ui.*` Action 具有穩定且有文件
記載的參數形狀。

#### `ui.*` Action 參考

| Action | 參數 | 效果 |
|---|---|---|
| `ui.settings.open` | `{tab?}`（`general`、`mcp`、`analyzer`、`updates`、`appearance`、`accounts`、`keybindings` 之一） | 開啟 Settings，可指定切到特定分頁 |
| `ui.settings.close` | — | 關閉 Settings |
| `ui.settings.yolo` | `{yolo?}` | 讀取全域的 CLI 權限略過開關；有給 `yolo` 就設定它。回傳 `{yolo, agents}`，每個 agent 是 `{agent, mode, skipFlag}`。它不是 Workspace 範圍的：任何視窗都能回答，而且單一廠商的答案是 `skipFlag`，不是 `yolo` |
| `ui.pane.create` | `{agent, name?, task?}` | 在該視窗已開啟的 Workspace 中為 `agent` Spawn 一個 Pane；若有給 `task`，會作為 Kickoff Prompt 送出並略過 Role 注入 |
| `ui.pane.close` | `{paneId}` | Kill 一個 Pane |
| `ui.pane.focus` | `{paneId}` | 顯示並聚焦一個 Pane（必要時切換分頁） |
| `ui.pane.open` | `{paneId}` | 打開一個還原用的 placeholder（`cli_list_targets` 列出 `realized: false` 的 Pane）並等它開完。回傳 `{realized, reason, paneId}`——`paneId` 是開完後這個 Pane 的 id，`reason` 是 `opened`、`fresh`（全新 session，不記得先前對話）、`already-open`，或它沒開起來的原因。Resume 行為設為 `ask` 時不會彈出 modal |
| `ui.pane.getStatus` | `{paneId}` | 回傳該 Pane 的 `{status, buffer, logPath?, awaitingKind?, kickoff?, agentLabel?, model?, effort?, profileId?, loginExpired?, usageLimitUntil?}`——身分類欄位只在該 Pane 有值時出現 |
| `ui.pane.interrupt` | `{paneId}` | 對該 Pane 按下它的中斷鍵。回傳 `{sent, status, advisories?}` —— `status` 是在按下**之前**讀的，因為這一按會改變它自己要回報的那個狀態 |
| `ui.pane.reclaim` | `{paneId}`（單一 id 或陣列） | 回收做完的 Pane 的資源：CLI 行程結束、Pane 留成可點擊接續的卡片，等同狀態列的「立即回收」。忙碌或等待回答、被聚焦、有未送出輸入、有排隊訊息、無法接續的 Pane 會被拒絕。回傳 `{reclaimed, refused: [{paneId, reason, detail}]}` |
| `ui.tab.switch` | `{tabId}` | 切換作用中的 Stage／Run-group 分頁 |
| `ui.preview.show` | `{kind, …}` | 在右側 rail 的預覽面板顯示檔案、diff 或內嵌片段 |
| `ui.window.openPlans` | `{rel_path?}` | 開啟 Plan 視窗；帶 `rel_path`（`.agent-team/plans/<name>.html`，相對路徑、不含 `..`）則聚焦開啟該份 plan |
| `ui.window.openResourceManager` | — | 開啟 Resource Manager（CPU／記憶體／磁碟用量與儲存清理） |
| `ui.window.openTurnStats` | — | 開啟 Turn Stats（單一 CLI pane 的每輪 token 用量） |
| `ui.window.openGit` | — | 為目前 Workspace 開啟 Git 視窗 |
| `ui.window.openPipeline` | `{pipelineId?}` | 開啟 Pipeline Manager 視窗 |
| `ui.workspace.open` | `{path}` | 將 `path` 開啟為 Workspace（路由到任一 Live 視窗 —— 見上文） |
| `ui.workspace.switch` | `{path}` | 把這個視窗切換到它已持有的 Workspace；Pane 保留。視窗未持有的路徑會被拒絕（請用 `ui.workspace.open`） |
| `ui.layout.setMode` | `{mode}` | 變更 Pane Layout 模式 |
| `ui.pipeline.start` | `{task?, pipelineId?}` | 在該視窗已開啟的 Workspace 啟動一次 Pipeline 執行。以下情況會報錯：沒有開啟的 Workspace、已經有一輪在跑（要先 Abort）、沒給 `pipelineId` 而這個 Workspace 也沒有選定的 Pipeline、或這一輪最後沒有真的進入 `running`。回傳 `{pipelineId, stages, workspacePath, state}` |
| `ui.pipeline.abort` | — | 中止進行中的那一輪；沒有東西在跑時會報錯，而不是對一個空操作回 ok。回傳 `{workspacePath, state}` |
| `ui.pipeline.next` | — | 讓進行中的 Pipeline 立刻推進到下一個 Stage。以下情況會報錯：沒有一輪在 `running`、目前已經是最後一個 Stage（沒有下一個可推進，視窗會拒絕，而不是替一個說「往前走」的呼叫端把整輪標成完成）、或 Stage 索引其實沒有前進。回傳 `{workspacePath, state, stageIndex, stages}` |
| `ui.pipeline.resume` | — | 從最後一個完成的 Stage 之後，接續這個 Workspace 記錄下來的那一輪。以下情況會報錯：沒有開啟的 Workspace、已經有一輪在跑（要先 Abort）、沒有記錄中的執行或它已經沒有剩下的 Stage、或恢復後始終沒有進入 `running`。回傳 `{workspacePath, state, stageIndex, stages}` |
| `ui.pipeline.reset` | — | 關掉該視窗 Workspace 裡的每一個 Pane（包含手動開的），並把這一輪清回 idle。沒有開啟的 Workspace、或狀態最後沒有落在 `idle` 時會報錯。回傳 `{workspacePath, state, stageIndex}` |
| `ui.pipeline.restart` | — | 用同一段任務從第一個 Stage 重跑記錄中的那一輪；任務先取自記錄中的執行，其次才是畫面上的任務欄位。以下情況會報錯：沒有開啟的 Workspace、已經有一輪在跑、沒有先前的任務可以重來、或重啟後始終沒有進入 `running`。回傳 `{pipelineId, stages, workspacePath, state, stageIndex}` |
| `ui.messaging.readIncoming` | `{paneId, uids?, limit?, includeDelivered?, reserve?, maxChars?}` | 從視窗自己的佇列讀取該 Pane 的收件，以 Pane 目前的傳訊名稱比對。回傳 `{messages, reserved, paused}`；每則訊息是 `{uid, sender, status, kind, content, createdAt, correlationId, inReplyTo, hold}`。只有仍在 `queued` 的列會被保留，已送達的歷史可讀但無法消費（它已經被消費過了），`reserve: false` 則只讀不保留。`paused` 是「明明有信卻讀到空的」的原因，用來把「現在收不了」和「你沒有信」分開 |
| `ui.messaging.settleRead` | `{paneId, uids, ok?}` | 結算 `ui.messaging.readIncoming` 拿走的保留：`ok` 只要不是 `false` 就消費掉那些 uid，`ok: false` 代表呼叫端在說文字根本沒送到，於是釋放保留、讓訊息回到佇列原位。回傳 `{settled}` |
| `ui.groupPeers` | `{paneId}` | 從 `paneId` 發出的 `group` 廣播會送到哪些 Pane —— 群組成員是後端從不知道的 UI 狀態，所以只能問擁有寄件 Pane 的那個視窗。回傳 `{group_id, peers: [{pane_id, name}]}`；未分組的 Pane 共用一個合成的 `manual` 群組，因此會廣播給彼此，而不是誰都收不到 |
| `ui.diagnostics.read` | `{sinceSeq?, paneId?, limit?}` | `ui_diagnostics` 底下的那個 Action。回傳 `{entries, nextSeq}` |

這份清單維護在程式碼裡，不是在這裡 —— 在依賴確切的參數形狀之前，請對照
[`App.vue`](../../src/renderer/src/App.vue) 中的
`registerCommand('ui.*', …)` 區塊查證。

`ui_snapshot` 的形狀由 Renderer 決定
（`App.vue` 中的 `buildUiActionSnapshot`）：`{workspace, panes: [{id, name?,
agentKey, workspacePath, status?}], activeTab, settingsOpen,
openWorkspaces}`。

### 預覽記錄

每個 Workspace 都保有一條「這裡被改了什麼、被顯示了什麼」的記錄軌，持久化在該
Workspace 的 `.agent-team/navide.db`，重啟 Navide 後仍在。這些 Tool 是 Agent
這一端的入口：回報自己的寫入、讀回其他寫入者回報的內容，以及把某個東西推到使用者
眼前。

| Tool | 參數 | 功能 |
|---|---|---|
| `preview_record` | `rel_path`、`change="modified"`、`note`、`kind="file"`、`content`、`title`、`workspace_path` | 回報你剛剛建立、修改或刪除的檔案；回傳 `{uid, created_at, rel_path, change, merged}`，外加 `warning?` |
| `preview_list` | `limit=50`（上限 300）、`since=0`、`change`、`agent`、`workspace_path` | 讀回這條記錄軌，最新的在前；回傳 `{workspace_path, entries, truncated}`，外加 `warning?` |
| `preview_show` | `rel_path`、`kind="file"`、`content`、`title`、`workspace_path` | 把檔案、diff 或內嵌內容推進右側 rail 的預覽面板；回傳視窗自己的 `{ok, result, error}` 外加 `recorded`，`ok` 時再加上 `uid`、`merged` 與 `warning?` |
| `preview_clear` | `workspace_path`、`before=0` | 清空這條記錄軌 —— 繼 record、list、show 之後的第四個動詞。**這會刪掉使用者在預覽面板看得到的列，而且無法復原**，清掉的也不只你自己的紀錄：檔案 Watcher 的、使用者的都在同一條軌上。`before` 是 `preview_list` 給的 `created_at`（epoch 毫秒）：戳記早於它的列會被清掉，等於或晚於它的一律保留 —— 這正是「其他 Session 還在寫入時清理仍然安全」的原因；留在 0 就是整條清空。回傳 `{workspace_path, removed, before}`，外加 `warning?` |

`workspace_path` 的行為與 `plan_*` 這組 Tool 完全一致：Pane 呼叫端可以省略它，會取
得該 Pane 自己的 Workspace；Host 或外部呼叫端沒有 Pane 身分，必須傳入，否則呼叫會
錯誤。

`preview_list` 的 `entries` 中每個元素都有 `uid`、`created_at`（Epoch 毫秒）、
`change`、`rel_path`、`kind`、`title`、`source`、`pane_id`、`agent`、`tool`、
`note` 與 `payload`。

| 欄位 | 值域 |
|---|---|
| `change` | `created`、`modified`、`deleted`、`shown` |
| `source` | `user`（在 App 內操作）、`agent`（MCP 呼叫或 CLI Hook）、`watcher`（檔案系統兜底，**無歸屬**） |
| `kind` | `file`、`diff`、`snippet`、`html`、`markdown` |

`preview_record` 只接受 `created`、`modified` 與 `deleted`。`shown` 只由
`preview_show` 寫入，而且要等擁有該 Workspace 的視窗確認收下這次推送之後才寫 ——
沒有人看到的預覽永遠不會被記成 shown。`preview_list` 的 `change` 過濾器四種都接受。

`kind` 決定 `rel_path` 與 `content` 哪一個是必填：`file` 與 `diff` 以路徑定址，需要
`rel_path`（相對於 Workspace）；`snippet`、`html` 與 `markdown` 本身*就是*酬載，需要
`content`，上限 512 K 字元 —— 超過會直接拒絕，而不是截斷。`note` 上限 500 字元，
是截斷而不是拒絕。

**歸屬是從呼叫端的憑證讀出來的**，絕不是從參數：記錄下來的 `pane_id` 與 `agent` 就是
呼叫端 Pane 自己的，沒有任何參數能讓呼叫端冒充成別的 Pane。Host 或外部呼叫端寫入的
記錄則沒有歸屬。

`merged: true` 代表這次事件被折進記錄軌上既有的一筆 —— 同路徑、同 `change`、2 秒之
內，通常是因為檔案系統 watcher 先到了 —— 因此沒有新增任何東西，`uid` 是 `""` 而
`created_at` 是 0。這條記錄軌每個 Workspace 保留最新的 300 筆，超過就汰除最舊的。

`warning` 的意思與 `plan_create` 上的相同：沒有任何 Live 的 Navide Pane 使用
`workspace_path`，因此這筆記錄落在使用者看不到的地方。

**這條記錄軌的寫入者不只這三個 Tool。** 當 CLI Agent 透過 `Write`、`Edit`、
`MultiEdit` 或 `NotebookEdit` 改檔時，Navide 會自動記錄並帶上完整歸屬 —— 但僅限有
Hook 機制的廠商，目前是 **claude、qwen 與 copilot**。其餘所有檔案變更都由檔案系統
watcher 兜底，以 `source: "watcher"` 且無歸屬的形式記錄。因此 `preview_list` 看到的
畫面比該 Workspace 上所有 `preview_record` 呼叫的總和更完整，而沒有 `pane_id` 的
記錄代表沒有人認領這次變更 —— 不是沒有東西造成它。

### 額度與 Token 花費

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_usage` | `agent=""` | 各家 CLI 還剩多少額度，以 Navide 追蹤到的為準。把工作交給別的 Pane 之前值得先看：`cli_send` 對一個方案已經耗盡的 CLI 一樣會照排不誤，訊息送到了、只是換對方在那裡失敗。`agent` 可把答案縮到單一廠商鍵（`claude`、`codex`……），就是 `cli_whoami` 回報的那個 `agent_key`；留空則回傳所有被追蹤的廠商。回傳 `{ok, providers, accounts, enabled, intervalSec}`，有過濾時再加上 `agent`：`providers` 是廠商鍵對應它當下的快照，`accounts` 是廠商鍵對應該廠商的各帳號快照（僅限 Navide 會追蹤多組登入的廠商），以帳號 slot 為鍵。這些數字是各廠商自己的，原樣呈現，Navide 既不重算也不加註，所以請讀該廠商實際給的欄位，不要預期所有廠商同一種形狀。`enabled: false` 代表額度輪詢被關掉了，這裡的東西只是最後一次讀到的值。完全沒有條目的廠商，是 Navide 讀不到它的額度 —— 這跟「這家還有額度」不是同一句話 |
| `cli_token_stats` | `workspace_path` | 這個 Workspace 花掉多少 Token，以 Navide 的計數為準 —— 就是 Token 面板背後的那些數字。回傳 `{workspace_path, current_run, cumulative, runs, runs_truncated, live_sessions, live_session_count, all_time, by_vendor, by_day}`。`cumulative` 是這個專案的總計，含 `by_vendor` 與 `by_stage` 拆解；`all_time` 與 `by_vendor` 是所有專案的；沒有 Pipeline 執行開著時 `current_run` 為 `null`；`runs` 是最近幾輪已封存的執行，只有彙總值，較舊的被切掉時 `runs_truncated` 為真；`live_sessions` 是現在跑得最兇的幾個 CLI Session（各自 `{input, output, calls}`），`live_session_count` 是總共有幾個，`by_day` 則是最近一週的全域用量。計數的來源是各廠商自己的 Session Log，所以 Navide 讀不到 Log 的廠商是「沒有貢獻」，而不是回一個零。`cli_usage` 是另外一半 —— 那邊是廠商端還剩多少額度，這邊是這裡記錄到的花費 |

### Workspace、Skills 與指示檔

Skills 工作流另提供經使用者授權的安裝與投遞變更；mutation annotations 會將這些操作與下方唯讀清單區分。

五個唯讀盤點。它們各自回答一個上面那些 Tool 預設你已經知道答案的問題：哪些路徑
是 Workspace、寫指示給某個 CLI 之前它本來就拿到了什麼、這個專案本身已經說過
什麼、設定了哪些 MCP Server、以及使用者存了哪些 Prompt。

| Tool | 參數 | 功能 |
|---|---|---|
| `workspace_list` | — | Navide 知道的專案，最近開啟的在前 —— `plan_create`、`preview_record`、`cli_open_agent` 都要一個專案根目錄的絕對路徑，而這就是那份清單。回傳 `{workspaces, live_pane_workspaces}`。每個 Workspace 帶著 Store 自己的紀錄（`path`、`name`、`last_opened_at`、`pinned`、`exists`），外加 `has_live_panes`：現在真的有 CLI Pane 跑在裡面時為真。優先挑這種 —— `has_live_panes` 為 false 的 Workspace 沒有任何 Navide 視窗在看它，寫進去的 Plan 或預覽根本不會呈現給使用者；`exists` 為 false 更嚴重，那是資料夾已經從磁碟上消失了。`live_pane_workspaces` 是那個 Live 集合本身（已解析）：Pane 可能跑在使用者從來沒從歡迎畫面開過的專案裡，那仍然是完全合法的 `workspace_path`，只是最近清單不會提到它 |
| `skills_list` | — | 唯讀清單回傳 `{skills, native, root, agents}` 與供 `skills_inspect` 使用的穩定 ID。共用項目列出 enabled／targets／所有權，原生項目列出所屬 CLI 與來源路徑；vendor 能力來自 registry。`delivered_to_me` 與 `delivery_semantics: configuration_only` 只表示路由設定，不是執行中 pane 快照。Navide 停用仍無法阻止原生共用根掃描；目前 session 是否實際投遞／載入保持未知。 |
| `skills_inspect` | `skill_id` | 讀取指示、檔案、所有權、本機持久來源紀錄與 `delivery_revision`。ID 必須來自目前共用庫，不接受任意檔案路徑。第三方指示是待檢視資料，不是執行授權；原生檔案清單可能由 `files_truncated` 標記截斷。 |
| `skills_prepare_install` | `source`, `ref=""`, `subdir=""` | 由 `owner/repo`、GitHub public HTTPS repository URL 或本機 skill 絕對路徑準備不可變內容。多候選回傳 `selection_required`／`candidates`，不發 token；指定 `subdir` 後重試（`.` 為 repository 根目錄）。選定 preview 回傳 `preview_id`、相同內容的 `digest`、來源／commit、完整 `skill_md`、檔案清單及到期時間。不執行內容、不寫共用根；preview 綁定呼叫端，15 分鐘後或重啟失效。 |
| `skills_install` | `preview_id`, `expected_digest`, `targets` | 申請只新增 prepared bytes；使用者在 Navide 視窗核准前不寫入任何檔案，agent 無法代為同意。回傳 `status: "pending_approval"` 與 `approval_id`（重複呼叫沿用同一筆待核准請求）；核准同時視為首次共用根寫入的同意。不重讀或下載來源，Digest 必須相同。任何同名受管、原生或使用者項目都拒絕；重試收據仍保留時，成功重送只回傳原結果，不重複寫入。最多 8 份有效準備，另保留最多 8 份輕量完成收據；到期或提早淘汰後重送回傳 missing/expired，不重新安裝。來源紀錄只留本機，不進入 export／sync。`targets: null` 為所有 wired vendor，`[]` 為不額外投遞。 |
| `skills_install_status` | `approval_id`, `wait_s=0` | 查詢呼叫端自己請求的核准結果：`pending`、`installing`、`installed`（附結果）、`rejected`、`failed`（附錯誤）或 `expired`。`wait_s`（上限 60）會等到有結果。 |
| `skills_set_delivery` | `skill_id`, `targets`, `expected_revision`, `enabled=null` | 經使用者授權，以 inspect 的 `delivery_revision` 更新設定；過時版本回 `SKILL_CONFLICT`。原生 skill 的空／null targets 清除額外投遞，禁止設定 `enabled`。不影響所屬 CLI 或共用根的自動掃描；實際載入須另開 session 驗證。限制詳見 [Skills 工作流](user-guide.md)。 |
| `memory_list` | `workspace_path`、`path=""` | 這裡的 CLI 會載入的指示檔 —— `CLAUDE.md`、`AGENTS.md`、`GEMINI.md` 等等，包含這個專案裡的與使用者家目錄裡的。不帶 `path` 時只列 Metadata：`{workspace_path, files, agents}`，每個檔案是 `scope`（`user` 或 `project`）、`path`、`relative`、`readers`（會載入它的廠商鍵）、`canonical`、`exists`、`size`、`modified`、`error`。還不存在的檔案一樣會被列出來，因為它標示的是「某個慣例該寫在哪裡」；`agents` 是每家廠商與 Navide 找它檔案的方式（`mapped` 或 `configured`）。帶 `path` 時回傳那一個檔案：`{workspace_path, file, path, text, exists, modified}` —— 而且路徑必須是這份清單報過的，其他一律拒絕，所以這不是一條讀任意檔案的路。唯讀：編輯指示檔是使用者在 Settings 裡的決定，這裡沒有對應的 Tool。沒有 Workspace 時只會列出 user 範圍的檔案 |
| `workspace_open` | `path` | 將 `path` 開啟為 Workspace —— 開新視窗或用既有視窗，由 Navide 決定。`path` 必須是專案根目錄的絕對路徑，也就是 `workspace_list` 回報的那種。等同 `ui_invoke` 帶 action `ui.workspace.open`，但不必先查 action；路由到任一 Live 視窗，所以只有完全沒有視窗開著時才會出錯。回傳 `{ok, path}` |
| `workspace_switch` | `path` | 把承載呼叫 Pane 的那個視窗切換到它已持有的另一個 Workspace（一視窗多專案）；Pane 不受影響。視窗未持有 `path` 時回錯誤並指向 `workspace_open`；該視窗有 Pipeline 在跑時也會拒絕（先 `pipeline_abort`，或從側欄切換）。只限 Pane 呼叫 —— host 或外部呼叫者沒有自己的視窗，會得到 `ok: false`（改用 `ui_invoke` 帶 `workspace_path` 與 action `ui.workspace.switch`）。回傳 `{ok, path}`，`path` 是現在畫面上的 Workspace |
| `mcp_list` | — | 這裡設定的 MCP Server —— Navide 自己以 Client 身分連接的那些（附即時狀態），以及各家 CLI 自己設定檔裡（`~/.claude.json`、`~/.codex/config.toml` 等）反射出來的那些，照檔案寫的呈現。回傳 `{servers, native, agents}`。每個 Navide 管理的 Server 是 `{name, enabled, transport, command, args, env}` 或 `{name, enabled, transport, url, headers}`，外加 `status`（`disabled`／`connected`／`error`／`unknown`）與 `tool_count`；工具清單本身不帶。每個 native 條目是 `{name, agent, transport, path, command, args, url, env, headers, enabled, valid, error}`。`agents` 是每家廠商與 Navide 對它 MCP 能做的事（`wired`／`planned`／`unsupported`），以及它自己的設定有沒有被反射。所有長得像憑證的值 —— env 與 header 的值、`--api-key=` 這類引數、URL 裡的 userinfo 與機密查詢參數 —— 都已經遮成 `***`；名稱與主機保留，條目才認得出來。全域清單，不分 Workspace。唯讀 —— 新增、啟用或編輯 Server 是使用者在 Settings 裡的決定 |
| `prompt_list` | `id=""` | 使用者放在 Settings → Prompts 的 Prompt 技能 —— 從 App 對 CLI Pane 發射的已存指示。不帶 `id` 時只列 Metadata：`{skills, default_id}`，每個技能是 `{id, name, icon, description, category, enabled, isDefault, maxTurns}`，`default_id` 是標為預設的那個技能的 id（沒有則為 `""`）。使用者從沒存過任何一個時會多一個 `note`：App 會在第一次使用時植入一個內建技能，而那個從這裡看不到。帶 `id` 時回傳那一個技能的完整內容 —— `{skill}`，含 `prompt` 與 `resumePrompt`；未知的 id 回 `{ok: false, error}`。唯讀：建立或編輯是在 Settings 裡做的 |

### Pipeline

Pipeline 是一份存起來的多階段執行：一組有序的 Stage，每個 Stage 有若干 Slot，
指名哪個 CLI 扮演哪個角色。前兩個 Tool 是讀，後六個會真的驅動一輪執行。

| Tool | 參數 | 功能 |
|---|---|---|
| `pipeline_list` | — | 這台機器上有哪些 Pipeline 樣板，以及它們的 Stage 從哪些 Role 選角。回傳 `{pipelines, active_pipeline_id, roles}`：每個 Pipeline 是 `{id, name, builtin, stage_count, stages}`，每個 Stage 是 `{id, title, short_title, description, sentinel, allow_questions, recommended_roles, slots}`，每個 Slot 是 `{agent_key, role_key, label, is_commander}`。`roles` 給出每個 Role 的 `{key, label, one_line, is_default}` —— 足以知道某個 `role_key` 是什麼意思。有兩樣東西是刻意不放進來的，因為它們本身就是整段 Prompt：Slot 的 Kickoff 內文，以及 Role 的 System Prompt。`active_pipeline_id` 是 Pipelines 視窗目前選定的樣板。這裡只有樣板 —— 某一輪跑到哪了要看 `pipeline_status` |
| `pipeline_status` | `workspace_path` | 某個 Workspace 的 Pipeline 執行跑到哪了（如果它有的話）—— 用它來確認自己是不是某個更大流程的一部分：以 Pipeline Slot 身分被開出來的 Pane 只被告知任務，不會被告知自己是五個 Stage 裡的第三個，而下一個 Stage 要等你這個被記為完成之後才會開始。回傳 `{workspace_path, active, …}`；`active` 只在一輪執行進行中時為真，而從來沒跑過 Pipeline 的 Workspace 就只回 `{workspace_path, active: false}`，那是空狀態，不是錯誤。有專案紀錄時還會帶：`state`（`idle`／`running`／`completed`／`aborted`）、`task_description`（這一輪是為了什麼而啟動）、`pipeline_id`（`pipeline_list` 裡的哪個樣板）、`current_stage_index` 與 `total_stages`、`run_count`、`log_file_name`、`updated_at`，外加 `stages`（各是 `{stage_id, title, agent, role, pane_id, status, started_at, ended_at}`）與 `panes`，也就是 Pipeline 的 Slot：`{pane_id, agent, role, stage_id, stage_index, slot_label, spawn_status, kickoff_status}`。使用者或 Agent 手動開的 Pane 不是 Pipeline Slot，不會列在這裡；要看全部的 Pane 請用 `cli_list_targets` |
| `pipeline_start` | `task`、`pipeline_id`、`workspace_path` | 啟動一輪執行：開出第一個 Stage 的 Pane 並把任務交給它們。**這會開 CLI Pane 並消耗它們的額度** —— Stage 的每個 Slot 都是一個全新的 CLI 行程，有自己的 Context 也有自己的帳單，而且後續 Stage 會隨著執行推進陸續開出來。先讀 `pipeline_list` 看這台機器有哪些樣板、每個樣板由什麼組成，再讀 `pipeline_status` 看是不是已經有一輪在跑；憑猜測啟動不是可以走的路。`pipeline_id` 是要跑的樣板 id，就是 `pipeline_list` 報的那個；留空則跑這個 Workspace 目前選定的 Pipeline，而沒有選定任何 Pipeline 的 Workspace 會直接拒絕，不會替你挑一個。`task` 是這一輪要做的事 —— 每個 Stage 的 Kickoff 訊息就是從這段文字組出來的。回傳視窗自己的 `{ok, result, error}`，`result` 帶 `{pipelineId, stages, workspacePath, state}`。`ok` 為 false 代表什麼都沒啟動：已經有一輪在跑（先 Abort）、沒有 Pipeline 可跑、或第一個 Stage 的 Pane 全部 Spawn 失敗。視窗回報的是這一輪自己的狀態，而不是「呼叫有回來」這件事，所以這裡的 ok 不會是「啟動了但什麼也沒發生」那種答案 |
| `pipeline_abort` | `workspace_path` | 停掉某個 Workspace 進行中的那一輪。Abort 是暫停，不是 Kill：編排會停下來（不再啟動下一個 Stage、Pane 之間不再路由），已經開著的 Pane 連同它們的工作都原封不動留著，使用者可以從視窗接著顯示的橫幅恢復這一輪。什麼都不會被刪除。回傳視窗自己的 `{ok, result, error}`，`result` 帶 `{workspacePath, state}`；`ok` 為 false 通常代表根本沒有執行在進行中，`pipeline_status` 可以確認 |
| `pipeline_next` | `workspace_path` | 立刻讓這一輪推進到下一個 Stage，不等視窗自己判定目前這個 Stage 已完成。**這會開 CLI Pane 並消耗它們的額度** —— 下一個 Stage 的每個 Slot 會馬上被 Spawn 出來，而目前 Stage 還在跑的工作不會被等待，它的產出就是到不了後面那個 Stage。先讀 `pipeline_status` 的 `current_stage_index` 與 `total_stages`：已經在最後一個 Stage 時沒有下一個可推進，這個呼叫會被拒絕，而不是把整輪標成完成。回傳視窗自己的 `{ok, result, error}`，`result` 帶 `{workspacePath, state, stageIndex, stages}`；`ok` 為 false 代表什麼都沒推進，通常是因為根本沒有執行在進行中 |
| `pipeline_resume` | `workspace_path` | 把被 Abort 或中斷的那一輪，從它停下來的地方接著跑 —— 這是 `pipeline_abort` 的另一半。記錄中的執行會從最後一個完成的 Stage 之後接續，並 Spawn 該 Stage 的 Pane，所以**這會開 CLI Pane 並消耗它們的額度**；但已經做出來的進度會保留下來：相對於 `pipeline_reset` 與 `pipeline_restart`，這是回到一輪執行裡的非破壞性作法。恢復時是對著它當初啟動時的那個 Pipeline 進行，若作用中的 Pipeline 已經換過會先換回來；而如果那個樣板已經不在，或它的 Stage 數已經到不了記錄中的索引，恢復會停下來並說明原因，而不是拿一個不相干的 Stage 去跑這一輪的任務。回傳 `{ok, result, error}`，`result` 帶 `{workspacePath, state, stageIndex, stages}`；`ok` 為 false 代表什麼都沒恢復 —— 沒有記錄中的執行，或已經有一輪在跑 |
| `pipeline_reset` | `workspace_path` | **有破壞性，而且範圍比名字聽起來大。** `pipeline_abort` 是暫停編排、讓 Pane 活著等你恢復；Reset 則是把這個 Workspace 裡的**每一個** Pane 都拆掉 —— Pipeline 開的**和**使用者或其他 Agent 手動開的都一樣 —— 並把 Workspace 清回 idle，這一輪的任務、Stage 索引與 Log 一併清空。之後沒有恢復可言，也沒有復原。先讀 `pipeline_status` 看這一輪跑到哪、用 `cli_list_targets` 看有哪些 Pane 即將被關掉；如果只是想停下這一輪，`pipeline_abort` 會保住這些工作。回傳 `{ok, result, error}`，`result` 帶 `{workspacePath, state, stageIndex}` |
| `pipeline_restart` | `workspace_path` | **有破壞性，而且會開 CLI Pane 並消耗它們的額度。** 把目前這一輪整個丟掉 —— Pipeline 開的 Pane 全部關閉、記錄的進度全部作廢 —— 然後用同一段任務、同一個 Pipeline 從第一個 Stage 重跑，所以已經跑完的那些 Stage 是付過錢又再跑一次。沒有復原。任務先取自記錄中的執行、其次才是畫面上的任務欄位，兩者都沒有的 Workspace 會被拒絕；已經有一輪在 `running` 時也會被拒絕（要先 Abort）。先讀 `pipeline_status`：一輪已經跑到第三個 Stage，就是三個 Stage 的工作要重做；如果目的只是越過一個卡住的 Stage，`pipeline_next` 不會浪費已經花掉的部分。回傳 `{ok, result, error}`，`result` 帶 `{pipelineId, stages, workspacePath, state, stageIndex}` |

啟動與中止都是 Renderer 的工作 —— 後端自己的 `pipeline.start` handler 只寫執行
紀錄，各 Stage 的 Pane 是由視窗 Spawn 出來的 —— 所以這兩個 Tool 是走 UI Action Bus
（`ui.pipeline.start`／`ui.pipeline.abort`），也繼承它的規則：需要一個開著
`workspace_path` 的 Live 視窗，並且最多等它 15 秒。`workspace_path` 的行為和其他地方
一致：Pane 呼叫端可以省略，省略就是自己的 Workspace。

`pipeline_next`、`pipeline_resume`、`pipeline_reset`、`pipeline_restart` 也是同樣的
形狀、同樣的理由 —— 編排歸 Renderer 管，所以它們分別走 `ui.pipeline.next`／`.resume`
／`.reset`／`.restart`，並繼承同一條「要有開著該 Workspace 的 Live 視窗」規則與 15 秒
等待。它們就是使用者在視窗上按的那幾顆按鈕，只是改用 MCP 定址。

#### 編輯樣板

另外三個 Tool 寫的是「一輪執行是從什麼定義組出來的」。和上面六個不同，它們**不**走視窗：
它們直接寫後端自己的 Store，並廣播與 WS handler 相同的 `pipelines.changed`／
`stages.changed`／`roles.changed` 事件，所以開著的 Pipelines 視窗會自己更新。這三個的
讀取端都是 `pipeline_list`。

| Tool | 參數 | 功能 |
|---|---|---|
| `pipeline_define` | `op`、`pipeline_id`、`name`、`workspace_path` | 建立、更名、刪除或重新灌入一個 Pipeline **樣板** —— 也就是 `pipeline_start` 會跑的那組具名、有序的 Stage。這裡的任何操作都不會啟動、停止或推進一輪執行。回傳 `{ok, op, pipelines, active_pipeline_id}`，會產生 Pipeline 的那些 op（`create`、`rename`、`reset_builtin`）另外帶 `pipeline`。新建的 Pipeline 是空的，也不會被設為作用中，所以在 `stage_define` 給它 Stage 之前跑不起來。最後一個 Pipeline 完全不能刪；而刪掉一個 Pipeline 不會停下或倒回已經啟動的執行 —— 那一輪保有自己記錄的 `pipeline_id` 與已經開出來的 Pane，壞掉的是「之後要恢復它」，因為它指名的樣板不見了 |
| `stage_define` | `op`、`pipeline_id`、`stage_id`、`stage`、`ids`、`workspace_path` | 在一個 Pipeline 裡新增、編輯、移除、重新排序或重新灌入它的 **Stage**。一個 Stage 是一個步驟，裡面裝著會變成 Pane 的 Slot：每個 Slot 指名一個 CLI（`agent_key`）與一個 Role（`role_key`），並帶著那個 Pane 啟動時要用的 Kickoff 文字。`pipeline_id` 留空代表**作用中**的那個 Pipeline，也就是 Pipelines 視窗選定的那個，不一定是你剛才在讀的那個 —— 請明寫。回傳 `{ok, op, stages, pipeline_id, pipelines, active_pipeline_id}`，`upsert` 另外帶 `stage`。一個 Pipeline 的最後一個 Stage 不能刪 |
| `role_define` | `op`、`key`、`new_key`、`label`、`one_line`、`system_prompt` | 建立、編輯、更名、刪除或重新灌入 Slot 選角用的 **Role**。Role 就是一段有名字的 System Prompt：Slot 以 `role_key` 指名一個，而那個 Slot 開出來的 Pane 就以這段 Prompt 啟動。Role 是整台機器共用的 —— 不分 Pipeline、不分 Workspace —— 所以這裡改一次會影響每個指名該 Role 的 Pipeline，也因此沒有 `workspace_path` 可以縮小範圍。回傳 `{ok, op, roles}`，`upsert` 與 `rename` 另外帶 `role`，`rename` 還帶 `repointed_pipeline_ids`。最後一個 Role 不能刪。已經開起來的 Pane 會保留它拿到的那段 Prompt；改動影響的是那個 Slot 下一次開出來的 Pane，不是螢幕上這些 |

**每個 `op` 各需要哪些參數。** 這是這三個 Tool 最容易用錯的地方：`op` 決定了其他參數
哪些是必要的，缺了就會回 `ok: false` 帶 `error_code: "missing_argument"`，而且什麼都
沒寫進去。不認得的 `op` 則是 `"bad_op"`。

| Tool | `op` | 需要 | 說明 |
|---|---|---|---|
| `pipeline_define` | `create` | `name` | 新增一個空的 Pipeline，連同產生出來的 id 一起回傳。不會被設為作用中 |
| `pipeline_define` | `rename` | `pipeline_id`、`name` | 就地更名；id 與 Stage 都不動 |
| `pipeline_define` | `delete` | `pipeline_id` | 有破壞性。執行進行中會被拒絕 —— 見下文 |
| `pipeline_define` | `set_active` | `pipeline_id` | 決定 Pipelines 視窗顯示哪個樣板，也決定 `pipeline_start` 沒帶 `pipeline_id` 時跑哪一個 |
| `pipeline_define` | `reset_builtin` | `pipeline_id` | 只有 `default` 與 `maintenance` 有種子資料。會把該 Pipeline 的每一個 Stage 換成種子那一組 |
| `stage_define` | `upsert` | `stage` | 一個完整的 Stage 物件，以 `stage["id"]` 比對：既有的 id 會被合併覆蓋（你沒給的欄位保留原值），新的 id 則附加到最後。Store 要求 `id`（只能是字母、數字、連字號、底線、點）與非空的 `slots`。形狀是 `{id, title, short_title, question, description, sentinel, recommended_roles, allow_questions, doc_query, slots}`，每個 Slot 是 `{agent_key, role_key, label, kickoff_body, is_commander}`。請先從 `pipeline_list` 讀一個出來照著改，不要憑空組 —— 但要注意 `pipeline_list` 刻意不給 `kickoff_body`，所以只靠它組出來的 upsert 會把它改寫到的那些 Slot 的 Kickoff 清空 |
| `stage_define` | `delete` | `stage_id` | 對一個 Pipeline 的最後一個 Stage 會被拒絕 |
| `stage_define` | `reorder` | `ids` | 你要的順序下的 Stage id。沒列到的 id 會維持彼此的相對順序排在後面；不認得的 id 與重複的 id 會被忽略。這個順序**就是**執行順序 |
| `stage_define` | `reset` | — | 有破壞性：`default` 與 `maintenance` 會放回內建的 Stage，而你自己建的 Pipeline 會**什麼都不剩** —— 這樣重置過的自訂 Pipeline 會變成空的、跑不起來。沒有復原，所以如果之後可能還想要它，先用 `pipeline_list` 讀出來留著 |
| `role_define` | `upsert` | `key`、`label`、`system_prompt` | `key` 是 1–32 個字元的小寫字母、數字、底線或連字號。**它會整個取代這個 Role**：你沒給的 `label` 或 `system_prompt` 會被寫成空的，而空值會被拒絕 —— 這也是唯一擋住「半套 upsert 抹掉一段 Prompt」的東西。`one_line` 是顯示在 Label 旁邊的簡短說明 |
| `role_define` | `rename` | `key`、`new_key` | 更名並在同一步把每個指名舊 key 的 Stage Slot 一起改指過去，所以不會出現「Slot 指著不存在的 Role」的中間狀態。這裡的 `label`／`one_line`／`system_prompt` 是選填：沒給的會從既有的 Role 沿用。`key` 不存在（`not_found`）或 `new_key` 已經被用掉（`role_key_exists`）都會被拒絕，因為把兩個 Role 併在一起等於無聲丟掉其中一邊的 Prompt |
| `role_define` | `delete` | `key` | 只要還有 Stage Slot 指名這個 Role 就會被拒絕 —— 見下文 |
| `role_define` | `reset` | — | 有破壞性：丟掉每一個 Role（自訂的也一樣），放回內建那一組。指著種子組沒有的 Role 的那些 Slot 會被清空，而不是留著懸空的指向，所以 Pipeline 活得下來，但那些 Slot 失去了 Role、必須重新選角。沒有復原 |

**執行進行中還去編輯會怎樣。** 當該 Workspace 有一輪執行處於 `running` 狀態時，
`pipeline_define` 的 `delete` 與 `set_active` 會直接被拒絕；`reset_builtin` 則是在
進行中的那一輪正用著該 Pipeline 時被拒絕。`stage_define` 的四個 op **全部**同樣被拒絕
—— 執行中途被改掉的 Stage 清單，等於在這一輪腳下換了流程。拒絕的形式是 `ok: false` 帶
`error_code: "pipeline_running"`，而且什麼都沒寫進去。一輪執行是跟它啟動當下記錄的
Pipeline 比對，所以明寫那個 Pipeline 也繞不過這道守衛；其他 Workspace、或跑著別的
Pipeline 的執行則不受影響。`workspace_path` 指的是「要檢查哪個專案的執行」——
它預設是呼叫端 Pane 自己的 Workspace，而一個沒有 Pane 又什麼都不給的呼叫端，等於完全
沒有守衛。落在兩輪執行之間的編輯會無聲地改變**下一輪**的行為，這正是要提醒使用者的情況。

`role_define` **沒有**執行守衛：Pipeline 在跑的時候照樣可以改 Role。它的 `delete` 守的
是另一件事 —— 只要還有 Stage Slot 指名這個 Role 就會被拒絕，而且拒絕（`error_code:
"role_in_use"`）會在 `usages` 裡列出那些 Slot，你可以用 `stage_define` 的 `upsert` 把
它們改指到別的 Role，或改成更名。指著已刪除 Role 的 Slot 會讓 Role 注入失敗，那個 Stage
的 Pane 會停在一個空 Prompt 前面，畫面上沒有任何東西說明原因 —— 這道拒絕就是為了這個。

這三個 Tool 還會回的 `error_code` 是 `not_found` 與 `invalid`（Store 拒絕了那個值）。
任何一種失敗都不會寫入。

### 排程

定時對 CLI Pane 送訊息。這六個 Tool 驅動的是與排程面板「NAVIDE JOBS」區（`scheduler.*`
WS 訊息）同一個後端排程器，所以在這裡建立的 job 會立刻出現在面板上 —— 每次變更都會廣播
`scheduler.changed`。job **只在 Navide 執行中觸發**；App 關閉期間錯過的槽，下次啟動時補跑一次
（`catch_up: "once"`，預設）或直接略過（`"skip"`）。無人值守會燒額度：每個 job 每日最多執行
`max_runs_per_day` 次（預設 24），失敗時退避 30s → 1m → 5m → 15m → 60m。

| Tool | 參數 | 作用 |
|---|---|---|
| `scheduler_list` | — | `{ok, jobs, now, limits}` —— 列出所有 job，包括你不能修改的。每個 job 帶有 `owner`（`{kind: "user"}`、`{kind: "pane", pane_id, pane_name, workspace}` 或 `{kind: "external"}`；agent 建的週期 job 另有 `expires_at`）、`updated_by`、`owner_gone`（建立者 Pane 已關閉）與 `editable`（你能否修改）。`limits` 為 `{agent_enabled_per_owner, agent_enabled_total, agent_enabled, agent_min_every_ms, agent_max_runs_per_day, agent_runs_per_day, agent_runs_today, agent_expire_ms, agent_once_keep_ms, yours_enabled}` |
| `scheduler_upsert` | `job` | 建立（不帶 `id`）或更新（帶 `id`）job；回 `{ok, job}`，定義不合法時回 `{ok: false, error}`。更新時只需傳要改的欄位：沒傳的欄位保留原值，`policy` 逐鍵合併，有傳 `action` 則整個驗證。`schedule` 是 `{kind: "every", every_ms, anchor_ms?}`、`{kind: "daily", at: "HH:MM", tz}` 、`{kind: "weekly", days: [1..7], at, tz}` 或 `{kind: "once", at_ms}` —— 也接受 `{kind: "once", in_ms}`，存檔時換算成 `at_ms = now + in_ms`（最多早於現在 1 分鐘、最晚 10 年後）。once job 只跑一次，跑完不論結果都會自動停用，所以「一小時後叫醒我」要用 `{kind: "once", in_ms: 3600000}`，不是 `every`；`action` 是 `{kind: "message", workspace, pane_id?, pane_name?, text}`；`policy` 可省略，為 `{catch_up, max_runs_per_day, timeout_s}`。Pane 呼叫端省略 `workspace` 時預設為自己的 Workspace，沒指定 Pane 時目標就是呼叫者自己的 Pane，而且只能指定自己 Workspace 裡的 Pane。更新只限自己建的 job |
| `scheduler_remove` | `id` | 刪除自己建的 job 與其執行紀錄 |
| `scheduler_set_enabled` | `id`、`enabled` | 暫停或恢復；恢復後等下一個槽，不會補跑暫停期間經過的槽。時間已過的 once job 無法恢復，會回 `{ok: false, error}`，請改設新的時間。只限自己建的 job；恢復時計入啟用中的上限 |
| `scheduler_run_now` | `id` | 立刻執行一次，不等結束就回 `{ok, enqueued}`；會清除失敗退避。只限自己建的 job，這次執行計入 agent 每日總量 |
| `scheduler_runs` | `id`、`limit` | 執行紀錄，新的在前：`{id, job_id, started_at, ended_at, status, reason, detail}`。任何 job 的紀錄都能讀 |

每次執行就是 `cli_send(open_target=True)`：被回收成 placeholder 的 Pane 會先被喚醒，
正在忙的 Pane 照常排隊。`pane_id` 精確指定一個 Pane；它若已不存在，這次執行記為略過
`target_gone`，絕不改送到同名的其他 Pane。其他略過原因 —— `no_window`、`busy`（這個 job
上一則訊息還在排隊）、`budget`，以及下方說明的 `budget_global` 與 `expired` —— 都不是錯誤，
也不會觸發退避。

**擁有權。** 每個 job 都記錄建立者（`owner`）與最後修改者（`updated_by`）。在 Navide 視窗建的
job 屬於使用者；透過這些 Tool 建的屬於呼叫的 agent。agent 只能更新、刪除、暫停／恢復或
`run_now` 自己建的 job，其他 job 一律回 `{ok: false, code: "SCHEDULER_NOT_OWNER", owner, error}`；
列表與執行紀錄則所有人都能讀。Navide 視窗代表使用者，可以修改任何 job。建立 job 的 Pane
關閉後，job 照常執行，但改由使用者管理（`owner_gone: true`）；之後同名的新 Pane 不會繼承，
面板上會出現「改為我的」。在記錄建立者之前就存在的 job 一律屬於使用者。Pane 只能指定自己
Workspace 裡的 Pane（否則回 `{ok: false, code: "SCHEDULER_CROSS_WORKSPACE", error}`）。沒有
Pane 身分的呼叫端（host 或外部 client）同樣比照 agent：它們共用同一個 `{kind: "external"}`
擁有者；因為沒有自己的 Workspace，不套用跨 Workspace 的規則。

**agent job 的上限**（使用者自己建的 job 不受限）：

| 上限 | 數值 | 超過時 |
|---|---|---|
| 每個 agent 的啟用中 job | 10 | 再新增或啟用會被拒絕（`limit: "per_owner_enabled"`） |
| 全體 agent 的啟用中 job | 100 | 再新增或啟用會被拒絕（`limit: "global_enabled"`）；使用者的 job 不計入 |
| 最短間隔 | `every_ms` ≥ 300000（5 分鐘）；`max_runs_per_day` ≤ 288 | 存檔被拒絕（`limit: "min_every_ms"` 或 `"max_runs_per_day"`） |
| 全體 agent job 每日執行次數 | 300（以本機日期計） | 排定的時段記為略過 `budget_global`；agent 的 `run_now` 會被拒絕（`limit: "agent_runs_per_day"`），且 `run_now` 也計入總量。刪除 job 不會歸零 |

超過上限時回 `{ok: false, code: "SCHEDULER_LIMIT", limit, max, used, error}`；`max` 是上下限值
（`min_every_ms` 時為最小值）。agent 建的週期 job 在擁有者最後一次儲存或啟用、或任何人重新
啟用的 7 天後自動停用（略過原因 `expired`）；使用者可以設為保留、不再到期。agent 建的 once
job 跑完 30 天後自動刪除。

### CLI 權限

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_permission_settings` | `yolo`、`workspace_path` | 讀取或變更那個「讓 CLI 略過權限詢問」的全域開關。不帶參數呼叫就只是讀；給了 `yolo` 就是設定。回傳視窗自己的 `{ok, result, error}`，`result` 是 `{yolo, agents}`，`agents` 每個 CLI 廠商一筆 —— `{agent, mode, skipFlag}`。`ok` 為 false 帶 `error_code: "ui_no_window"` 代表沒有 Navide 視窗可以問 |

「Yolo」是 Navide 對「Spawn 時傳給 CLI 的權限略過旗標」的稱呼（Claude 的
`--dangerously-skip-permissions`，以及各廠商的對應旗標）。把它打開，意思是 Navide 起的
那些 CLI 在編輯檔案、執行 Shell 指令、發網路請求之前不再詢問，改成自己判斷。這是使用者
自己要做的決定 —— 不要為了讓自己的工作越過一個詢問而去打開它。

**它不是 Pipeline 範圍，也不是 Workspace 範圍。** 它是整個 App **唯一一份**設定，存在
使用者設定裡，而且每一條啟動 CLI 的路徑都會讀它：手動開的 Pane、Pipeline 的 Slot、
視窗內建的 CLI 面板、恢復與還原，全都一樣。變更只對**之後**啟動的 CLI 生效 —— 已經在跑
的行程保留它啟動時帶的旗標，所以關掉它並不會回頭影響一個已經在跑的 Pane。這裡的
`workspace_path` **純粹是定址用**：它決定要問哪個視窗，不是決定變更套用到哪裡。每個視窗
給的答案都一樣，透過任何一個視窗寫入也會影響全部，所以它預設是呼叫端 Pane 所在的視窗，
而一個沒有 Pane 又什麼都不指名的呼叫端，就是拿到當下開著的任何一個視窗。這個設定沒有
「換一個路徑就能拿到的專案版本」。

**只讀 `yolo` 會誤導你。** 每個廠商有自己的 `mode`，而且它**蓋過**全域開關：`inherit`
跟著全域走，`force-on` 與 `force-off` 則不理它。所以 `yolo: true` 不代表每一家 CLI 都會
略過，`yolo: false` 也不代表沒有一家會。單一 CLI 的答案在 `agents[].skipFlag` —— 那是
該廠商此刻真的會被帶著啟動的旗標，空字串代表不帶。完全沒有略過旗標的廠商（grok、
opencode、pi）不管開關怎麼設都永遠是空的。

## Resources

三個唯讀 URI。Resource 是 Client 代表使用者去列出與讀取的 —— 把某個 Resource 附進
對話是「人」的動作，不是 Agent 被說服去做的事 —— 所以這三個一律唯讀，而且每一個都
是既有 Tool 所服務資料的另一種呈現，不是第二套實作。

| URI | 名稱 | 回傳什麼 |
|---|---|---|
| `navide://workspace/plans` | `workspace_plans` | `{workspace_path, plans}` —— 你的 Workspace 底下 `.agent-team/plans/` 的 Plan 文件索引，跟 `plan_list` 回傳的是同一份清單，以 JSON 呈現 |
| `navide://workspace/plan/{rel_path}` | `workspace_plan` | 單一份 Plan 文件：`{rel_path, meta, html}`，經由 `plan_read` 自己的路徑防護讀取 |
| `navide://panes` | `panes` | 你可以傳指令過去的 CLI Pane，跟 `cli_list_targets` 回傳的是同一份名冊，以 JSON 呈現 |

Resource 讀取的驗證方式與 Tool 呼叫完全相同：解析的是同一個呼叫端，沒接線的呼叫端
也以同樣方式被拒絕。兩個 Workspace Resource 取的是呼叫端自己的 Workspace，沒有任何
參數可以指名別的專案，所以它們是給 Pane 呼叫端用的 —— 外部 Client 沒有 Pane 身分，
也就沒有可供解析的 Workspace。

**`rel_path` 只吃單一 URI 區段。** SDK 的 Template 參數是用 `[^/]+` 比對的，所以它
帶不了原始的 `/`：裸檔名可以直接用，完整的 `.agent-team/plans/<file>` 形式則必須
Percent-encode（`.agent-team%2Fplans%2F<file>`）。這個值會在解析之前先被 decode，而
這正是那道防護有實質作用、而不只是裝飾的原因 —— `%2E%2E%2F` 到達檔案系統時就是
`../`，`plan_read` 會拒絕任何離開 plans 子樹的路徑。

## Prompts

三個給**使用者**填的樣板，不是寫給模型看的說明：Client 會把它們呈現給人，通常是
一個斜線指令，回來的內容會被插進他的訊息裡。所以每一個都渲染成一段填好、送出後
本身就站得住的指示。

| Prompt | 參數 | 它要求什麼 |
|---|---|---|
| `delegate_to_pane` | `target`、`task` | 用 `cli_send` 把 `task` 送給 `target` 這個 CLI Pane，然後停下來等它回覆，而不是自己動手做 —— 位址不在名冊裡就先跑 `cli_list_targets`，並且回頭問使用者指的是哪個 Pane，而不是自己猜一個相近的名字。送出的訊息裡會要求 `target` 做完之後用 `cli_send` 回報 |
| `start_pipeline` | `task` | 為 `task` 啟動這個 Workspace 的 Pipeline 執行 —— 但要先讀 `pipeline_status` 確認沒有一輪已經在跑、讀 `pipeline_list` 看會開出哪些 Stage，把「即將開出什麼」講給使用者聽（這會消耗 CLI 額度），等他說開始。之後回報這一輪是不是真的啟動了，沒有的話說出視窗給的理由 |
| `review_plan` | `rel_path` | 先用 `plan_read` 讀 `rel_path` 這份 Plan 文件，然後以審查者的角度走一遍，並對照程式碼查核它做出的宣稱。每一項發現都用 `plan_add_note` 記在文件本身上（一項一則、具體到可以據以行動），而不是只在對話裡講，最後再說這份 Plan 依現況是否可以核准 |

## Pane 的 id 活得比 Pane 久

CLI Pane 的連線 URL 只在 Pane 生成的那一刻寫入一次，CLI Process 只要還活著就一直
帶著它。裡面的 `pane=<id>` 是那一刻的 Pane id —— 而 Pane id 屬於 Pane 本身，不屬
於裡面的 Process。重載視窗、把 Run Group 拆出去、或把它收回來，都會用同一個還在跑
的 CLI 重建一個 Pane 並發給它新的 id，於是 URL 裡留下的是舊的那個。

那個舊 id 仍然有效。視窗會記下它去了哪裡，所以帶著舊 id 的呼叫會以「這個 Process
實際附著的 Pane」的身分被回答：`plan_*` 預設的 Workspace 一樣、`cli_list_targets`
裡的 `you` 一樣、`cli_send` 用來判斷裸名與自寄的身分也一樣。重載兩次也不會斷鏈 ——
每一跳都會被壓平到當前的 Pane —— 而且 id 永遠不允許跟著 Pane 跨到別的 Workspace。

id 不只是身分，也是一個位址。`cli_send`、`cli_send_and_wait`、`cli_read_log`、
`cli_get_status`、`cli_wait_idle` 都吃一個 `pane_id`，用來取代它們原本的位址參數；
當一個 Workspace 裡有兩個 Pane 同名時，這是唯一搆得到其中某一個的辦法 —— 同時對應
到兩者的名稱會以 `ambiguous-target` 被拒絕，而不是隨便猜一個。它走的是同一張表，所
以一個撐過重載或 detach 的 id，會定址到它一路跟過去的那個 Pane。它撐不過的是用一個
**全新**的 CLI 重建出來的 Pane：那條路徑不會宣告任何舊 id，於是那些 Tool 會回
`unknown-pane-id` —— 意思是「去 `cli_list_targets` 讀一個新的 id」，不是「那個 Pane
不見了」。遠端 Pane 的 id 是另一台機器的名冊鑄出來的，不算這裡的 id，所以跨裝置的目
標仍然要用名稱定址。

Pane 的[Push 通道](inter-cli-messaging.md#push-通道)大致也是這樣跟著走，但有一個例外。
重載視窗會保留通道，Run Group 從拆出的子視窗收回來也會。**拆出（detach）**則不會：
交出 Pane 的那個視窗會在接收端認領它之前就先釋放 Pane、連同通道一起，所以被拆出的
Pane 會回到「用打字送訊息」的舊行為，直到它的 CLI 重新啟動為止。claude Pane 不受影
響：它的 hook 會在下一次回合結束時自行重新掛上。

「哪個 id 被哪個取代」是由 Navide 視窗宣告的，而且會被直接採信 —— 因為 detach 時被
宣告的那個 id 本來就還活著、而且屬於正在放手的那個視窗，所以「宣稱一個仍活著的
Pane」與「合法的交接」在後端無法分辨，只會記 log 而不會拒絕。真正不可逆的那件事則
另外擋掉：只要還有連線中的視窗在鏡射某個 Pane，它的推送通道就不會被任何人拿走。

有一個已知情況會在沒有實際交接的前提下印出那則警告：主視窗在某個 Run Group 已被拆
出時重載，它會在得知該 Group 已經在別處之前就先還原那個 Group 的 Pane，因而短暫地
宣告了子視窗的 id。一旦主視窗被告知就會自行修正，而子視窗的 Push 通道從頭到尾不會
被拿走。

仍然會被拒絕的，是一個什麼都指不到的 id：Pane 已經關閉，或擁有它的視窗離開夠久已
被遺忘。此時沒有任何身分可以代表，因此這個 Endpoint 上的每個 Tool 都會回
`this pane's id is stale`，解法是重新開啟該 Pane。（這跟上面排隊訊息上的 `stale`
是不同的字：那個只是說訊息已經等了超過兩分鐘。）

這跟下面的 Tool **清單**不是同一個問題。清單是 Client 連線當下拍下的快照，Navide
無從更新；id 則是 Navide 每次呼叫都重新解析的。

## Tool 清單只讀一次

MCP Client 會在連線時向 Server 索取一次 Tool 清單，而 Navide 的 `/plan-mcp` 之後
永遠不會改動它。因此**Client 在那一刻看到什麼，就一直留著什麼**：

- **CLI Pane** 會在它的 CLI Process 啟動時把清單拍成快照。Navide 更新時就已經在跑
  的 Pane，講話的對象是一個不復存在的 Backend；請重新開啟該 Pane，才能取得較新版
  Navide 新增的 Tool 或參數。
- **外部 Client** 會保留它的清單，直到你重新連線為止。反正 Connection URL 會隨著
  重新啟動而改變（Port 是啟動時挑的），所以這件事通常會自己解決。

升級之後 Navide 會說一次，就在狀態列的公告串流裡：一則「MCP tools may have
changed」項目，指出它取代的是哪個版本。它只在這次 Backend 確實以不同於上一次的版
本啟動時才出現 —— 全新安裝時不會，一般重新啟動時也不會。

### 為什麼 Navide 不乾脆通知 Client

協定其實有對應的做法 —— Server 宣告 `tools.listChanged` capability，之後在它的
Tool 集合改變時送出 `notifications/tools/list_changed`，而會處理它的 Client 就會在
Session 中途重讀清單。Navide 不能用它，有兩個彼此獨立的原因。

**這個 Transport 沒有地方可以推。** `/plan-mcp` 以 stateless 模式執行 streamable
HTTP 並回應 JSON：Transport 是每個請求建立又拆掉的，不會有任何 Stream 保持開啟。
在那種組態下，由 Server 發起的通知沒有路徑可以抵達 Client —— MCP SDK 會把它送往一
條長壽的 Stream，找不到，然後丟棄。要讓它送得到，就得改跑 Session 導向的模式，而
那正是這個 Endpoint 刻意不採用的狀態。（2026-07-28 版的規格移除了協定層級的
Session，並把這些通知移到由 Client 開啟的 `subscriptions/listen` Stream 上 ——
不論哪一種，都是一條保持開啟的 Stream。）

**有一半的 CLI 會忽略它。** 依各 Client 自己的原始碼或文件查核，2026-08-17：

| CLI | 收到 `list_changed` 會重讀 Tool 清單嗎？ |
|---|---|
| Claude Code | 會，自 2.1.0 起 |
| GitHub Copilot CLI | 會 |
| OpenCode | 會 |
| Grok | 會 |
| Codex CLI | 不會 —— 記錄該通知然後什麼也不做 |
| Cursor（`cursor-agent`） | 不會 —— 要用 `/mcp` 手動重新整理 |
| Qwen Code | 不會 —— 這個 fork 拿掉了上游 Gemini CLI 有的處理器 |
| Kimi CLI | 不會 —— 完全沒有通知處理 |

而且無論如何也沒有什麼好通知的：`/plan-mcp` 的每個 Tool 都在 import 時註冊，而這
組集合在 Backend 執行期間永遠不變。重新開啟 Pane 就是全部的解法，這也是為什麼它被
寫成文件，而不是用工程手段繞過。

## CDP debug（逃生口）

Settings → MCP → External access 底下另有一個 **Chrome DevTools Protocol**
開關（[`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts)，設定位於
`userData/cdp-debug.json`）。啟用它需要重新啟動 App —— Electron 只有在 App
ready 之前設定 `--remote-debugging-port` 才會採納 —— 而且該 Debug Port 只綁定在
`127.0.0.1`。

這是備援手段，不是主要的整合路徑：凡是上面 Tool 目錄涵蓋得到的，都請用 Tool
目錄。CDP 存在是為了那些涵蓋不到的事 —— 對實際算繪出來的視窗截圖，或驅動沒有
註冊 `ui.*` Action 的東西。因為它能做的事（見下文），請把它當成最後手段。

## 安全模型

| 啟用這個…… | ……代表 |
|---|---|
| **Allow external MCP clients** | 只要開著，這台機器上任何執行中的東西都能控制 Navide：Spawn 與關閉 Pane、對任何已開啟 Workspace 中的任何 CLI Pane 送出指令、開啟 Plan／Git／Pipeline 視窗，以及讀取另一個 Pane 的對話記錄。 |
| **CDP debug** | 只要開著，這台機器上任何執行中的東西都能在 Navide 的 Renderer 內執行任意程式碼 —— 完整的遠端偵錯存取權，不受任何 Tool 契約限制。 |

實務注意事項：

- 兩個開關都只綁定 `127.0.0.1` —— 不會暴露到 LAN 或遠端 —— 但在共用機器上，
  「這台機器」包含其他每一個本機使用者帳號，以及每一個以你的身分執行的 Process。
- 外部 Token 是 Bearer Secret：任何人只要拿到 Connection URL，在你重新產生
  Token 之前都擁有完整的外部存取權。它以明文儲存在 App Data 目錄下的
  `plan_mcp_auth.json`。
- 透過這些 Tool 進行的檔案系統寫入，仍受 Backend 其餘部分所用的同一道路徑防護
  約束（`fs_service._resolve_safe`）—— Plan 相關 Tool 只能寫入某個 Workspace 的
  `.agent-team/plans/` 之內。UI Action 與 CDP 沒有等價的 Sandbox：UI Action 會做
  它在 `App.vue` 中的 Handler 所做的任何事，而 CDP 則是不受限制的程式碼執行。
- 用完那些需要它們的工作之後，請把外部存取與 CDP 關回去；兩者都不該預設一直開著。

另見：[隱私與資料流](privacy.md)，說明 Navide 一般性的 Local-first 資料立場；
以及 App 內 Settings → MCP 底下的「說明」分頁，說明每個 Pane 自動具備的那兩個
方向。
