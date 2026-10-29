# 產品 Roadmap

[English](../en-US/roadmap.md) | 繁體中文 | [日本語](../ja-JP/roadmap.md) | [文件中心](README.md)

Navide 的長期方向是成為 **Agent 時代的工程利器**：一套讓一位工程師在完整軟體生命週期中指揮 AI 工程力量的主要環境。

目的地不只是 Multi-agent Terminal Manager 或 Control Plane。工程師最終應該能夠在不回到傳統 IDE 作為主要工作環境的情況下，理解、建立、瀏覽、編輯、執行、除錯、測試、審查、版本控制並交付軟體。

這份 Roadmap 描述方向，不承諾日期，也不宣稱未來能力已經交付。已發布行為記錄在 [CHANGELOG.md](../../CHANGELOG.md)；目前行為記錄在[使用指南](user-guide.md)；底層目的記錄在[宣言](manifesto.md)與[產品願景](vision.md)。

## North star

```text
工程師定義成果
  → Navide 恢復私有專案智慧
  → 組成正確的 Agent 與 Session
  → 拆解工作、指定所有權並同步
  → Agent 在可見邊界內平行執行
  → Navide 偵測衝突、風險與重要例外
  → 測試、審查與證據收斂成一項成果
  → 工程師在需要判斷時精準介入
  → 成果被接受，並成為下一次 Evolution 的脈絡
```

使用者仍然對意圖、長期決策、憑證、破壞性操作、外部發布與最終驗收負責。

## 產品原則

1. **一位工程師，一整支 AI 工程力量** — 為個人指揮多個 Agent 的完整系統最佳化，而不是重現傳統人類組織圖。
2. **成果先於按鍵輸入** — 工作的主要單位是具有驗收證據的目標；檔案與修改仍然是第一級實作 Artifact。
3. **Evolution 是中心** — 建立專案很重要，但真實工程工作的主體是反覆進行功能、修正、測試與微調。
4. **例外管理** — 例行且可逆的工作應避免批准噪音；歧義、風險、衝突、外部影響與不可逆操作應交還工程師。
5. **私有專案智慧** — `.agent-team/` 是本機、個人、排除於 Git、可檢查且可控制的資料層，絕不是隱含的團隊或雲端同步層。
6. **自主但不透明** — 工作必須保持可見、可中斷、可恢復並以證據負責。
7. **完整工程能力** — Navide 最終必須涵蓋取代傳統 IDE 所需的專業工作流，同時以 Agent 時代模型重新詮釋。
8. **Provider 獨立** — Agent 與模型能力必須明確表達，不能隱藏在單一供應商假設中。

## 現在與目的地

| 領域 | 現在 | 目的地 |
|---|---|---|
| Genesis | 可設定的 SDLC Pipeline 圖：平行 Stage、核准 Gate、有上限的退回迴圈、釘選節點與從節點重跑 | 產生經驗證初始系統與長期專案智慧的適應式建立工作流 |
| Evolution | 手動 Pane 與維護任務 | 協調多個有所有權與依賴關係 Session 的意圖驅動日常 Workspace |
| Intervention | Monaco、Diff、Terminal、Git、Diagnostics、Review | 完整的瀏覽、編輯、執行、除錯、測試、審查、版本控制與交付環境 |
| 協調 | Manager Protocol、Handoff、History、Session Attribution | 結構化共用狀態、所有權、依賴、衝突與進度同步 |
| 記憶 | Project State、Run、History、Token | 用於任務、決策、Handoff、證據與恢復的版本化 Private Project Intelligence 模型 |
| 自治 | 手動 Toggle、Analyzer、Full Auto、YOLO、Timeout | 具有明確權限與 Escalation 的 Policy-driven Management by Exception |
| 交付 | Git、Issue、Review、Commit 相關工作流 | 可追蹤的成果 → 變更 → 測試 → Release 生命週期 |

## Horizon 0 — 建立工程利器

**成果：**使用者能理解新的工程模型、安裝 Navide 並安全評估。

範圍：

- Manifesto、Product Vision、正確現有能力文件、Architecture、Privacy 與 Roadmap
- 一致的產品名稱與支援 Agent 資訊
- 可重複的 macOS 簽章 Release 與 Updater 驗證
- 引導完成第一個專案與第一個 Evolution 任務
- 以 Agent 協調而非 Editor 新奇感為中心的產品 Demo

Exit Criteria：

- 新使用者能解釋 Genesis、Evolution、Intervention 與 Private Project Intelligence
- 全新且受支援的 Mac 能完成文件中的安裝與首次啟動流程
- 第一個正式簽章 GitHub Release 包含所有必要 Updater Asset
- 文件清楚區分目前行為與未來方向

## Horizon 1 — 可靠的 Session Fabric

**成果：**多個 Agent Session 表現得像可靠的本機工程力量，而不是彼此無關的 Terminal Window。

範圍：

- 明確的 preparing、ready、working、waiting、blocked、failed、completed、interrupted 與 resumable 生命週期狀態
- 長期 Session Identity、Provider Binding、Rebuild、Resume 與 Crash Recovery
- 結構化 Session Presence、Ownership、Progress、Blocker、Question 與 Completion Event
- 清楚區分原始 Terminal Activity 與 Engineering State
- 可靠的 Input Delivery、Cancellation、Retry、Timeout 與 Recovery 語義
- 能解釋 Session 為何無法推進或恢復的本機 Diagnostics

Exit Criteria：

- 代表性 Session 在應用程式重新啟動後不會無聲遺失狀態
- Session Identity 與 Ownership 在受支援 Resume 流程中保持穩定
- 每個自動生命週期轉換都有可見原因
- 失敗 Session 提供可恢復操作或可採取行動的診斷

## Horizon 2 — Private Project Intelligence Layer

**成果：**每個新 Session 都能繼承工程師累積的專案理解，而不必重播所有對話。

範圍：

- 用於 Project State、Session、Run、Task、Decision、Handoff、Evidence 與 Coordination Metadata 的版本化本機 Schema
- 清楚分離 Derived State、Durable Knowledge、Raw Log、Cache 與 Secret
- 具有來源與新鮮度 Metadata 的結構化事實與決策
- 根據目前目標組裝 Context，而不是無差別注入歷史
- Retention、Compaction、Deletion、Redaction、Backup 與明確的本機 Export／Import
- 顯示 Navide 記得什麼、Session 將收到什麼的可檢查 UI

Exit Criteria：

- 恢復或替代 Session 不需手動複製 Transcript，即可取得相關目標、限制、決策與證據
- 使用者可以檢查並刪除記憶資訊
- `.agent-team/` 持續排除於 Git，且不會隱含同步任何私有狀態
- Schema Migration 與 Corruption Recovery 經過測試
- Context Selection 不會把過時 Agent Output 無聲視為目前專案事實

## Horizon 3 — Evolution Workspace

**成果：**日常功能開發、修正、測試、調校與維護成為一致的意圖驅動循環。

範圍：

- 將維護從附帶概念提升為第一級 Evolution Workspace
- 具有 Scope、Acceptance Criteria、Priority、Dependency 與 Evidence Requirement 的 Goal
- Navide 建議、工程師可修改的 Session 組合
- Task Ownership、Dependency Graph、Parallel Scheduling 與 Partial Retry
- File、Module、Repository 與 Environment Scope Awareness
- 對 Agent 工作重疊的衝突預防或早期警告
- 從 Goal 經過實作、測試、修復、Review 到 Acceptance 的持續循環
- 允許 Fork 或 Resume Evolution Run 的 Checkpoint

Exit Criteria：

- 工程師不必手動建立每個 Session 就能啟動下一項功能
- 獨立任務平行執行，依賴任務依照確定順序等待
- 在破壞性整合前即可看見重疊所有權
- 失敗 Node 能重試，不需重新啟動已成功的獨立工作
- 已接受成果成為下一個 Evolution Goal 的脈絡

## Horizon 4 — 例外管理

**成果：**Navide 保護工程師注意力，同時不放棄控制。

範圍：

- 用於探索、Workspace Edit、Command、Test、Network Access、Credential、Git Publication、Deployment 與 Unrestricted Execution 的明確 Authority Profile
- 用於歧義、衝突、證據失敗、受保護資源、外部影響、Budget Limit 與不可逆操作的 Exception Model
- 整合 Decision Queue，取代每個 Session 各自發出的 Prompt
- 能在 Escalation 前解決例行問題的 Manager 與 Peer Coordination
- 在 Handoff、Cloud Request、Diagnostics 與 Export 前進行 Secret Detection 與 Redaction
- 在平台可強制執行範圍內提供 Workspace 與 Protected Path Isolation
- Policy、Escalation、Override 與 Acceptance Decision 的完整 Audit Trail

Exit Criteria：

- 例行可逆工作能在沒有批准疲勞的情況下完成
- 敏感或不可逆操作不能在有效 Policy 之外執行
- 每次 Escalation 都說明決策、現有證據、後果與建議下一步
- Handoff 與 Diagnostic Redaction 通過對抗性測試
- 每個平台與 Agent 都誠實說明無法支持的 Sandbox 保證

## Horizon 5 — 完整 Intervention 環境

**成果：**工程師能在不以另一套 IDE 為主要環境的情況下，完成理解與修改軟體所需的所有精準工作。

範圍：

- 快速 Project Navigation、Global Search、Symbol Search、Reference 與 Code Intelligence
- 穩定的 Monaco Editing、Multi-file Operation、Diagnostics、Refactoring、Formatting 與 Language Server Integration
- 整合 Run Configuration、Task、Test Discovery、Test Result、Log 與 Interactive Terminal
- 具有 Breakpoint、Stack／Variable Inspection、Evaluation 與 Agent-readable Debug Evidence 的 Debugging
- 第一級 Diff、Branch Comparison、Conflict、History、Blame 與 Review
- Git Branch、Worktree、Commit、Remote、Pull Request、Check 與 Review Feedback
- 用於 Language、Tool、Debugger、Test System 與 Engineering View 的 Extension Point
- Performance、Accessibility、Keyboard Control 與 Large-workspace Reliability

Exit Criteria：

- 目標使用者能完成代表性專業專案，不必因缺少核心能力開啟另一套 IDE
- Intervention 保留 Context，並能乾淨返回協調式 Agent Execution
- Agent 與人類能參照相同 Diagnostics、Test、Symbol、Diff 與 Debug Evidence
- 大型 Repository 在定義的 Performance Budget 內保持回應

這個 Horizon 不要求複製每一種傳統 IDE 互動，而是透過更好的 Agent 時代模型達成成果對等。

## Horizon 6 — 可驗證的 Genesis 與交付

**成果：**產品能在一套可追蹤工程環境中，從初始意圖走向持續交付。

範圍：

- 產生 Requirement、Architecture、Implementation、Test 與明確初始 Evolution Backlog 的適應式 Genesis Workflow
- 連結 Intent、Repository、Base Revision、Agent、Policy、Action、Artifact 與 Evidence 的 Immutable Run Manifest
- 從 Requirement 到 Task、Change、Test、Review、Commit 與 Release 的 Provenance
- 具有 Repository 與 Permission Preflight 的 GitHub Issue／Pull Request Intake
- 有意識的 Branch、Commit、Push、Draft PR、Check、Review 與 Follow-up Flow
- 具有明確人類權限的 Build、Packaging、Deployment 與 Release Gate
- 可重現的 Run Export 與 Fork-from-checkpoint 行為

Exit Criteria：

- 新產品能進入 Genesis，產生經過測試且已準備 Evolution 的 Prototype
- 已接受 Goal 能在使用者明確核准後產生附帶證據的 Draft PR
- 失敗 Check 與 Review Feedback 轉換為有範圍的 Follow-up Work
- External Write、Deployment 與 Release 不會在權限含糊時發生
- Exported Run Evidence 不需原始 Live Session 就能檢查

## Horizon 7 — Agent、平台與生態成熟度

**成果：**當模型、Agent、語言、工具與作業系統改變時，Navide 仍然能長期運作。

範圍：

- 用於 Agent Identity、Installation、Capability、Permission、Launch、Readiness、Resume、Interruption、Session Discovery 與 Usage 的 Declarative Adapter Contract
- Compatibility Test Kit 與 Adapter Health Diagnostics
- 可重用 Role、Pipeline、Policy、Team Configuration 與 Engineering Template
- 具有 Version 與 Capability Metadata 的安全 Template Packaging
- 具有 PTY、Path、Permission、Packaging 與 Update 對等性的 Linux Support——已在 `main`，由 Linux CI Gate 涵蓋，x64 的 AppImage 與 `.deb` 自 v0.2.2 起隨發行提供；剩餘工作是發布 arm64 版本（Release CI 目前只在手動 dispatch 時建置）
- 具有 ConPTY、Filesystem Behavior、Packaging 與 Policy 對等性的 Windows Support——已在 `main`，由 Windows CI Gate 涵蓋，x64 的 NSIS 安裝程式自 v0.2.2 起隨發行提供；剩餘工作是程式碼簽章與可優雅關閉 CLI 的訊號。Task Scheduler 整合不在計畫內：Navide 本身從不建立排程工作，而工作排程器已能列出、啟用、停用與移除機器上的工作。只有在 Navide 開始自行註冊工作時才重新評估——屆時以第三種 execution kind 走 PowerShell `ScheduledTasks` 模組
- Platform 與 Adapter Capability Matrix
- Internationalization 與 Accessible Workflow

Exit Criteria：

- 簡單 Agent 不需修改核心 Pipeline UI Logic 就能整合
- 內建 Adapter 通過共用 Compatibility Suite
- Template 不能隱含執行程式碼或授予權限
- Platform CI 涵蓋 Unit、Integration、Packaging、Terminal、Editor 與代表性 Evolution Workflow
- 執行前即可看見不受支援的能力

## 跨 Horizon 品質門檻

每個 Horizon 都必須處理：

- 向後相容的本機狀態或明確 Migration Path
- Threat Model 與 Privacy Data Flow 變更
- 與風險成比例的 Unit、Integration 與 End-to-end Coverage
- Recovery、Diagnostics 與使用者控制刪除
- Performance、Storage、Accessibility 與 Internationalization
- 現有能力文件與 Release Notes
- 對 Credential、Destructive Operation、External Write、Deployment 與 Publication 的明確人類權限

## 進展衡量方式

Navide 目前不收集產品 Telemetry。除非未來採用經隱私審查的 Telemetry 設計，衡量方式應來自本機 Report、Test、Opt-in Diagnostics 或使用者明確分享的 Issue 資料。

有用指標包括：

- 將 Navide 作為日常主要工程環境的工程師數量
- 從開啟 Workspace 到啟動健康 Evolution Goal 的時間
- Session Binding、Rebuild、Resume 與 Recovery 成功率
- 在沒有 Ownership Conflict 或手動複製 Context 下完成的平行 Session
- 真正需要人類判斷的 Exception，相對於被避免的例行批准 Prompt
- 具有連結 Change、Test、Review 與 Evidence 的完成 Goal
- 用於指揮與接受工作的時間，相對於修復 Orchestration Failure 的時間
- 完成代表性工作流時必須離開 Navide 開啟傳統 IDE 的次數
- 被阻止進入 Handoff、Cloud Request 或 Exported Artifact 的 Secret

## 目的地

當一位工程師能夠從一個想法開始，組成並指揮 AI 工程力量，持續 Evolution 產品，在需要時精準介入，交付可信軟體，而且傳統 IDE 不再是工作中心時，Navide 才真正完成其企圖。
