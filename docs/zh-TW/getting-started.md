# 開始使用

[English](../en-US/getting-started.md) | 繁體中文 | [日本語](../ja-JP/getting-started.md) | [文件中心](README.md)

Navide 支援配備 Apple 晶片且執行 macOS 13 以上版本的 Mac，以及 Linux x64 與 x64／Arm 版 Windows。[最新的 GitHub Release](https://github.com/Navide-dev/Navide/releases/latest) 提供 macOS 的 DMG 與 ZIP 下載（已經 Developer ID 簽章與 Apple Notarization）、Windows x64 與 Arm64 的 NSIS 安裝程式，以及 Linux x64 的 AppImage 與 `.deb`。GitHub 下載很慢或失敗時，同一批檔案也由 dl.navide.dev 鏡像提供——README 的下載清單每個檔案旁都有「鏡像」連結，navide.dev 官網在鏡像可達時會自動改用它。

若要在 macOS 安裝，請下載 DMG、將 Navide 複製到「應用程式」，接著正常開啟即可，無需繞過 Gatekeeper。

Windows 版本尚未經過程式碼簽章，首次執行時 SmartScreen 會出現警告。

## 在 Windows 安裝

從 Release 下載 `Navide-<版本>-win-x64.exe`（Arm 版 Windows 請下載 `Navide-<版本>-win-arm64.exe`）並執行。安裝程式尚未程式碼簽章，首次執行時 SmartScreen 會顯示「Windows 已保護您的電腦」：請點 **其他資訊 → 仍要執行**。Windows 簽章已決定暫緩，在簽章上線前每個新安裝檔都會出現這個提示。Windows 上的 App 內更新可以使用，但同樣不會驗證簽章。

## 在 Linux 安裝

x64 提供兩種套件：

- **AppImage**——`chmod +x Navide-<版本>-x86_64.AppImage` 後直接執行。它自帶 FUSE runtime，並透過 App 內更新器自我更新。
- **`.deb`**——`sudo apt install ./Navide-<版本>-amd64.deb`。會安裝到 `/opt/Navide/navide`，並在 `PATH` 提供 `navide` 指令與桌面捷徑；更新走套件管理器，不走 App 內更新器。

## 從原始碼安裝的前置需求

- 配備 Apple 晶片的 macOS 13+、Linux x64，或 x64／Arm 版 Windows
- Node.js 22.12+（22.x）
- pnpm 10+
- Python 3.12+
- uv 0.11+
- 至少一個受支援的 Coding CLI（共 14 種：Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code），清單見[使用手冊](user-guide.md)
- 選用：用於本機分析的 Ollama 或本機 GGUF 模型
- Windows 專屬：開發人員模式（**設定 → 開發人員專用**）或以系統管理員身分執行 Navide，Navide 才能建立每個 Pane 的 CLI Home 與受管理 Skills 所需的符號連結

每個 Coding CLI 都有自己的安裝、驗證、訂閱與資料政策。Navide 不會取代這些需求。

## 從原始碼安裝

```bash
git clone https://github.com/Navide-dev/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

`pnpm dev` 會同時啟動 Electron 應用程式、Vite Renderer 與 Python FastAPI Backend。

## 首次啟動

Onboarding Wizard 會檢查必要 Runtime，並偵測可用的 Agent CLI。依序完成：

1. 解決任何阻擋啟動的基礎相依套件。
2. 確認至少一個 Coding CLI 已可使用並完成驗證。
3. 如果需要 Intent Detection 與自動回答，設定 Local Analyzer。
4. 在 macOS 上，只授予實際工作流需要的權限。
5. 開啟一個可信任的專案資料夾作為 Workspace。

在 macOS 上，Navide 可能依照 Agent 與 Terminal 存取 Workspace 的方式，要求 Automation、Files and Folders 或 Full Disk Access。授予權限前，請先閱讀 macOS 顯示的原因。Windows 與 Linux 沒有對應的權限提示。

完成 Onboarding 後，Settings → CLI Agents 會列出每個偵測到的 CLI，包含版本、安裝方式與上次更新結果，並可執行該 CLI 自己的更新與診斷指令。

## 執行第一個任務

最小成功測試：

1. 開啟可丟棄或已使用版本控制的 Workspace。
2. 手動啟動一個 Agent。
3. 提供唯讀任務，例如「總結這個 Repository」。
4. 確認 Terminal Output、Session Detection 與 History 都有更新。
5. 如果 CLI 提供相容 Usage Log，檢查 Token Stats。

手動流程確認正常後，再用小型任務測試 Pipeline。理解各 Stage 定義與影響之前，請停用 YOLO 或 Full Auto。

## 開發檢查

```bash
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests
```

如果應用程式、Backend、CLI、Session Binding、Analyzer 或 Token Tracking 未正常啟動，請參考[疑難排解](troubleshooting.md)。
