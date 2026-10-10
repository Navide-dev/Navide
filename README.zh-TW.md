# Navide

> **Agent 時代的工程利器。**
>
> 一位工程師，一整支 AI 工程力量。

Navide 是一套開源、AI-native 的軟體工程環境，專為一個人調度多個 Coding Agent 而設計。它將目標、Agent、Session、私有專案智慧、工程工具與驗收證據整合在一個 Local-first Workspace 中。

它不是傳統 IDE 裡的另一個聊天面板。Navide 要成為傳統 IDE 之後的新工程環境。

[English](README.md) | 繁體中文 | [日本語](README.ja-JP.md)

[下載 v0.2.19](https://github.com/Navide-dev/Navide/releases/tag/v0.2.19) | [開始使用](docs/zh-TW/getting-started.md) | [文件中心](docs/zh-TW/README.md) | [Roadmap](docs/zh-TW/roadmap.md)

[![Latest release](https://img.shields.io/github/v/release/Navide-dev/Navide?sort=semver&label=release&logo=github)](https://github.com/Navide-dev/Navide/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](docs/zh-TW/getting-started.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## AI 改變了執行能力，協調成為新的瓶頸

傳統 IDE 是為親自完成大部分實作工作的工程師設計：開啟檔案、撰寫程式、執行工具，然後不斷重複。

AI 改變了這個前提。一位工程師現在可以同時要求多個 Agent 平行進行研究、規劃、實作、測試、審查與微調。限制工作的問題，從輸入程式碼轉變為如何指揮：

- 哪一個 Agent 應該負責哪一項成果？
- 每個 Session 需要什麼脈絡與限制？
- 哪些 Session 正在重疊、等待或失敗？
- 什麼時候必須由人類進行判斷？
- 哪些證據能證明成果已經完成？

AI 模型提供執行動力，Navide 提供駕馭這股力量所需的工程系統。

```text
傳統 IDE
工程師 → 編輯檔案、操作工具 → 軟體

Navide
工程師 → 指揮目標、Agent、決策與證據 → 軟體
```

工程師仍然對意圖、架構、風險、判斷與最終驗收負責；Agent 承接可重複的執行工作；Navide 讓整個過程保持可見、同步、可中斷並可恢復。

## Navide 改變的三件事

### 指揮工作

將一個工程目標轉換為彼此獨立的 Session、指定角色、平行執行與可設定的開發階段。Navide 支援多個 Coding Agent，而不必把所有任務塞進同一段對話。

### 保存專案智慧

在個別 Agent 對話之外延續 Workspace 狀態、先前 Run、Session 資訊、Handoff 與歷史紀錄。私有專案智慧儲存在 `<workspace>/.agent-team/`，並排除於 Git 之外。

### 在需要判斷時介入

讓可逆的工作在全程可見的前提下持續進行。遇到需求歧義、風險、衝突、外部影響或不可逆決策時，才將注意力交還給工程師。透過 Diff、Editor、Terminal、Diagnostics、Git、Tests 與 Review 進行精準介入。

## 一套環境，三種工程循環

### Genesis — 從想法到第一個可運作成果

以可設定的 Pipeline 啟動新專案，涵蓋需求、規劃、設計、實作、安全審查與測試。多個 Agent slot 可以平行工作，並在各階段之間傳遞脈絡。

### Evolution — 持續發展產品

透過彼此協調的 Session，為既有專案開發功能、修復問題、執行測試、微調行為並持續維護。這個反覆發生的 Evolution 循環，而非一次性的生成流程，才是日常工程工作的核心。

### Intervention — 人類精準控制

在必要時直接檢查並修改成果。編輯仍然是第一級專業能力，但它成為更大工程系統裡的一種控制方式，而不再是推進軟體工作的唯一方法。

## Navide 開發 Navide

Navide 已經是創辦人持續開發這個專案時使用的主要工程環境。

新專案從需求與 Pipeline 開始；日常產品工作透過多個 Agent Session 完成實作、測試、修正、審查與微調；整合的 mini IDE 則在需要檢查成果或精準編輯時選擇性開啟。

這是創辦人親自使用產品的第一方證據，不是獨立客戶驗證。下一階段的證據，必須來自其他工程師在自己的真實專案中使用 Navide。

## 目前已具備

- **多 Agent Workspace：**在獨立 pane 中執行 14 種支援的 coding CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）或一般 Terminal。
- **CLI 管理：**偵測已安裝的 Coding CLI、版本與安裝方式，並執行各 CLI 官方自己的更新與診斷指令。
- **Session 生命週期：**偵測、保存、重建並恢復受支援的 CLI Session。
- **可設定 Pipeline：**定義 Stage、平行 slot、Agent、角色、kickoff prompt、提問規則、文件查詢與完成 sentinel。
- **Manager 協調：**路由結構化任務派發與 Worker 問題，並傳遞跨階段脈絡。
- **自動化控制：**結合 Terminal 活動、Provider Log、Hook 與選用的本機分析，提供 Manual、Strict、Continuous、Full Auto 與 YOLO 模式。
- **私有專案歷史：**在 `.agent-team/` 保存 Workspace 狀態、Run Event、Handoff 與相容的 Token 摘要。
- **工程操作介面：**瀏覽與編輯檔案、檢視 Plan 與 Diff、處理衝突、使用 Terminal、Git、多 Repository 工作流、Issue、Review 與內嵌的 AI Terminal。
- **可觀察性：**依 Workspace、Stage、Pane 與 Run 檢視 History 及相容 CLI 的 Token 用量。

## 現在與目的地

Navide 已有一套可運作的 Local-first 基礎，但完整的 Agent 時代工程環境仍是長期產品方向。

| 目前已具備 | 產品方向 |
|---|---|
| 獨立 Coding Agent 與 Terminal Session | 由意圖驅動的任務與依賴關係調度 |
| 可設定的多階段 Pipeline | 適應式 Genesis 與持續 Evolution 工作流 |
| 本機 Workspace 狀態與歷史紀錄 | 可檢查、可控制的 Project Intelligence Layer |
| 手動與 Analyzer 輔助的自動化控制 | 由完整 Policy 驅動的例外管理 |
| Editor、Diff、Terminal、Git、Tests 與 Review | 不必以另一套 IDE 為中心的完整專業交付能力 |

產品方向代表設計意圖，不表示功能已經交付，也不是交付日期承諾。詳細範圍與完成條件請見 [Product Roadmap](docs/zh-TW/roadmap.md)。

## 預設私有，誠實說明邊界

Navide 的調度程序、私有專案智慧與 Workspace 狀態都在本機執行。Navide 不營運專案遙測服務，也不要求建立 Navide 帳號。

Local-first 不代表所有情況都完全離線。使用外部 Agent CLI、雲端 AI Provider、Context7、搜尋、Git Hosting、MCP Server 或更新檢查時，可能會與第三方服務通訊。Agent 一般會繼承目前使用者的作業系統權限，而 Navide 尚未提供完整的 Workspace Sandbox。

處理敏感程式碼、憑證、YOLO 或 Full Auto 前，請閱讀[隱私與資料流](docs/zh-TW/privacy.md)與英文版 [Security Policy](SECURITY.md)。

## 試用 Navide

Navide 支援配備 Apple 晶片且執行 macOS 13 以上版本的 Mac、Linux x64，以及 x64／Arm 版 Windows。v0.2.19 提供經 Developer ID 簽章並通過 Apple Notarization 的 macOS 版本，以及 Windows x64 安裝程式與 Linux x64 套件：

- [下載 DMG](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.dmg) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.dmg))
- [下載 ZIP](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-arm64.zip) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-arm64.zip))
- [下載 Windows x64 安裝程式](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-x64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-x64.exe))
- [下載 Windows ARM64 安裝程式](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-win-arm64.exe) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-win-arm64.exe))
- [下載 Linux AppImage](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-x86_64.AppImage) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-x86_64.AppImage))・[下載 Linux .deb](https://dl.navide.dev/releases/v0.2.19/Navide-0.2.19-amd64.deb) ([GitHub](https://github.com/Navide-dev/Navide/releases/download/v0.2.19/Navide-0.2.19-amd64.deb))

連結指向 dl.navide.dev，與 App 自動更新用的是同一個載點；旁邊的「GitHub」連結是 GitHub Release 上同一個檔案、逐位元相同（發版流程同時發佈兩邊並比對 checksum）。

將 Navide 複製到「應用程式」後即可正常開啟，無需繞過 Gatekeeper。自此版本起支援 App 內自動更新。

Linux 與 Windows 通過與 macOS 相同的 CI 關卡。Arm 版 Windows 的原生安裝程式由 Release CI 建置、自下一個版本起隨發行提供；在此之前 Arm 版 Windows 以模擬方式執行 x64 安裝程式。Windows 版本尚未經過程式碼簽章，因此首次執行時 SmartScreen 會出現警告；「執行管理」視窗在該平台依設計沒有可列出的內容（它讀的是使用者的 crontab 與 macOS 的 launchd；Windows Task Scheduler 是刻意不整合——Navide 本身從不建立排程工作，而工作排程器已能管理機器上的工作）；每個 Pane 的 CLI Home 與受管理的 Skills 以符號連結建立，因此需要 Windows 開發人員模式或以系統管理員身分執行 Navide；CLI 只能被直接終止而無法收到停止通知，Pane 關閉前可能來不及寫出 Transcript。

若要建立開發環境，仍可從原始碼安裝。

### 原始碼安裝前置需求

- Node.js 22.12+（22.x）與 pnpm 10+
- Python 3.12+ 與 uv 0.11+
- 至少一個受支援的 Coding CLI
- 選用：Ollama 或本機 GGUF 分析模型

### 從原始碼安裝與啟動

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

Onboarding Wizard 會檢查 Runtime、偵測 Agent CLI，並說明相關 macOS 權限。接著可閱讀[開始使用](docs/zh-TW/getting-started.md)與[使用指南](docs/zh-TW/user-guide.md)。

## 文件與深入閱讀

- **使用 Navide：**[開始使用](docs/zh-TW/getting-started.md)、[使用指南](docs/zh-TW/user-guide.md)與[疑難排解](docs/zh-TW/troubleshooting.md)
- **理解產品：**[Navide 宣言](docs/zh-TW/manifesto.md)、[產品願景](docs/zh-TW/vision.md)、[產品定位](docs/zh-TW/product-positioning.md)與[產品 Roadmap](docs/zh-TW/roadmap.md)
- **檢查能力邊界：**[隱私與資料流](docs/zh-TW/privacy.md)與英文版 [Security Policy](SECURITY.md)
- **瀏覽完整內容：**[Navide 繁體中文文件中心](docs/zh-TW/README.md)

## 授權

MIT © Navide Team
