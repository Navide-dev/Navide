# 疑難排解

[English](../en-US/troubleshooting.md) | 繁體中文 | [日本語](../ja-JP/troubleshooting.md) | [文件中心](README.md)

## 應用程式無法啟動

1. 確認 Node.js 22.12+（22.x）、pnpm 10+、Python 3.12+ 與 uv 0.11+。
2. 重新安裝 Lockfile 指定的相依套件：

   ```bash
   pnpm install --frozen-lockfile
   uv --project backend sync --locked
   ```

3. 在 Terminal 中以 `pnpm dev` 啟動，檢查第一個 Backend 或 Electron Error。
4. 執行 `pnpm typecheck`，區分環境問題與原始碼錯誤。

## Backend Health 持續顯示不可用

- 確認沒有其他 Process 阻擋本機 Loopback 通訊。
- 檢查作業系統的安全軟體（Gatekeeper、SmartScreen 或 Defender、端點防護程式）是否拒絕封裝後的 Python Backend。
- 開發模式下，單獨執行 `uv --project backend run python -m agent_team_backend` 以顯示 Startup Error。

## 找不到 Agent CLI

- 在一般 Interactive Terminal 中執行該 CLI 的 Version Command。
- 安裝後重新啟動 Navide，使它取得更新後的 `PATH`。
- 在 Navide 啟動 CLI 前，先完成該 CLI 自己的 Authentication Flow。
- 確認 Executable Name：Settings → CLI Agents 列出所有受支援的 CLI，已偵測到的會顯示解析後的路徑，缺少的則提供廠商的安裝指令。

## CLI 回報自己的 Auto-update 失敗

分格內可能出現 CLI 自己的訊息，例如 `✘ Auto-update failed`。同一個 CLI 的安裝目錄由所有分格與 Profile 共用，多個分格同時更新時可能互相衝突。

- 開啟 Settings → CLI Agents。失敗的更新會列在該 CLI 的那一列，含時間、版本與記錄該結果的 Config Home。
- 使用該列的更新動作。它會在終端機執行 CLI 自己的更新指令（例如 `claude update`、`codex update`、`agy update`、`grok update`）；Navide 不會自行更新 CLI。沒有更新子指令的 CLI 則改為連結到官方文件。
- 若衝突反覆發生，可把該 CLI 的 Auto-update 設為手動。Navide 會在每次 Spawn 帶入該 CLI 官方提供的關閉變數，改由這個面板更新。
- 執行中的 Session 會沿用啟動時的 Binary；更新後請重新啟動該分格。

## 分格一直停在「detecting session」

Codex 與 Antigravity 依賴 Log 或 Database Discovery，將新的 CLI Session 綁定到 Navide 分格。（Grok Build 分格啟動時就帶著自己的 Session ID，不會停在這裡。）

Codex 可開啟 `/hooks` 檢查待審核的 Hook。MCP 啟動失敗或第三方 `SessionEnd` Timeout 警告需要分別調查，不能單憑這些訊息認定 Session ID 發生碰撞。Codex 0.154 會將 `SessionStart` 排入第一輪執行佇列；只開啟 TUI 並不保證該事件已執行。

某些 Codex 版本會把 Navide 以命令列注入的 `SessionStart` Hook 當成未審核的 Hook，每開一個分格都跳出 **Hooks need review**。是否如此無法從版本號判斷（0.155 實測不會，0.154 有回報會），因此 Navide 改為**觀察**：第一次看到該畫面就記下來，之後開的 Codex 分格一律不注入該 Hook，並在 Pipeline Log 說明。

- Navide **不會**修改你的 `~/.codex/config.toml`，也**不會**加上 `--dangerously-bypass-hook-trust`——那個旗標會連你自己 `hooks.json` 裡的 Hook 也一併跳過審查。
- 停用該 Hook 只損失「分格對應 Session」的一條捷徑，Session 仍由 Log 與 Marker 辨識，功能不受影響。
- 目前這個畫面若已出現，對該分格按 `2`（Trust all and continue）或直接關閉分格即可；不會再擋第二次。

- 傳送一般訊息，讓 CLI 保存分格 Marker。
- 確認 CLI 能寫入其正常 Session Directory。
- 第一次 Session 被偵測前，不要立即 Rebuild 或 Resume。
- 如果偵測始終沒有完成，在建立 Issue 前保留分格 Output 與相關 Backend Log。

## Grok Build 分格

- **「Do you trust the contents of this directory?」** 提示問的是分格自己的工作區時，Navide 會替它開的每個 Grok 分格回答，並透過 `~/.grok/trusted_folders.toml` 讓其他 Grok 分格共用這個答案（便利功能 `grok.folder-trust`，可在便利功能總覽關閉並收回）；只有分格開啟的工作區或它底下的資料夾，才會共享到 `~/.grok`。提示還留在畫面上時分格會顯示為等待中，訊息會先等著，不會被打進提示裡。信任資料夾是永久的，所以 agent 或聊天轉送只能拒絕（`cli_answer_prompt` 的 "deny"，也就是 Grok 的 "No, quit"）；要接受請自己在分格裡按。
- **`[startup probe] … does not identify as Grok Build`** 表示 `PATH` 上的 `grok` 是另一個同名程式（例如社群版 `grok-cli`）。請用 `curl -fsSL https://x.ai/cli/install.sh | bash` 安裝官方 CLI。
- **額度顯示為無法取得。** Grok Build 不對其他程式回報額度；請在 Grok 分格裡輸入 `/usage`。
- **Grok 工作中送出的斜線指令會晚點才執行。** Grok Build 會把它排到目前回合結束，所以用 `cli_send_and_wait` 等到的回覆可能屬於前一個回合。
- **回合結束得很慢。** Grok Build 預設會匯入你的 `~/.claude` hooks、skills 與 MCP 伺服器，每個回合結束時都會跑 Claude 的 stop hooks。不想這樣的話，在 `~/.grok/config.toml` 加上：

  ```toml
  [compat.claude]
  hooks = false
  ```

## Resume 無法運作

- 確認該分格先前曾到達 Detected Session 狀態。
- 確認原始 CLI 的 History 中仍有該 Session。
- 檢查 Workspace Path 是否改變。
- CLI Upgrade 可能改變 Resume Syntax 或 Session Storage；Bug Report 應包含 CLI 與 Navide Version。

## Codex 對話未出現在 History

- Codex 的原始 Rollout 檔案位於分格隔離的 `~/.codex-panes/<session_home_id>/sessions` 目錄，與 Navide 的歷史中繼資料分開保存。History 沒有列出，不代表原始對話檔案已被刪除。
- History 搜尋涵蓋已載入的項目。即使目前搜尋沒有結果，仍可載入更多項目以繼續搜尋較早的對話；內容搜尋會重新搜尋新載入的項目。
- 若要在 Navide 外恢復已知對話，請使用原本的 `CODEX_HOME` 與確切的 Session ID。同一個 Home 有多段對話時，不要直接選擇最新的 Session。
- 已移除的 Codex 項目若沒有 **Session** 列，代表沒有 resume id，History 就不會顯示 **Resume** 按鈕。常見原因是啟動時的 **Hooks need review** 畫面吃掉了 session marker，或重啟後分格以全新對話重開而沒有補打 marker。原始 rollout 仍在——依時間與 `cwd` 在 `sessions/` 下找到它，用同一個 `CODEX_HOME` 執行 `codex resume <id>`。

## Token Stats 空白或重複

- Token Tracking 依賴 Provider Log Format，只有 CLI 寫入相容 Record 後才能看見 Usage。
- 確認 Navide 已將 CLI Session 與目前 Workspace、分格建立關聯。
- 帳務請與 Provider Dashboard 比較；Navide 顯示的是 Operational Telemetry。
- 如果重複問題持續存在，請回報 CLI Version、可安全分享的 Session ID，以及經過遮蔽的範例 Record。

## Local Analyzer 無法使用

- 使用 Ollama 時，確認 Service 正在執行，而且設定的 Model 已存在。
- 使用 GGUF Model 時，確認 File Path、Architecture Support 與可用 Memory。
- Analyzer Failure 應只降低選用 Automation 能力，不應阻止一般手動 Terminal 使用。

## macOS 權限阻擋工作流

開啟 **System Settings → Privacy & Security**，檢查 Automation、Files and Folders、Accessibility 與 Full Disk Access。只授予特定 CLI 與 Workspace 實際需要的權限。修改權限後重新啟動受影響的應用程式。

## Windows 擋住首次啟動

Windows 安裝程式尚未程式碼簽章，SmartScreen 會顯示「Windows 已保護您的電腦」且發行者為「不明」。請點 **其他資訊 → 仍要執行**。在 Windows 簽章上線前，每個 Navide 安裝檔都會這樣，這不代表下載檔被竄改；有疑慮時請確認檔案來自 GitHub Release 頁面。

## Linux 的 AppImage 無法啟動

- 先給執行權限：`chmod +x Navide-<版本>-x86_64.AppImage`。AppImage 自帶 FUSE runtime，不需另裝 `libfuse`。
- 若安裝的是 `.deb`，請在終端機執行 `navide` 以看到啟動錯誤；該套件的更新來自 `apt`，不是 App 內更新器。

## Terminal 分格的複製貼上行為異常

- CLI 啟用 Mouse Reporting 時，一般拖曳會被轉送給程式本身，劃不出任何選取。請按住 **Option**（macOS）或 **Shift**（Windows/Linux）再拖曳，強制進行文字選取。
- **Edit → Copy**、分格右鍵的 **Copy** 與 **⌘C / Ctrl+C** 都會複製終端機選取。終端機的選取對作業系統不可見，因此背景執行的第三方輔助使用或剪貼簿工具（Typeless 這類會攔截 Edit 選單或 Pasteboard 的工具）可能吃掉複製動作。若複製沒有任何反應，請關閉該工具（或在 **System Settings → Privacy & Security → Accessibility** 中排除 Navide）後再試。
- 在 CLI 分格要插入換行而不送出，可按 **Shift+Enter**、**Ctrl+Enter** 或 **⌘Enter**。一般 shell 分格只有 Shift+Enter 有此作用 —— Ctrl+Enter 維持送出，因為那是 shell 原本的行為。單純的 Enter 一律送出。

## Context7 或 Documentation Injection 失敗

Documentation Injection 採用 Best-effort。檢查 MCP Configuration、Package Runtime 與 Network Access。Fetch 失敗不應阻擋手動任務；如果 Workspace 必須保持離線，請停用整合。

### MCP 伺服器一直停在「starting」或啟動失敗

透過 `npx` 或 `uvx` 啟動的本機（stdio）MCP 伺服器，第一次執行時要先下載套件，才能回應 Navide 的握手（`initialize`）。只要伺服器的程序仍在執行，Navide 就會繼續等待，所以第一次下載較慢不會被當成失敗：

- **Settings → MCP** 會把伺服器顯示為 **starting**。等待 15 秒後（`backend/agent_team_backend/mcp_manager.py` 中的 `SLOW_START_NOTE_AFTER`），會加上一則備註，說明已等了多久，以及第一次執行 `npx`/`uvx` 時可能正在下載套件。頁面會自動重新整理，直到伺服器連線或失敗。
- 如果程序在回應之前就結束，啟動會立刻失敗，原因會附上它的結束碼。
- 如果程序一直執行卻始終沒有回應，Navide 會在 **300 秒**後放棄（同一個檔案中的 `STDIO_INIT_HARD_CAP`）。這個上限只是安全網，並不限制速度慢的伺服器。遠端（`http`/`sse`）伺服器的握手時限維持 15 秒。
- 伺服器是平行啟動的，所以一個很慢的伺服器不會拖住其他伺服器。

啟動失敗的伺服器會顯示 **Failed to start:** 與原因。下次重新載入 MCP 設定時（例如你在 Settings → MCP 儲存變更），會再試一次。

stdio 伺服器輸出到 stderr 的內容（npm 的下載訊息、當機訊息）會寫入 Navide 資料夾中的 `logs/mcp-<name>.log`。這個檔案只留在這台電腦上，且只有你的使用者帳號可以讀取（0600）。只保留最近一次啟動：每次啟動都會清空它，同一次執行期間只要伺服器持續輸出，檔案就會一直成長，沒有大小上限。名稱含有字母、數字、`_`、`.`、`-` 以外的字元，或含有大寫字母時，會轉成安全的檔名，並附上名稱的簡短雜湊，因此兩個伺服器絕不會共用同一個檔案。從 Settings → MCP 移除伺服器會刪除它的檔案；把它關閉則會保留。Settings → MCP 會把最後幾行顯示為 **Last lines the server printed**。那段文字是伺服器自己的輸出，可能包含伺服器選擇印出的任何內容。Navide 本身不會把伺服器的設定寫進去，也不會寫入任何 `env` 或 `headers` 的值。agent 透過 `mcp_list` 工具讀到的啟動錯誤，其中的 URL 會被遮蔽，與設定的 URL 相同。

## Git Authentication Prompt 無法完成

- 使用 `git remote -v` 確認 Remote。
- 在一般 Terminal 測試相同 Fetch 或 Push。
- 優先使用現有 SSH Agent 或 Credential Manager 設定。
- 絕對不要將 Access Token 貼到 Issue Report 或 Terminal Screenshot。

## Plans 退回舊版檢視

如果 Plans 視窗無法啟動它的套件 Backend，或 Backend 一再結束，Navide 會改為顯示該工作區的舊版 Plans 檢視，並標示 **舊版復原**，同時以一行文字說明原因，例如 `forced`、`storage-migration-failure`，或 Backend 自己的啟動錯誤。你的計畫是工作區 `.agent-team/plans/` 資料夾裡的一般檔案；退回舊版不會轉換或刪除它們。Plans 面板的 **重試** 會再嘗試新版檢視，每個 Session 最多兩次。

- **強制使用舊版檢視**，可確認問題是否來自新版 Plans Backend。結束 Navide，以環境變數 `NAVIDE_PLANS_RECOVERY=legacy` 重新啟動（macOS 可用 `open --env NAVIDE_PLANS_RECOVERY=legacy -a Navide`），再重現問題。只有 Plans 檢視會改變。強制期間 **重試** 會直接拒絕並說明原因。要再試新版檢視時，結束 Navide，不帶該變數重新啟動。
- **不要編輯 Plans 狀態。** Plans 的篩選、排序與收合偏好存放在應用程式的 user-data 資料夾下的 `plugin-storage-v2/`；其中的 `plans-lifecycle.json` 記錄舊版檢視要退回哪個套件版本。請不要動這些檔案；舊版檢視只會讀取先前的偏好，不會覆寫目前的偏好。
- **回報 Bug 時**，請附上 Plans 外掛版本（Settings → Navide Plugins）、**舊版復原** 的原因文字、`main.log` 中與 Plans 有關的行，以及重新啟動前後的 `plans-lifecycle.json`。不要附上憑證、Token 或其他儲存資料。
- **驗收檢查。** 強制舊版檢視時，它會開啟同一個工作區，並能列出與開啟其中的計畫。移除變數並重新啟動後，Plans 分頁應顯示一般檢視，不再有 **舊版復原** 標示。如果計畫資料夾缺少 `_template.html`，建立計畫會回傳明確的 `BACKEND_UNAVAILABLE` 錯誤，直到 Navide 補回計畫檔案；絕不會寫出簡化版的計畫文件。

## 提交有用的 Bug

請包含：

- Navide Commit 或 Version
- 作業系統版本與 Architecture
- Agent CLI 名稱與 Version
- Reproduction Steps
- Expected Behavior 與 Actual Behavior
- 經過遮蔽的 Log 或 Screenshot

使用 Repository 的 [Bug Report Template](https://github.com/Navide-dev/Navide/issues/new?template=bug_report.yml)。Vulnerability 請依照英文版 [Security Policy](../../SECURITY.md) 私下回報。
