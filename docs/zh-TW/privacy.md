# 隱私與資料流

[English](../en-US/privacy.md) | 繁體中文 | [日本語](../ja-JP/privacy.md) | [文件中心](README.md)

Navide 採用 **Local-first**，但不代表所有情況都完全離線。Electron 應用程式、Python Backend、Terminal Session、私有專案智慧、Workspace 狀態與調度邏輯都在你的機器上執行；當你啟用或使用外部服務時，資料可能離開裝置。

## Navide 保存在本機的資料

依照啟用功能，Navide 會儲存：

- `<workspace>/.agent-team/` 中的個人私有專案智慧與 Run Artifact
- 應用程式資料目錄中的 Role、Pipeline、Recent Workspace、UI Setting、Analyzer Setting 與 AI Provider Setting
- 應用程式資料目錄中的 Host 管理 Plugin Storage Partition；它們依驗證過的 Plugin／Package 及（Workspace Scope）驗證過的 Workspace 分隔，不會傳送給 Navide 或 Plugin Registry
- 從本機 CLI Log 衍生的 Token Attribution 與 Deduplication Metadata
- 本機 `navide.db` 裡的第三方 Navide 外掛活動紀錄（`plugin_activity`）：哪個外掛、哪個 `namespace.method`、時間、workspace、被允許／拒絕／失敗、workspace 內的相對路徑（workspace 外的路徑只記 `<outside-workspace>`，從不存檔案內容），shell 呼叫只記執行檔與子指令。明細保留 7 天，之後只留每日計數 90 天。內建的 Plans、Git、Mini-IDE 不記錄。這些資料不會離開這台電腦
- 本機 `navide.db` 裡，pane 離線時聊天室訊息的預覽（`channels.wake_kept`，重啟後改存 `channels.wake_lost`）：綁定的聊天室在 pane 不在線上時傳來的每則訊息，前 40 個字，用來告訴聊天室哪幾則沒有送進去。照原樣存放、不做遮罩，所以訊息開頭若是機密也會一併存下。訊息送進 pane 或聊天室已被告知後刪除；聊天室解除綁定或 bot 被移除時也會刪除；bot 停用期間會保留到它再次啟動。這些資料不會離開這台電腦
- 選用的 AI Provider API Key；它會儲存在受限制檔案權限保護的本機設定檔中（受支援系統上為 `0600`）

Navide 不營運專案 Telemetry 服務，也不要求建立 Navide 帳號。

當 Issue 16 的 Production Storage Integration 啟用後，解除安裝 Plugin 會在
Cleanup 成功後刪除該 Plugin 的本機 Storage；之後重新安裝不會還原已刪除的
資料。一般第三方 Production Plugin 在後續 Grant／Context Integration 完成
前仍會被拒絕。First-party `navide.git` Migration 是明確的 Host-owned
Consumer：Git Preference 使用驗證過的 Package／Workspace Storage Partition；
升級時可以將前一個 Active Snapshot 複製到新的 Candidate，並保留舊 Snapshot
作為 Rollback。

## 私有專案智慧

`.agent-team/` 屬於本機 Workspace 的個別使用者。它排除於 Git，也不是用來同步人類團隊狀態。內容可能包含私人 Prompt、Task Context、Session Identifier、Agent Output、Run Event、Handoff、Token Summary 與未來的 Coordination Metadata。

不要從 `.gitignore` 移除 `.agent-team/`，也不要將它作為刻意撰寫專案文件的替代品。如果必須分享 Artifact，請只檢查並 Export 必要的 Specification、Decision、Report、Patch 或 Evidence。

未來的可攜功能應使用具有 Redaction 與 Selection Control 的明確本機 Export／Import。Navide 絕不能無聲地把私有專案智慧轉換成雲端或 Repository 狀態。

## 可能對外通訊的功能

| 功能 | 可能接收者 | 涉及資料 |
|---|---|---|
| Coding Agent CLI | CLI 供應商或設定的模型 Provider | Prompt、選取的 Context、Tool Result 與供應商定義的 Telemetry |
| Cloud AI（Inline 編輯與 Code Review） | Anthropic、OpenAI、Google、Groq、DeepSeek、Mistral、xAI 或自訂 Endpoint | 選取的程式碼、Prompt 與 Model Parameter |
| Context7 Injection | Context7 及其 MCP Distribution／Runtime 相依套件 | 偵測到的 Library Name 與文件查詢 |
| Web Search | Search Provider | 搜尋查詢文字 |
| Git Operation 與 Issue Detection | 設定的 Git Host，透過本機 `git`、`gh` 或 `glab` CLI | Repository／Issue 資料，以及由 CLI 或 Host Account Flow 處理的憑證 |
| Update Check | GitHub Releases | 應用程式版本與一般網路 Metadata |
| Plugin Registry Trust Refresh | 所選的 Official Registry，或明確核准的 self-hosted Registry | 已安裝 marketplace plugin 的 namespace/name；Refresh 不會傳送 Plugin Source 或 Archive |
| Skills package retrieval | GitHub API and codeload | Requested repository/ref and normal network metadata; downloads a public archive without uploading local skill contents |
| CLI risk DNS lookups | Operating system resolver and its configured upstream service | Declared expected hostnames and configured allowed hostnames |
| MCP Server | 設定的 MCP Server 與它使用的服務 | 完全取決於該 Server 的 Tool 與設定 |
| 聊天頻道 | pane 綁定的聊天平台（Telegram、Slack、Discord 等）與該聊天室的所有成員 | 對聊天室傳來訊息的回覆；鏡像詳細度高於「只回覆聊天室」時，另含本機輸入、每回合結果、委派內容與子視窗。遮蔽只涵蓋該頻道自己的機器人憑證，指令或結果中的 API 金鑰等其他機密會原樣送出 |

傳送私人程式碼或受規範資料前，請先閱讀各 Provider 政策。

Production Git Package 透過 Host-owned argv Allowlist 在本機執行 `git`、`gh`
與 `glab`。Navide 不會代理這些服務，也不會將 Repository 上傳到 Navide。
當本機 CLI 執行 Remote Operation 或 Issue Query 時，GitHub 或 GitLab 仍可能
依照設定的 Remote、CLI Login 與 Provider Policy 收到資料。Git Account
Credential 保留在 Host 保護的本機 Account Store 或 CLI 自己的 Credential
Flow，不會寫入 Plugin Renderer Storage。隔離的 v2 Git Renderer 只會取得非
Secret 的 Account Metadata 與 Workspace Binding State。Remote Git Operation
送往 Backend 前，才由 Host 注入綁定的 Credential。即使 Workspace 沒有綁定
Host Account，v2 仍可使用由 Host 擁有的 Interactive Credential Flow：Host
會為該次 Operation 建立不透明且綁定 Instance 的 Owner，只把 Git Prompt
轉送給發起它的 Git View，並在接受回覆前驗證 Request Ownership。輸入的
Secret 只在這次 Exchange 中暫存，絕不保存到 Plugin Storage；來自其他 View
或其他 Workspace 的 Credential Response 會被拒絕。

只要仍有已安裝的 marketplace plugin，Navide 會在 App 啟動時及每 15
分鐘，將該 Plugin 的 namespace/name 傳送給所選的 Registry。這個 Request
用來取得已簽署的 Trust Metadata，讓 Navide 偵測遭撤銷的 Publisher 或
Package，並隔離已安裝的 Plugin。目的地由設定的 Registry URL 決定：使用
Official URL 時，會使用 App Pin 的 Official Registry；使用 self-hosted URL
時，則只使用使用者明確核准的 URL 與 Root。這個 Refresh 不會上傳 Plugin
Source、Package Archive 或 Workspace File。

Navide 會在 Plugin Installation 旁的本機資料中保留最新的已簽署 Trust
Snapshot，讓重新啟動後仍能進行檢查；Registry 自己的 Request Log 則由該
Registry 決定保存方式。目前沒有獨立的 Refresh 開關；移除已安裝的
marketplace plugin 後，這項資料流就會停止，其他外部服務資料流仍由各自的
設定控制。

## CLI risk observation data

For vendors with declarations, the backend samples numeric endpoints of established TCP sockets attributed to active pane process trees and inventories declared local data roots. Format checks read at most 64 KiB from each candidate file locally. This feature does not intercept packets, decrypt TLS or upload file contents. Read buffers are used for format recognition; file contents and tokens are not stored in the risk records.

The local `navide.db` retains baseline and file-membership metadata, paths, sizes/classes, presence and absence observation times, network endpoint findings and counts, availability, and Ignore/Allow decisions. An allowed exact IP is also retained in that vendor's UI settings. Metadata can reveal local paths and contacted IPs even though it contains no copied file contents.

Building the expected-address snapshot performs forward DNS lookups for declared expected hostnames and any configured allowed hostnames through the operating system resolver. That resolver, and its configured upstream service, can receive those names. Numeric IP allowances need no hostname lookup. The feature does not infer destination names with reverse DNS; an address match or mismatch cannot establish traffic contents or intent.

## 憑證

Agent CLI 憑證保留在各 CLI 自己的設定中。如果在 Navide 輸入 Cloud AI Key，Navide 會把它保存在本機，供 AI 功能（Inline 編輯、Code Review）使用。設定 Export 會遮蔽 API Key 與 Token。

**可攜憑證**是你主動選擇的例外：各家官方為「帶到別台機器」設計的值（例如 `claude setup-token` 印出的 token），在設定 → 帳號貼入。Navide 在這台裝置上加密保存，只在啟動該 CLI 的新 pane 時以環境變數交給它，不會寫進 CLI 自己的登入檔。從一台裝置移除，就只從那台裝置移除。

貼入的憑證永遠不會上傳。憑證與金鑰只存在你自己的機器上，Navide 永遠不會把它們存到 Navide Cloud 或任何集中式資料庫：設定 → 同步沒有「憑證」區段，舊版留下開著的憑證開關一律視為關閉，Navide Cloud 也會拒收任何版本送來的憑證記錄。

本機檔案權限可以降低同一部電腦其他使用者意外存取的機會，但無法防範 Malware、遭入侵的使用者帳號、無限制 Agent、Backup，或具有同等權限的 Process。

## Agent 權限

除非外部 CLI 提供並啟用自己的 Sandbox，Agent 會以目前使用者的作業系統權限執行。Navide 目前尚未提供完整 Workspace Sandbox。

YOLO Mode 可能略過 CLI Confirmation 或 Sandbox 保護。只應在可信任、已使用版本控制的 Workspace 中使用，並於執行後檢查 Command 與 Diff。

## Context Handoff

跨 Agent Handoff 可能包含 Task Context 與先前 Stage Output。自動 Secret Scrubbing 目前還不是完整安全邊界。不要把憑證放進 Prompt、Generated Plan、Log，或可能交給其他 Agent 的檔案。

## 移除本機資料

停止所有 Active Session 後，可以從 Workspace 的 `.agent-team/` 目錄移除私有專案智慧。刪除它可能會移除 Resumability、Run History、Attribution 與累積 Context，但不會刪除原始碼 Repository。整個應用程式的設定與歷史位於 Navide Application Data Directory。刪除前請備份需要保留的設定。

回報 Vulnerability 請依照英文版 [Security Policy](../../SECURITY.md) 私下進行。

## Token Monitor local records

Token Monitor reads local Claude transcripts to summarize turn timestamps, session identifiers, models, and token counts. Its in-memory cache contains these summaries rather than prompt or response text. Local transcript records are not assigned to the current account because their account ownership cannot be verified.

Successful observations from the existing Claude quota polling service are saved in the application data directory as `claude-quota-history.sqlite3`. Records contain an account-slot identifier, observation time, plan type, quota percentages, and reset-window metadata; they contain no credentials or conversation text. Recording prunes observations older than 180 days and limits the database to 50,000 samples. This history is local to this installation and is not uploaded by Token Monitor. Opening or refreshing the monitor adds no external API or CLI requests; the existing usage service retains its own polling behavior.

### 透過 MCP 安裝 Skills

準備 GitHub public skill 時，Navide 將 repository、ref 與一般連線 metadata 傳給 `api.github.com`，再從 `codeload.github.com` 下載解析後的確切 commit archive。來源可用 `owner/repo` 或 HTTPS `github.com/owner/repo` URL；私人 repository、任意下載 URL 與 redirect 會拒絕。取得時不加入 GitHub 授權憑證、不上傳本機 skill 內容；系統 proxy 設定仍可能生效。本機套件準備只讀取指定 skill 目錄，不發 GitHub 請求。

準備好的 bytes 保存在 backend 記憶體，15 分鐘後或重啟時失效，同時最多 8 份有效套件，另在記憶體保留最多 8 份輕量完成重試收據。安裝使用已檢視的快照，不重讀來源，寫入既有共用 Skills 根目錄，且不執行腳本或 plugin hooks。收據仍保留時，重試只回傳原結果而不再寫入；它沿用原 preview 到期時間，也可能提早被淘汰。到期或淘汰後重送回傳 missing/expired，不重新安裝。Inspect／prepare 會把 skill 文字、檔案資訊與來源路徑回傳給請求的 coding agent，其模型供應商可能依 CLI 自身資料政策接收這些結果；套件中應避免放入秘密資料。

開啟 Skills sync 時，符合限制的安裝內容與投遞設定可透過既有流程傳到配對裝置。選定套件與 Skills 內容 export 使用相同限制：64 檔、每檔 256 KiB、總量 512 KiB；符合限制不保證同步已完成。後端產生的來源、digest 與時間紀錄存於本機 Navide marker，編輯與重啟後保留，但不進入 export／Skills sync。

### 透過 MCP 查詢 Navide 市集

`marketplace_search` 與 `marketplace_detail` 會讓 Navide App 向設定的 Registry 送出和 Navide 市集頁面相同的請求：搜尋文字、分類與頁數，或套件名稱。`plugins_list_installed` 不對外送出任何東西，只讀取本機的清單。三者都把結果（公開的上架資料，以及已安裝 Navide 外掛的 id、版本與狀態）回傳給發出請求的 coding agent，其設定的模型供應商可能依該 CLI 自己的資料政策收到這些內容。

### 透過 MCP 對 Navide 市集提出請求

使用 `marketplace_request_install`、`_update`、`_rollback` 時，Navide 應用程式會用和 `marketplace_detail` 相同的方式查詢套件；所有請求工具都會讀取本機的已安裝清單。請求連同提出請求的 pane 名稱、workspace 和 agent 寫的理由，會留在後端記憶體中，直到被決定或過期，並在 Navide 視窗顯示給使用者。`plugins_disable` 與 `plugins_enable` 不會對外送出任何資料。每一次請求、決定、停用和啟用都會記在本機的 navide.db（`plugin_agent_actions`：外掛、動作、呼叫端類型、pane id、pane 名稱、workspace、結果），保留 30 天，之後只留最新的 10,000 筆。
