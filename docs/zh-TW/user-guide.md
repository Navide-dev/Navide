# 使用指南

[English](../en-US/user-guide.md) | 繁體中文 | [日本語](../ja-JP/user-guide.md) | [文件中心](README.md)

## 產品模型

Navide 為一位工程師指揮多個 AI Agent 而設計。主要互動不一定是編輯檔案，而是設定成果、協調 Session、觀察進度、處理重要例外，並接受經過驗證的結果。

日常工作透過三種循環推進：

1. **Genesis** 使用 Pipeline，將想法轉化為第一個可運作 Prototype。
2. **Evolution** 透過一個或多個 Agent Session，反覆開發、測試、修正並微調現有專案。
3. **Intervention** 讓工程師透過 Diff、Editor、Terminal、Diagnostics、Git 與 Review Tool 檢查或直接修改成果。

目前 Pipeline 實作 Genesis 循環；Manual Pane 與 Maintenance Mode 提供早期 Evolution 工作流；Editor 與 Review 介面提供 Intervention。

## Runtime 心智模型

Navide 有三個工作層級：

1. **Workspace** 是專案資料夾，也是 Project State、Run History 與 Git Operation 的邊界。
2. **Pane** 是執行 Agent CLI 或一般 Shell 的 Live Terminal Session。
3. **Pipeline** 是一組依序執行的可設定 Stage。每個 Stage 包含一個或多個平行 slot，每個 slot 選擇 Agent 與 Role。

## Workspace

Welcome Screen 會列出 Recent Workspace、支援 Pin，並標示遺失的 Folder。開啟 Workspace 時會恢復其 UI State 與符合條件的 Session。切換或關閉 Workspace 前，請先完成或中止不能被中斷的 Active Work。

Navide 將個人私有 Project Intelligence 儲存在 Workspace 內的 `.agent-team/`。這個目錄排除於 Git，不應視為團隊共用狀態。它可能包含屬於個人工程流程的 Task Context、Session Metadata、Run History、Handoff 與 Token Information。

原始碼與明確分享的文件仍然是 Repository 裡團隊可見的事實。如果需要分享 `.agent-team/` 中的資訊，應將它轉換為刻意建立的 Artifact，例如 Specification、Architecture Decision、Test Report、Issue、Commit 或 Pull Request。

## Manual Agent Pane

探索、維護或不需要完整 Genesis Pipeline 的 Evolution Task，可以使用 Manual Spawn。

- 選擇 Agent 與 Role。
- Spawn 前檢查 Launch Command。
- 不需要 Agent 時使用一般 Terminal Pane。
- 將 Pane 最小化可以保留 PTY，同時避免占用主要 Layout。
- 只有 Navide 偵測到可重用 Session ID 後，才進行 Rebuild 或 Resume。

在 Auto、Spotlight 與 Fullscreen Layout 中，重新整理右側的三角形按鈕（工具列順序：**+ → 重新整理 → ▾/▸**）可收合或展開目前分頁的後代卡片群組，行為與父卡片後代數量外框旁的三角形相同。只要任何符合條件的群組仍展開，就會全部收合；全部收合時，則會展開所有群組，包含先前個別收合的巢狀群組。符合條件的父 Pane 必須有後代且未最小化。

收合會隱藏後代卡片，保留最上層父卡片、後代數量與主終端機。各分頁的群組狀態互相獨立，僅保留於目前視窗的記憶體中。Grid Layout 或目前分頁沒有符合條件的父群組時，批次按鈕會停用。

父卡片的後代數量涵蓋它派生的所有 Pane；即使後代已最小化、位於其他分頁或其他工作區，展開群組後都找得到。這類列會附上位置提示（**已縮到側欄**、**分頁：名稱**、**工作區：名稱**；名稱過長時截斷，滑過可看完整文字）。展開只改變清單內容；點選後代列時，會沿用左側代理清單的流程，切換到它的工作區與分頁、必要時還原，再聚焦。對這類列按 Cmd/Ctrl 或 Shift 點選，只會依清單順序加入選取，不切換分頁，也不還原。批次按鈕仍只作用於目前分頁且未最小化的父 Pane。派生的 Pane 有狀態需要注意時，Auto 與 Fullscreen 的父卡片第二列會顯示可讀摘要（Spotlight 縮圖只顯示位置提示），例如 **1 個子視窗執行中**，說明後代中最需要注意的狀態與其數量。

A new empty Codex pane waits for your input without sending an artificial session-discovery message. Its session ID may become available only after the first real user or configured task turn; until then, Rebuild remains unavailable. The same applies to a fresh rebuild or restore. If Codex asks to review the Navide session hook, review it in Codex; YOLO mode does not approve hooks. Existing shared session homes may need that trusted hook to associate the new conversation with its pane.

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

受支援的內建 Agent Key 涵蓋 14 種 coding CLI：Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code。實際 CLI 行為與 Provider Billing 仍由各外部工具控制。

對 Kimi Code Pane，Navide 會提供 100 ms 的 Escape Sequence 重組時間，讓方向鍵在內嵌 Terminal 中仍能可靠導覽；若環境已有 `PI_TUI_ESC_TIMEOUT`，則仍以既有值為準。

### CLI risk observations

An active agent pane can show one yellow or red risk pill. Open its popover to inspect the backend's evidence and observation times; multiple findings share that popover. Disk findings apply to the vendor's active panes, while network findings belong to the observed pane's process tree, including its CLI, MCP servers and tools. Reclaimed placeholders show no risk pill.

- **Yellow network:** a sampled numeric IP and port fall outside a complete, current expected-address snapshot. The count is from the last sample, and “observed since” describes sampled observations, not connection duration. Legitimate tools, proxies and different DNS answers can produce a mismatch.
- **Yellow disk:** after a successful baseline, a file first observed following prior absence qualifies within 24 hours if it exceeds 100 MiB and bounded content inspection does not recognize its format. Files already in the baseline are excluded; timestamps and familiar extensions alone do not establish that a file is new or recognized.
- **Red disk:** a previously flagged path was successfully observed present, then absent, then present again with opaque content in the same 100 MiB size class. This does not identify who removed or recreated it, or establish that its contents are the same.

**Ignore** persists for the displayed vendor/IP across all ports, or vendor/canonical file path, including later severity changes. **Allow this IP** adds only the displayed exact IP for that vendor across all ports; it does not allow an inferred hostname or certify the destination. Both decisions apply across that vendor's panes and survive restart. Disk **Reveal in folder** opens the existing native folder action so you can inspect the file.

Observations use existing resource requests: normally every 30 seconds, or every 2 seconds while the resource panel is open. Disk attempts, including failed attempts, are throttled to once per five minutes per active vendor. Work finishes in the backend and appears in a later response; opening Storage is unnecessary. Descendant discovery and polling can delay network evidence, and short-lived connections or file replacement between samples can be missed.

Default network declarations currently cover Claude Code and Codex; other vendors have no expected-address comparison. Captured proxy or provider-endpoint overrides disable that comparison. Network observation covers established TCP on macOS and Linux; Windows network observation and UDP/QUIC are unsupported. Disk roots are declared per vendor, with Aider unsupported; symlinks beneath a resolved data root are skipped. Roots use the captured pane home and declared environment overrides; later changes inside CLI settings, command arguments or shell startup scripts can fall outside that snapshot. Failed or incomplete collection, unavailable declarations and expired DNS must not be read as a clean result. Historical findings can remain visible as stale evidence. **No pill is not an assurance of safety.**

These observations help you inspect local activity; they do not prove exfiltration or unlawful intent. Navide does not automatically block a connection, pause a CLI or delete a file. See [Privacy and Data Flows](privacy.md#cli-risk-observation-data) for local reads, retained metadata and DNS requests.

## Pipeline

內建 Pipeline 涵蓋 Requirements、Planning、Design、Implementation、Security Review 與 Testing。Stage、slot、Role、Kickoff Prompt、Question 與 Completion Sentinel 都在**流程管理**中編輯（Window ▸ 流程管理，或側欄 Pipeline 分頁的 ⚙ **管理 pipeline** 按鈕）。它的**泳道**與**畫布**檢視以步驟圖的形式編輯同一個 Pipeline；**執行紀錄**列出每一輪執行與其控制按鈕。新的一輪仍從側欄啟動：輸入任務後按 Run。

- **核准閘門（Gate）。** 從元件面板加入，讓執行在兩個步驟之間暫停；它的**要檢查什麼**說明審核者該看什麼。執行等待時，編輯器上方會出現帶**前往核准**的橫幅，閘門提供**核准並繼續**或**退回修改**，可附上給 agent 的意見。側欄的 Next 不會越過閘門。
- **退回迴圈（Loop）。** 在畫布檢視中，從步驟底部的把手拖到上游步驟。之後按**退回修改**，就會從那個步驟起重跑，並把你的意見放在它的 Kickoff 前面。迴圈最多重跑它 **↺ 最多** 標籤上的次數（預設 2，上限 10）；用完之後再退回，這一輪就以失敗結束。
- **凍結產出（Pin）。** 在 Inspector 中凍結的步驟，之後的執行會跳過它並沿用它上次的產出。
- **從這裡重跑（Restart from）。** 在步驟的 Inspector 中，當這個 Pipeline 有一輪已停止的執行時，可從該步驟開始新的一輪，並保留前面步驟的產出 —— 比全部重跑的**重新開始**便宜。

第三個內建範本 **提案落地流程**（id `evolve-landing`）是已核准的自我優化提案在你或指揮 pane 派工之後走的路：實作 → 唯讀審查 → CI 檢查（回報 workflow run 各 job 的結果，不 rerun、不合併）→ 只有你能通過的核准 gate。它只是範本：不會自動啟動、不會被設成目前使用的 pipeline，也沒有合併、上架、載入外掛、投遞 skill 或建立排程的步驟。Navide 只會把它加進既有的 pipeline 清單一次；你刪掉後不會再補回來。**Reset** 會還原它的步驟和 gate。和其他內建範本一樣，名稱寫在種子裡，不隨介面語言翻譯。

一個 Stage 可以平行執行多個 slot。Navide 會根據設定的 Completion Signal 與 Agent State 推進。務必檢查生成變更與測試結果；自動完成只代表工作流進度，不代表成果正確。

## Manager 與 Worker 協調

其中一個 slot 可以擔任 Global Manager。Manager 會接收跨 Stage Context、將工作分派給 Worker、處理 Worker Question，並透過 Navide Routing Protocol 發出 Stage Completion Signal。

需要拆解或平行 Ownership 的任務適合使用 Manager。小型任務通常使用 Single-agent Stage，成本較低也較容易檢查。

## Automation Mode

- **YOLO** 會在受支援時傳入略過 Approval 或 Trust Prompt 的 CLI-specific Flag。某些 CLI 可能原本就不會要求 Tool Confirmation。
- **Full Auto** 允許 Analyzer 根據可用 Task Context 自動回答 Agent Question。
- **Strict** 在特定 Timeout 或 Progression Boundary 要求確認。
- **Continuous** 根據設定的 Automation Behavior 持續推進 Pipeline。
- **Local Analyzer** 啟用本機 Intent Classification 與相關 Automation。

請從保守設定開始。YOLO 與 Full Auto 可能讓 Agent 在沒有再次取得使用者確認的情況下修改檔案或執行 Command。

## 例外管理

Navide 的長期運作哲學，是讓 Agent 在可逆、可觀察的工作中持續執行，只有人類判斷真正有價值時才將注意力交還給工程師。目前 Automation Mode 是早期控制方式，不是完整 Policy Engine。

以下情況應該介入：

- 需求存在多種實質不同但都合理的解釋
- 架構或產品選擇具有長期影響
- Session 在 Ownership、File 或技術方向上衝突
- Test 與明確 Acceptance Criteria 不一致
- 涉及 Credential、Payment、Deployment、Publication、Destructive Operation 或 External System
- 成果需要主觀產品或品質判斷

例行探索、可逆修改、本機測試、診斷與修正，未來應該能在沒有 Approval Noise 的情況下繼續，同時保持可見與可中斷。

## History 與 Token Tracking

History 是 Pipeline、Stage、Pane、Question、Analyzer、Handoff 與 Warning Event 的 Append-only Timeline。Run History 儲存在 `.agent-team/runs/`，並可篩選或 Export。

Token Stats 解析相容的本機 CLI Log，將 Usage 歸屬到 Workspace、Pane、Stage 與 Run。它是 Observability Feature，不是 Provider Invoice；Provider 端 Usage 與 Billing 才是最終依據。

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

### Turn Stats 的帳號額度

從 **Window → Turn Stats** 或 TOKENS 面板開啟。**Pane 用量**顯示單一
session；**帳號額度**顯示此 Navide 安裝歸屬到帳號的所有 pane、所有模型活動。
即使沒有開啟 pane，仍可查看保存帳號、歷史帳號、已移除帳號與獨立的 Unknown。
開啟歷史與「重新讀取歷史」只讀本機資料；供應商重試沿用既有輪詢政策，不會
自動啟用已停用的輪詢。

目前供應商讀值對應選取帳號與視窗，分別標示快取、過期、失敗或停用狀態與
觀測時間；歷史讀取時間另列。所有帳號檢視顯示彙總本機活動，不顯示單一帳號
的目前百分比。特定模型的額度百分比與所有模型的本機 token 範圍不同。

週期預設最近 30 天，可選 90 天或自訂 UTC 日期。依半開範圍內的重設時間
選取週期；範圍到達現在時包含進行中週期。表格與圖表每頁最多 50 筆，摘要
與符合／排除平均條件的筆數涵蓋整個範圍。使用週期按鈕或圖表查看證據来源、
完整本機及 UTC 時間、用量明細、變動讀值與重新核算時間。每觀測百分點的
本機 token 是總量除以非零觀測峰值，不代表供應商容量或價格。

平均只納入已結束、限額證據可信且本機明細可用的週期。CLI 限額訊息可與
較早、低於 100% 的供應商峰值並存；舊來源未知的時間仍可查看並標示未驗證。
缺失或部分明細呈現空缺，確實觀測到的零仍為零。本機用量採五分鐘切片，
邊界不按比例拆算；保存期限內的晚到資料可重新核算已結束週期，已保存的
最終總量不因來源切片到期而歸零。

月／年維持 **UTC 曆期**。日期範圍選取有交集的完整曆期，並顯示展開後邊界。
token 依事件時間，週期數依開始時間（未知時用重設時間）歸期。視窗篩選只
影響週期統計，不加總互相重疊的額度視窗。本機活动占比採同一曆期的資料，
覆蓋不完整時不捏造完整比例。

「匯出選取範圍」以單次一致回應匯出全部選取記錄，最多 10,000 筆，超過時
須縮小日期範圍。CSV 包含帳號身份、證據、覆蓋、平均資格、UTC 時間與時區。
部分／不可用的 token 數值留空，修正舊版缺值當零的行為；已知零值維持 `0`。
實際鍵盤、主題、語言及額度重設驗收與自動化 fixture 檢查分開進行。

## Git 與 Review

Navide 內建官方 Git Factory Package。其 Active Package Version 會同時提供嵌入式左側 View 與獨立 Git Window。Bundled Git 不能移除，只能在 Extensions 停用（見下文）。若存在已驗證的 Marketplace Version，會優先使用該版本。Git View 支援 Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue 與相關工作流；Multi-repository Workspace 可以在偵測到的 Repository 間切換。Discovery Scan 不會阻塞 Backend，並會在慢速 Filesystem 上經過受限的掃描時間後回傳部分結果。Repository Operation 仍經由 Navide Host／Backend 邊界處理；GitHub 與 GitLab Issue Detection 在可用時使用設定的 `gh` 或 `glab` CLI。若選定的 v2 Package 無法 Load、Mount 或回報 Ready，Navide 會明確標示並在該次 Process 使用保留的 Legacy Git Renderer；Security、Trust 或 Permission Denial 不會觸發 Fallback。

Commit 前務必審查變更，特別是在 Automation 或 Parallel Run 之後。Agent 生成的變更不會因為顯示在 Git Panel 中就自動變得安全。

## Editor 與 AI Terminal

Editor 使用 Monaco，並提供 File Editing、Diagnostics、Plan Rendering、Diff、Conflict 與 AI-assisted Workflow。右側 AI 面板內嵌真實的 Coding Agent CLI Terminal（與主視窗相同的 Agent），啟動時會自動注入 Editor 情境。

這些工具是更大工程環境的 Intervention 介面。Navide 的目標，是最終提供完整專業工作流，而不必使用傳統 IDE 作為主要環境。

## 透過 Navide MCP 管理 Skills

已獲授權的 Agent 可使用與 **設定 → Skills** 相同的共用庫：

1. 呼叫 `skills_list`，再把回傳的 ID 傳給 `skills_inspect`，讀取指示、檔案、所有權、來源紀錄與目前的 `delivery_revision`。
2. 呼叫 `skills_prepare_install`，來源可用 `owner/repo`、HTTPS `github.com/owner/repo` URL 或本機 skill 資料夾的絕對路徑（支援展開 `~`）。GitHub 的 `ref` 與 `subdir` 分開提供；`subdir: "."` 選擇 repository 根目錄。多個候選會回傳 `selection_required` 與 `candidates`，不產生可安裝的 preview ID；選好路徑後重新 prepare。不支援私人 repository、任意 URL 或 GitHub tree URL。
3. 檢視完整指示、檔案清單、腳本警示、來源與 digest，再以 preview ID、相同 digest 及明確 targets 呼叫 `skills_install`。這只會送出請求：使用者在 Navide 視窗核准或拒絕（核准同時代表同意首次寫入共用根），結果以 `skills_install_status` 查詢；Agent 無法代使用者核准。任何同名受管、使用者或原生 skill 都會拒絕。安裝獨占建立目的目錄，寫完附件與 metadata 後才發布 `SKILL.md`，讓掃描不會讀到半套內容；這不是整個目錄的原子 rename。
4. 之後用 skill ID 與最新 `delivery_revision` 呼叫 `skills_set_delivery`。過時 revision 會失敗，不覆蓋其他呼叫端的決定。只移除 CLI 或停用 skill 的變更會立即套用；投遞給其他 CLI 或啟用 skill 的變更，要像安裝一樣在 Navide 視窗經你核准。此流程只新增 skill，不更新或重新取得既有安裝。

準備的 bytes 綁定已驗證的呼叫端，15 分鐘後或 backend 重啟時失效；安裝不重讀本機來源或再次下載。許可重試可沿用尚未到期的 preview；重試收據仍保留時，成功重送只回傳原結果，不重複寫入。同時最多 8 份有效準備，另有最多 8 份不含套件內容的輕量完成收據。安裝成功即釋放套件 bytes 與有效準備名額。收據沿用原 preview 到期時間；快取滿時，最早安裝成功的收據優先淘汰。到期或淘汰後重送回傳 missing/expired，不重新安裝。GitHub archive 限壓縮 10 MiB、展開 32 MiB、4,096 個 entries；選定 skill 限 64 檔、每檔 256 KiB、總量 512 KiB。不安全路徑、連結、特殊檔、保留 metadata 與無效 manifest 直接拒絕，不靜默略過。

共用 skill 的 `targets: null` 代表所有 wired vendor，`targets: []` 停止 Navide 額外投遞。原生 skill 的 targets 指定其他 CLI，空陣列或 `null` 清除額外路由。自行掃描共用根的 CLI 仍可能讀到 skill，不受 Navide targets 或啟用開關全面限制；這些設定不是隔離界線。

`materialized_in_current_session: null` 與 `loaded_in_current_session: null` 表示目前 session 的實際投遞與載入尚未驗證；相容欄位 `delivered_to_me` 也只表示設定。改投遞後開新 CLI session 並在其中確認，安裝或路由回覆不能證明執行中的 CLI 已載入新內容。

本機來源收據記錄來源、準備時 digest 與時間，編輯、切換及重啟後仍可由 inspect 取得。digest 代表安裝快照，不代表之後的本機編輯。管理 marker 與來源收據不進入既有 export／Skills sync，不保證跨裝置保存來源。開啟 Skills sync 時，符合限制的內容與投遞決定仍可透過既有流程同步；符合套件限制不等於同步已完成。

Skills 畫面在 backend 成功變更與重新連線後刷新，保留未儲存內容及原 revision，讓過時儲存繼續產生衝突。其他程式直接改檔案仍需手動刷新。準備與安裝不執行夾帶腳本或 plugin hooks；日後使用 skill 仍受 CLI 工具與授權規則控制。

## Settings 與可攜性

**設定 → 語言** 是側欄中位於「外觀」之後的獨立頁面。可選擇繁體中文、English 或日本語；這項使用者層級偏好套用到所有工作區。初次啟動且尚未儲存語言偏好時，日文系統會使用日文介面。語言切換也會套用到初始設定畫面、Navide 原生選單標籤，以及獨立的 Plans 和 Token Monitor 視窗。作業系統提供的選單角色與外部內容可能保留各自的語言。

Settings 涵蓋 Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance、Keyboard Shortcut，以及獨立的 **Execution Policy** 分頁。Navide 停止 MCP Server 時（結束 Navide、重新載入，或 Server 啟動失敗），也會一併結束這個 Server 啟動、而且還在執行的所有程序，包括它替你開啟的程式，例如它開的瀏覽器。該分頁會顯示唯讀的 Host 預設值，讓你建立或編輯一個全域的 `full`、`allowlist` 或 `denylist` 使用者政策，並將第一層系統命名空間與最上層 Shell 可執行檔名稱分開管理。完整模式需要明確的高風險確認。開啟工作區後，也會顯示不受信任的 Repository 建議，讓你明確選擇 Host 預設值、使用者政策或接受後的 Repository 政策。全域政策損壞時，可透過獨立確認的重建保留工作區來源選擇；政策資料夾不安全或無法使用時，則必須手動修復。Extensions 會將 Plugin 的 Manifest Permissions、精確 package-version Grant，以及目前選定 Agent 的 Execution Policy 分開顯示。從 Navide 市集安裝的 Navide 外掛可在該處**停用**：Navide 會停止它，之後（包含重新啟動後）不再載入它的畫面與後端，但保留檔案、Grant 與儲存的資料。該列會顯示「已停用」標籤與**啟用**按鈕，啟用後沿用同一份 Grant。停用期間仍可更新、回復與移除，更新後維持停用。內建的 Plans、Git 與 Mini-IDE 不能移除，但可在各自的內建列**停用**。停用後不顯示分頁、視窗或舊版復原畫面，agent 也無法使用：停用 Plans 時 `plan_*` MCP 工具從工具清單消失、呼叫會回 `PLUGIN_TOOL_UNAVAILABLE`、不再於工作區建立 Plan 範本檔，手機對分享計畫的回饋也會被拒絕；停用 Mini-IDE 時，只有 Mini-IDE 能開啟的項目會顯示為停用，預設編輯器為外部編輯器的開啟則照常運作。Grant 與儲存的資料都保留，按**啟用**即全部恢復。停用期間已讀過工具清單的 agent CLI，要重新連線或重新啟動後才會再看到 `plan_*` 工具；Navide 無法主動通知它。停用期間被拒絕的手機回饋不會保留。開關會連同一份備份儲存：檔案損壞時會用備份重建（擴充頁會顯示），兩份都無法讀取時 Plans、Git 與 Mini-IDE 維持停用，直到你按**重設**。舊版曾移除的 Git 或 Mini-IDE 會以「已停用」狀態回來，該列會說明當初的移除已刪除它儲存的資料。**從檔案安裝 .vsix…** 可以安裝你自己選的 Navide 外掛套件檔。這種套件沒有經過 Navide 審核，也沒有簽章，無法確認作者：對話框會寫明這一點，把發佈者標成「自稱」、掃描標成「未掃描」，你必須先勾選「了解風險」才能同意。從檔案安裝的 Navide 外掛不會自動更新。核准的內容會立即生效，不用按**重新啟動**、也不用重開 Navide：首次安裝核准後就啟用；核准的更新（以及 agent 觸發、揭露內容和目前版本完全相同的自動更新）會立刻切換。核准前對話框會先說明：這個外掛開著的畫面會重新載入，畫面裡沒存的內容會遺失。每次切換都會記錄在公告中心，附**退回**上一版的按鈕。從檔案更新時會保留被取代的檔案版本，退回到它需要你重新同意。切換失敗時會繼續執行原本的版本，更新保留暫存：如果是你核准的更新，「設定 → Navide 外掛」會當下顯示原因，並保留**重新啟動**和**捨棄**，下次啟動 Navide 時公告中心會列出它並附**立即套用**；如果是 agent 觸發的自動更新，公告中心會立即常駐一列說明原因，附**立即套用**。用同一個 id 取代已安裝的 Navide 外掛時（不論哪個方向）都會先詢問；取代後不沿用原本給的權限、原生後端同意、允許改檔的工作區和 agent 工具授權；來源改變時，它存的資料（原生後端資料和 view 儲存）會保留在一旁、不交給新版本，換回 Navide 市集版本時會詢問要不要接回（預設不接回）。該列的**換回 Navide 市集版本**可以反向換回。**開發者模式**預設關閉，開啟後可以從資料夾載入你正在開發的 Navide 外掛：在 Navide 裡只能在這個頁面切換，在這裡的每次變更都會記錄；這個設定檔以你的身分執行的其他程式（包括 agent CLI）也能改（Navide Guard 會把 agent 寫入它評為 critical），但 Navide 會為自己寫入的每一項另存簽章：發現不是 Navide 寫入的項目時不會套用，開關維持關閉、資料夾不會載入，清單上方和啟動提醒會寫明，活動紀錄也會記一筆，要等你在這個頁面重新開啟開關、或對該資料夾重新同意才會生效。從 0.2.28 以前升級、或簽章檔不見時也一樣：開關要重新開啟一次，每個資料夾都要再同意一次。限制詳見 plugin-development-v2.md；開著的時候清單上方會常駐提醒，每次啟動也會提醒一次。資料夾的權限或後端宣告改變時才會重新詢問，改檔案（包括原生後端程式本身）不會。正式版也只有在開發者模式開啟時才會套用自架 Registry（`AGENT_TEAM_MARKETPLACE_URL`）；關閉時，從自架 Registry 安裝的 Navide 外掛不會載入，頁面會寫明原因。

**設定 → CLI Agents** 以每個 Agent 一張卡片呈現。使用搜尋及「全部」、「已啟用」或「需注意」篩選找到 Agent，切換啟用狀態。要調整順序，請選擇「全部」並清空搜尋，再使用卡片標題左側的拖曳把手調整順序；篩選或搜尋期間無法重新排序。至少必須保留一個已啟用的 Agent。選擇「管理」會開啟該 Agent 的側邊抽屜，總覽、啟動設定、權限、推送及安裝區段依序排列在同一個可捲動頁面。設定沿用自動儲存方式，不需要另外按下儲存。關閉抽屜或按 Escape 會先返回卡片，不會直接關閉整個設定視窗。

安裝區段管理已安裝的 Coding CLI：版本、安裝方式、重複安裝、該 CLI 上次自我更新的結果，以及在終端機執行該 CLI 官方更新與診斷指令的按鈕。開啟工作區時可設定恢復單一 CLI、第一個 Grid 頁面或目前分頁；即使上次不是 Grid layout，Grid 頁面仍會依 Grid preset 計算。Navide 只呈現並執行官方指令，不會自行更新 CLI。Exported Setting 會遮蔽 API Key 與 Token。啟用第三方 Server 前，請先檢查 MCP Command 與 Environment Variable。

**帳號**分頁為每個 CLI 帳號放一張卡片，用的是 CLI 自己的登入。Navide 0.2.32 移除了卡片上的可攜憑證（貼入的值，例如 `claude setup-token` 印出的 token）：用過的裝置在更新時會清除存著的值，新的 Claude pane 改用 Claude 自己的登入，可能是另一個帳號，額度也各自計算。

**為帳號命名。**每個帳號都能取一個你自己的名字，內建的 Default 也可以：在「帳號」分頁滑到卡片上按鉛筆，或在額度徽章的帳號清單那一列按鉛筆。這個名字會成為各處顯示帳號時的主要文字——pane 標題列、帳號清單、卡片、切換通知與 Turn Stats——登入身分則留在它旁邊；把欄位清空就回到自動產生的名稱（Account 1、Account 2…）。對於憑證不帶身分的 CLI，你取的名字是唯一能分辨兩個帳號的方式。名字屬於帳號槽，不屬於登入身分：這個槽位之後改登別的 email 時，名字不會跟著變。

pane 標題列的額度徽章現在會在百分比前面、以自己的一節標示這個數字是讀哪個帳號的：你取的名字，沒取名時則是登入 email 在 `@` 之前的那一段。警告與額度耗盡的顏色只染數字那一節，讀取進行中時整顆徽章維持虛線，完整位址放在 tooltip。pane 很窄時，名稱那一節會縮成名字的第一個字。若一個帳號沒有名字、沒有身分，該 CLI 也沒有第二個帳號需要分辨，徽章就不會多出任何東西，外觀與先前完全相同。數字屬於該 CLI 目前使用中的帳號；對於在切換帳號之前就開好的 pane，那不一定是它現在實際跑著的帳號。

**CLI 額度耗盡時切換帳號。**當某個 CLI 的使用中帳號撞到用量上限，Navide 會為它建立一個事件——不管有幾個 pane 或視窗看到——並依帳號切換策略處理：**關閉**（什麼都不做）、**通知**（預設：公告列出該 CLI 可切換的其他帳號，每個帳號標示讀數可信度——新鮮餘裕、預計已重置、較舊讀數、未知——並說明其餘帳號被排除的原因，例如未登入、仍在耗盡中、本輪已試過）、或**自動**（Navide 以最佳候選做一次嘗試）。自動切換每個 CLI 憑證池在滾動 5 小時內最多 3 次、兩次至少間隔 10 分鐘；你自己動手的切換不計入。任何失敗——沒有可用帳號、憑證搬不動、pane 無法接續、或新帳號也已耗盡——都會結束該事件並顯示原因；Navide 不會自行改試下一個帳號、不會自動切回、也不會重送 pane 可能已做過的工作。原帳號的重置時間過後，公告只會說它*預計*已恢復；切回是你按下的按鈕。

Claude Code 每次請求都會重讀憑證，因此切換不需重啟任何東西。其他 CLI 把憑證留在記憶體裡，所以會先詢問受影響的 pane：正在回合中、等待權限回覆、或有未送出輸入的 pane 絕不會被停止——切換會等到所有受影響的 pane 都安全閒置，再停止它們、搬動憑證、並讓每個對話在自己的 session 上接續。有 pane 無法接續時，切換會在動到任何東西之前停下。Aider 與 MiniMax Code 無法接續對話，因此切換會改請你確認開新對話。切換後三件事分開顯示：帳號是否已切換、每個對話是否已接續、新帳號的額度是否已驗證——最後一項只認該帳號的新讀數（或它完成的一個回合）；兩分鐘內沒有任何證據，公告會寫*已切換，額度未確認*。若憑證已搬動但帳號記錄存不下來，該 CLI 之後的切換都會被拒絕，直到你確認目前實際使用的是哪個帳號；在那之前不會覆寫任何東西。同樣地，當目前使用中的憑證與使用中帳號的備份不一致時，切換會被拒絕：憑證本身帶有帳號身份的 CLI，Navide 會自行分辨（token 更新不算換帳號）；憑證不帶身份的 CLI，則會請你確認目前的憑證仍屬於使用中的帳號，而這個確認只對你當時看到的那個狀態有效。

Claude Code、Codex、Grok、Kimi、Pi、Droid、MiniMax Code 的新帳號登入是隔離的：登入 pane 使用私有 home，使用中的帳號與執行中的 pane 不受影響。其他 CLI 只有一個憑證儲存位置，登入會暫時取代目前的憑證；Navide 會先為使用中的帳號留下快照，登入完成後把新登入停放到它自己的帳號卡片，再把使用中的帳號還原——登入被放棄時也一樣。這類登入進行中時，Navide 不會開啟該 CLI 的其他 pane；該 CLI 有 pane 在執行時也不會開始這類登入。所有 CLI 的帳號切換版面都是從各家程式碼讀出來的；還沒有任何 CLI 在 Navide 裡以兩個真實帳號完成來回切換，而 MiniMax Code 的支援是最新加入的。

這些憑證**永遠不會離開這台機器**：帳號憑證與金鑰只留在本機，所以**同步**區段（設定 → 同步）沒有「憑證與金鑰」這一列，舊版留下開著的憑證開關一律視為關閉。同步區段會顯示同步金鑰的 id——用來加密你同步的資產，不是 CLI 憑證——並在你懷疑外洩時提供更換：所有記錄重新加密，已配對的裝置會收到新金鑰。

`.agent-team/` 目前不是可攜機制。未來在不同裝置間移轉時，應使用具有 Redaction 與 Retention Control 的明確本機 Export／Import，而不是透過 Git 同步。
