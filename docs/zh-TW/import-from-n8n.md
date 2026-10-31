# 從 n8n 匯入

Navide 可以把從 n8n 匯出的 workflow 轉成一個新的 Pipeline。匯入是單向、一次性的：Navide 依 workflow 建出 Pipeline，把（遮蔽過的）workflow JSON 存在這台機器上、放在 Pipeline 旁邊，不會寫回 n8n，也絕不覆寫既有的 Pipeline。

## 匯入 workflow

1. 在 n8n 匯出 workflow（Download，或複製它的節點），取得 JSON。
2. 在 Navide 打開**流程管理**，選 **從 n8n 匯入**（在 pipeline 清單上，或某條 pipeline 的 ⋯ 選單裡）。
3. 貼上 JSON，或用 **選擇檔案…**。workflow 檔案最大 5 MB。
4. 選擇**需要 agent 的步驟使用的 CLI**（預設 Claude）。AI Agent 節點會依它的模型自己選 CLI：Anthropic → Claude、OpenAI → Codex、Gemini → Gemini。
5. 選 **預覽**。這時還沒有寫入任何東西。先看預覽內容（見下文）。
6. 選 **匯入**。預覽會說明這次匯入會建立幾個流程（**匯入會建立 N 個流程。**）。新的 Pipeline 會打開，並跳出訊息說明已匯入、有幾個步驟需要確認；那些步驟在編輯器上會帶著需要確認的標記，直到你檢查過。名稱已被使用時會加上「 (2)」「 (3)」……。匯入是全有或全無：多個 workflow 中只要有一個存不進去，就一個都不保留。

如果匯入跑太久，對話框說它可能還會完成，請再按一次 **匯入**：已經建好的話會直接打開那個流程，不會另外建立副本。

Agent 也能透過 MCP 工具 `pipeline_import_n8n` 做同樣的事，預設是 dry run，回傳同一份報告（見[外部 MCP 控制](external-mcp-control.md)）。工作區有 Pipeline 正在執行時，匯入會被拒絕。

## 看懂預覽

畫布依每個步驟的轉換方式上色：

- **直接轉換**：Navide 照 workflow 原意執行。包括 Manual、Chat、Execute Workflow 觸發；AI Agent 叢集（模型、記憶、工具、輸出解析器併成一個步驟）；Wait 與 send-and-wait 核准（Gate）；IF 與 Switch（分支）；Append 或 Choose Branch 模式的 Merge；錯誤輸出與重試；以及呼叫 Navide 已有 workflow 的 Execute Workflow（子 Pipeline，見下文）。
- **由 agent 執行**：HTTP Request、Code、Set、會合併資料的 Merge（依欄位、位置、所有組合或 SQL；Agent 照它的合併規則做）、應用程式節點（Google Sheets、Slack、Gmail……）、社群節點，以及不認得的節點類型或版本。由 CLI Agent 依節點原本的參數執行，expression 與 Code 原樣傳過去，結果可能和 n8n 不同。沒有分支的連續步驟會併成一個步驟，所以不會一個節點開一個 Pane。
- **需要確認**：已匯入，但需要 Navide 目前還沒有的能力。包括 Schedule、Webhook、Form 與應用程式觸發（請手動啟動 Pipeline，或在**每輪消耗 ▸ 排程**排定）、Respond to Webhook、呼叫 Navide 還沒有的 workflow 的 Execute Workflow、Call n8n Workflow Tool（見下文），以及建議留在 n8n 的步驟（見下文，標成 **不支援**）。

畫布下方的報告會逐一列出：每個 n8n 節點變成什麼、你要做什麼（需要確認的列排在最前面；合併了多個 n8n 節點的步驟會寫出合併了幾個）；每個步驟完整的 Kickoff 與每個 Gate 的提示（也就是每個 Pane 會收到的原文）；要補的憑證；秘密在哪裡被移除；有幾個步驟需要確認。這些都不會擋住 **匯入**，只是讓你在執行前先知道。

### 分支、錯誤、重試與步驟之間的資料

- **IF** 會變成 `true`／`false` 兩條分支邊；**Switch** 每條規則一條分支（有重新命名就用輸出名稱，否則用編號），fallback 輸出對到 `default`。該步驟的 Agent 會依 Kickoff 結尾 Navide 加上的訊號說明回報走了哪條分支，只有那條分支會執行；之後的 Append 或 Choose Branch 模式 Merge 會用實際到達的輸入執行。
- 其他有多個輸出的節點，例如 Compare Datasets：範圍小時併成一個步驟，依有項目的每個輸出執行。範圍太大，或含有 Agent 或核准閘門時，會維持分開的步驟。這時每個輸出都會執行，包括 n8n 不會送出項目的輸出，所以該節點和之後的 Merge 會顯示為**需要確認**。
- 設成 **On Error → Continue (using error output)** 的節點會有一條錯誤邊：只有它失敗時才會執行下一步。自己就是自己的 error workflow（Settings → Error Workflow）的 workflow，其 Error Trigger 之後的步驟會接成每個步驟的錯誤邊。
- **Retry On Fail** 會變成該步驟的重試：總共最多 5 次，間隔最多 300000 ms。n8n 原設定超過這個上限的節點，報告會標出來。
- 迴圈（Loop Over Items，或繞回前面節點的 IF）會併成一個步驟：逐筆處理項目，或重複到離開迴圈的條件成立為止。迴圈裡的 Wait 會讓那個步驟在每一輪之間暫停，它不是核准閘門。
- 讀取其他節點的 expression，例如 `$('Lookup').item.json`，會在 Kickoff 裡拿到那個步驟的結果 `{{node.<步驟 id>.output}}`，而那個步驟會被要求在結尾以 JSON 輸出結果。

### Sub-workflow

Navide 已有被呼叫的 workflow 時，**Execute Workflow** 節點會變成子 Pipeline 節點：執行到那裡會暫停，在同一個 workspace 執行那條 Pipeline，再帶著它的結果繼續。即使 n8n 設成不等待，Navide 也一律等它完成。它的錯誤輸出與 Retry On Fail 和其他步驟一樣對應。

要連同 sub-workflow 一起匯入，請把它們放在同一個 JSON 陣列裡一起貼上（也就是 `n8n export:workflow --all` 寫出的格式），匯入一次即可：被呼叫的 workflow 會先各自變成一條 Pipeline，沒有被其他 workflow 呼叫的那個會在匯入後打開。之前匯入過的 workflow 會直接沿用，所以也可以先匯入被呼叫的 workflow，再匯入呼叫它的那個。預覽的**被呼叫的工作流**清單會寫出每一個是這次一起匯入、沿用之前匯入的流程，還是 Navide 裡還沒有。

會繞回來的呼叫（A 呼叫 B、B 又呼叫 A，或 workflow 呼叫自己）會維持 **需要確認**，因為子 Pipeline 不能執行自己。呼叫 Navide 沒有的 workflow、用 expression 選 workflow，或以 JSON、檔案、URL 傳入 workflow 的呼叫，也一樣。

**Call n8n Workflow Tool** 讓 AI Agent 把 workflow 當成工具呼叫。步驟無法把 Pipeline 當成工具呼叫，所以不會轉換：若那個 workflow 已匯入，步驟的 Kickoff 會寫出它對應的 Pipeline，報告也會標成需要確認。

## 憑證與秘密

憑證不會被匯入。報告會依類型與名稱列出 workflow 用到的每個憑證，以及用到它的節點；n8n 的 credential id 不保留。請改在這台機器上設定存取：在 **設定 → MCP** 加上該服務的 MCP server，或使用服務自己的 CLI 登入（例如 `gh`、`gcloud`）。不會把任何東西放進 Pane 的環境變數。

直接寫在 workflow 裡的秘密，例如 Authorization header、API key、bearer token 與其他常見的 token 形式（常是 cURL 匯入留下的），會在所有地方換成 `<removed: add credential for …>`，存下來的 workflow JSON 也一樣。報告只寫哪個節點的哪個欄位移除了一個秘密，原值不會保留。

存下來的 workflow JSON 與憑證清單只留在這台機器：設定包匯出不含它們，Pipeline 也不在任何 Cloud 同步或分享之中。

## 匯入的內容是外部內容

從 workflow 取來的一切，包括參數、備註、提示，都視為外部內容。匯入的 Pipeline 在流程管理與編輯器會顯示 **來自 n8n**，每個 Kickoff 開頭都有外部內容聲明；不論由誰啟動，每次執行都會把它的 Pane 標上 Navide Guard 的外部內容標記。這個標記無法關閉。執行不是你自己寫的 workflow 前，請先在預覽裡讀過 Kickoff。

## 透過 n8n 的 MCP server 把步驟留在 n8n

有些步驟比較適合留在 n8n，例如大量的決定性資料處理、二進位檔案流、向量資料庫。報告會把它們標成 **留在 n8n**，該步驟可以改為透過 n8n 自己的 MCP server 呼叫那個 n8n workflow。選單名稱與能否使用依 n8n 版本而定，以實例實際版本為準。

1. **在 n8n**，由 owner 或 admin 開啟實例層級的 MCP 存取（Settings → Instance-level MCP → Enable MCP access）。
2. **把 Navide 接成 client。** 在 **Connect a client** 的 **API key** 分頁，複製 Server URL（結尾是 `/mcp-server/http`）與存取 token。token 只會完整顯示一次。
3. **在 Navide**，到 **設定 → MCP** 新增一個 MCP server，填入那個 URL，並把 token 設成它的 `Authorization: Bearer <token>` header。token 只在這台機器上填：MCP 同步只同步裝了哪些 server，不同步 token。
4. **開放 workflow。** 在 n8n 為該 workflow 開啟 **Available in MCP**（workflow 的 `…` 選單 → Settings），或在 Workflows enabled 頁面開啟。
5. **執行。** Agent 呼叫 n8n 的 `execute_workflow` 工具。Navide 不會等那次 n8n 執行完成，也不會把結果交給下一步；請到 n8n 查看執行結果。

依據：n8n 文件「Connect to n8n MCP server」（docs.n8n.io/advanced-ai/accessing-n8n-mcp-server）。

## 已知限制

- 只有呼叫 Navide 已有 workflow 的 Execute Workflow 會變成子 Pipeline；遞迴呼叫與 Call n8n Workflow Tool 會維持需要確認。
- `pinData` 會變成 Kickoff 裡的測試輸入，不會變成凍結輸出的步驟。
- 超過約 8 個步驟只會警告；每個步驟都會開一個 CLI Pane。
- 節點對照表依 n8n 公開文件、按節點類型與版本整理；不認得的節點由 Agent 代行並標成需要確認。
