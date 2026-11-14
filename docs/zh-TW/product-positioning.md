# 產品定位與公開主張

[English](../en-US/product-positioning.md) | 繁體中文 | [日本語](../ja-JP/product-positioning.md) | [文件中心](README.md)

這份文件用來維持 Navide 在 README、網站文案、Demo、Release Notes、簡報與社群貼文中的公開敘事一致。它是溝通參考，不取代 User Guide、Roadmap 或 Release History。

## 產品類別

Navide 是一套 **AI-native 軟體工程環境**，也是 **Agent 時代的工程利器**。

它不被定位為另一套 Code Editor、Terminal Multiplexer、IDE Plug-in 或 AI Chat Panel。這些可能是介面的一部分，但產品類別由 Agent 時代工程工作的完整系統定義：

- 目標與驗收條件
- Agent、角色與 Session
- 平行執行與協調
- 私有專案智慧
- 人類例外與 Intervention
- 變更、測試、審查與證據

## 主要受眾

Navide 首先為負責完整軟體成果並指揮多個 Coding Agent 的個人打造：

- 獨立開發者
- 技術創辦人
- 負責完整產品範圍的工程師

除非產品策略經過明確調整，團隊與企業敘事不應取代這項初始焦點。

## 問題

AI 增加一位工程師能發起的執行量，但不會自動解決所有權、協調、長期脈絡、可見性、例外或驗證問題。

傳統 IDE 假設一位工程師手動推進一條主要工作流。Agent 時代的工程需要一套能夠組織意圖與並行執行的環境。

## 核心承諾

> **一位工程師，一整支 AI 工程力量。**

Navide 將目標轉化為協調一致、全程可見且可以驗證的軟體工作；工程師仍然對意圖、架構、風險、判斷與最終驗收負責。

## 類別對比

> **傳統 IDE 組織程式碼，Navide 組織工程工作。**

```text
傳統 IDE
工程師 → 編輯檔案、操作工具 → 軟體

Navide
工程師 → 指揮目標、Agent、決策與證據 → 軟體
```

這項對比說明工作重心的改變，不代表檔案、編輯、Terminal 或傳統工程工具變得不重要。

## 訊息層次

### 1. 指揮工作

將成果轉換為協調一致的 Agent、獨立 Session、指定角色、平行執行與可設定開發階段。

### 2. 保存專案智慧

透過本機 `.agent-team/` 層，在個別 Agent 對話之外恢復 Workspace 狀態、先前 Run、Session 資訊、Handoff 與歷史紀錄。

### 3. 在需要判斷時介入

讓可逆工作在可見狀態下持續進行；遇到歧義、風險、衝突、外部影響、不可逆操作或主觀產品判斷時，才將注意力交還給工程師。保留 Diff、Editor、Terminal、Diagnostics、Git、Tests 與 Review 作為精準控制工具。

## 產品模型

- **Genesis** 將想法轉化為第一個可運作成果。
- **Evolution** 持續開發、測試、修正並微調真實產品，是 Navide 的日常中心。
- **Intervention** 在需要判斷或精度時，提供工程師直接的專業控制能力。

## 證據層次

公開證據應依照以下順序發展：

1. **已交付產品行為** — 由應用程式、測試、文件或 Release Artifact 支持的可見現有能力。
2. **創辦人 Dogfooding** — Navide 作為開發 Navide 的主要環境。這是有效的第一方證據。
3. **獨立使用者工作流** — 其他工程師在真實專案中使用 Navide，並允許分享使用經驗。
4. **可重複成果** — 多位使用者報告一致且有價值的工作流。
5. **量化產品證據** — 以明確、可審查的方法支持採用、留存、效能或品質主張。

創辦人 Dogfooding 絕不能描述成客戶驗證；未來方向絕不能描述成已交付行為。

## 標準用詞

| 建議用詞 | 意義 | 避免使用 |
|---|---|---|
| AI-native 工程環境 | 產品類別 | 沒有進一步解釋的 AI IDE |
| Agent 時代的工程利器 | 願景與品牌類別 | 籠統的 AI 生產力工具 |
| AI 工程力量 | 由一位工程師指揮的多個 Agent | AI 員工、自動公司 |
| Session | 一個 Agent 或 Terminal 執行脈絡 | Bot Thread |
| Private Project Intelligence | 本機、個人專案脈絡 | 團隊記憶、雲端記憶 |
| Management by Exception | 只有需要重要判斷時才交還人類注意力 | 完全自治、無人監督 |
| 目前已具備 | 經過驗證的現有能力 | 沒有 Release 證據的 Production-ready |
| 產品方向 | 預期未來成果 | 沒有真實承諾的 Coming soon |

## 目前可以支持的主張

- Navide 支援多個獨立 Coding Agent 與 Terminal 分格。
- 目前 Registry 支援 14 種 coding CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）與一般 Terminal Session。
- 受支援的 Session 可以被偵測、保存、重建與恢復。
- Pipeline 可以定義 Stage、平行 slot、角色、Prompt、問題、文件查詢與完成 sentinel。
- Workspace 狀態、Run Event、Handoff 與相容 Token 摘要儲存在 `.agent-team/`。
- Navide 提供 Editor、Diff、Terminal、Diagnostics、Git、Tests 與 Review 介面。
- Navide 採用 Local-first，而且不要求建立 Navide 帳號。
- Navide 支援 Apple 晶片的 macOS 13 以上、Linux x64 與 x64／Arm 版 Windows。v0.2.2 提供以 Developer ID 憑證簽章並經 Apple 公證的 macOS 下載版本、Windows x64 安裝程式與 Linux x64 套件，以及原始碼安裝方式；Arm 版 Windows 的原生安裝程式由 Release CI 產出、自下一個版本起發布，Windows 版尚未程式碼簽章。
- Navide 創辦人使用它作為開發 Navide 的主要環境。

## 必須標示為方向的主張

- Navide 將取代傳統 IDE 成為主要工程環境。
- Navide 將提供完整、由 Policy 驅動的例外管理。
- Navide 將完整偵測衝突、風險、閒置 Session 與失敗。
- Project Intelligence Layer 將成為完全可檢查、可攜帶、可遮蔽與可控制的系統。
- 工程師將能讓產品從想法走向可信交付，而不以另一套 IDE 為工作中心。

出現這些主張時，必須使用「產品方向」、「長期方向」、「目的地」或同等明確的語言。

## 目前無法支持的主張

- 所有支援平台都已提供簽章或 Notarized 的下載版本（Windows 版尚未程式碼簽章）。
- Navide 已提供完整 Workspace Sandbox。
- Navide 在所有情況下都完全離線。
- Navide 讓工程師提升特定倍數的速度。
- Navide 已擁有客戶採用、留存或效能數據。
- 特定公司或獨立工程師為 Navide 背書。
- Navide 目前已取代所有專業 IDE 工作流。

這些主張必須先取得新的產品或市場證據才能公開。

## 各文件職責

- Root README 是精簡的公開產品故事與原始碼安裝入口。
- Manifesto 解釋產品背後的時代變化與信念。
- Product Vision 定義目標使用者、產品原則、所有權與成功條件。
- Roadmap 區分現有系統與預期目的地。
- User Guide 描述目前行為。
- Changelog 與 GitHub Releases 描述已交付變更。
- Privacy 與 Security 文件定義目前邊界，而不是未來保證。
