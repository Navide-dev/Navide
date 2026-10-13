# Navide 繁體中文文件

[English](../en-US/README.md) | 繁體中文 | [日本語](../ja-JP/README.md) | [語言入口](../README.md)

Navide 是 Agent 時代的工程利器：一套讓一個人透過建立、持續演進與精準介入，指揮多個 Coding Agent 的 AI-native 軟體工程環境。

Root [繁體中文 README](../../README.zh-TW.md) 負責介紹產品與目前發布方式；本頁負責整理完整文件結構。標示「English」的項目尚未提供繁體中文版本。

## 產品

| 文件 | 用途 |
|---|---|
| [Navide 宣言](manifesto.md) | Navide 回應的時代變化，以及引導產品發展的信念 |
| [產品願景](vision.md) | 目標使用者、產品模型、責任歸屬、運作哲學與成功定義 |
| [產品定位與公開主張](product-positioning.md) | 產品類別、訊息層次、用詞、證據與公開主張邊界 |
| [產品 Roadmap](roadmap.md) | 從現有系統走向完整 AI-native 工程環境的方向性路徑 |

## 使用 Navide

| 文件 | 用途 |
|---|---|
| [開始使用](getting-started.md) | 下載已簽章的 macOS 版本或 Windows／Linux 安裝檔，或從原始碼安裝，並完成首次啟動 |
| [使用指南](user-guide.md) | 學習 Workspace、Pane、Pipeline、協調、Git、History 與 Editor 工作流 |
| [疑難排解](troubleshooting.md) | 解決啟動、權限、Agent Session、Analyzer 與 Token Tracking 問題 |

## 信任與安全

| 文件 | 用途 |
|---|---|
| [隱私與資料流](privacy.md) | 理解哪些資料留在本機、哪些功能可能連線第三方，以及憑證儲存位置 |
| [Security Policy — English](../../SECURITY.md) | 理解目前安全邊界並私下回報 Vulnerability |

## 開發與維護

| 文件 | 用途 |
|---|---|
| [Contributing — English](../../CONTRIBUTING.md) | 建立開發環境並提交變更 |
| [Architecture — English](../en-US/architecture.md) | 理解 Process Boundary、State Ownership 與主要 Service |
| [Adding a CLI Vendor — English](../adding-a-cli-vendor.md) | 新增 AI Coding CLI：兩份 Spec 檔、註冊，以及 CI 強制的檢查 |
| [CLI Integration Records — English](../en-US/cli-extension-guide.md) | 各家 CLI 的整合紀錄：安裝方式、Resume 語法、Session 儲存格式 |
| [CLI Vendor Matrix — English](../en-US/cli-vendor-matrix.md) | 已支援的 CLI 總覽：實際執行的指令，以及每家 spec 宣告的能力 |
| [Plugin Development — English](../en-US/plugin-development.md) | 開發前端 View 插件或後端插件，並打包簽章發布 |
| [Plugin Development v2 — English](../en-US/plugin-development-v2.md) | 使用公開 Contracts、SDK、UI Package 與外部 Frontend Package Workflow |
| [Publishing to the Navide Marketplace — English](../en-US/marketplace-publishing.md) | 用 `navide-plugin` 建立、打包、簽章並發布插件到 Navide Marketplace，通過審核上架 |
| [外部 MCP 控制](external-mcp-control.md) | 連接外部 MCP Client 控制執行中的 Navide 視窗，並理解安全模型 |
| [Release Guide — English](../en-US/releases.md) | 版本、封裝、簽章、Notarization、發布與復原 Release |

## 參考資料

| 文件 | 用途 |
|---|---|
| [CLI 之間的訊息傳遞](inter-cli-messaging.md) | CLI Agent 之間的定址、傳送、接收與問題排查 |
| [Keyboard Shortcuts — English](../en-US/keybindings.md) | 查閱預設鍵盤 Command 與互動方式 |
| [Editor Design — English](../en-US/editor-design.md) | 理解目前 Editor Architecture 與設計方向 |
| [Historical Milestone Record — English](../en-US/spec.md) | 查閱原始實作 Milestone 紀錄 |
| [Changelog — English](../../CHANGELOG.md) | 依版本查閱已交付變更 |

## 文件模型

- `README.md` 是公開英文產品與發布入口；`README.zh-TW.md` 與 `README.ja-JP.md` 分別是繁體中文與日文入口。
- `docs/en-US/` 是英文文件原始基準。
- `docs/zh-TW/` 與 `docs/ja-JP/` 分別鏡像已翻譯的公開產品與核心使用者路徑；尚未翻譯的技術文件明確標示為 English。
- 英文文件是產品與技術事實的 Source of Truth。功能改變時先更新英文版，並在同一項變更中同步繁體中文版。
- Vision 與 Roadmap 可以描述未來成果；README 能力清單與 User Guide 只描述目前行為。
- 已發布行為記錄在 Changelog 與 GitHub Releases；Roadmap 描述方向，不承諾日期。
- `.agent-team/` 中的 Private Project Intelligence 屬於個別使用者、預設保留在本機並排除於 Git；它不是人類團隊同步層。
