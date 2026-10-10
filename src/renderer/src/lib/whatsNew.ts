// Reusable "What's New" announcements.
//
// When the app starts running a version that has an entry here — and the user
// hasn't seen that version's announcement yet — App.vue shows WhatsNewModal
// once. To announce a future release (a rename, a headline feature, a migration
// note, …), just add an entry: the modal machinery handles showing it a single
// time, keyed on the app version. Prepend a NEW entry — retitling the one on
// top loses the release it belonged to (v0.1.78 was lost that way), which the
// no-gaps test in whatsNew.test.ts now catches.
//
// An entry may also carry a guided tour (`tour`): steps that point at the UI
// the release added, offered as "Take the tour" wherever the announcement
// appears. How to write one: docs/en-US/release-announcements.md.
//
// Content lives here (not in the i18n JSON) so an announcement is one self
// contained edit. Each field carries zh-TW and en-US, and may carry ja-JP;
// pickText falls back to the default locale (zh-TW) for anything missing.

import type { TourStep } from './tours'

export type WhatsNewText = {
  'zh-TW': string
  'en-US': string
  'ja-JP'?: string
}

/**
 * A headline feature given its own panel above the bullet list.
 *
 * Reserved for a release that introduces something a person did not have
 * before — not a better version of a thing they already used. A spotlight on
 * every release is a spotlight on nothing, so this stays empty unless the
 * release is also marked `major`.
 */
export interface WhatsNewSpotlight {
  /** Product name, shown as-is in both locales (e.g. 'Navide Cloud'). */
  name: string
  /** One line saying what it is, not what changed. */
  tagline: WhatsNewText
  /** What it lets somebody do. Three or four, each a capability. */
  points: WhatsNewText[]
}

export interface WhatsNewEntry {
  /** App version this announcement belongs to, e.g. '0.1.65'. */
  version: string
  title: WhatsNewText
  /** Bullet highlights shown in order. */
  highlights: WhatsNewText[]
  /** Optional footer note, e.g. an action the user should take. */
  note?: WhatsNewText
  /**
   * Marks a release worth stopping for: the modal takes on celebratory chrome
   * and says so in words. Every release matters to whoever shipped it, so the
   * bar here is the user's, not ours — a new surface, or something that
   * changes how the app is used.
   */
  major?: boolean
  /** The one feature this release is remembered for. Requires `major`. */
  spotlight?: WhatsNewSpotlight
  /**
   * Headline features drawn as side-by-side cards above the bullet list — for
   * a release with more than one thing worth stopping for, where a single
   * spotlight would have to pick one.
   */
  features?: WhatsNewFeature[]
  /**
   * A guided tour of this release (engine: lib/tours.ts, GuidedTour.vue).
   * When present, the post-update popup, Help → What's New… and the
   * announcement centre all offer "Take the tour". Step text is i18n keys under
   * tourI18nNamespace(version), e.g. `tour.v0_2_10.*`.
   */
  tour?: TourStep[]
}

/** One headline-feature card in the What's New modal. */
export interface WhatsNewFeature {
  /** A single glyph drawn in the card's badge. */
  icon: string
  name: WhatsNewText
  /** One or two lines saying what it lets somebody do. */
  tagline: WhatsNewText
  /** Where to find it, e.g. "Settings → Channels". */
  where: WhatsNewText
}

// Chrome labels (header + dismiss button), kept here so the whole announcement
// is editable in one place without touching the i18n JSON.
export const WHATS_NEW_CHROME = {
  header: { 'zh-TW': '新版更新', 'en-US': 'What’s New', 'ja-JP': '新機能' } as WhatsNewText,
  dismiss: { 'zh-TW': '知道了', 'en-US': 'Got it', 'ja-JP': 'OK' } as WhatsNewText,
  /** Replaces `header` on a release marked `major`. */
  majorHeader: { 'zh-TW': '重大更新', 'en-US': 'Major Update', 'ja-JP': 'メジャーアップデート' } as WhatsNewText,
  /** Heading over the bullet list once a spotlight sits above it. */
  alsoIn: { 'zh-TW': '這一版還有', 'en-US': 'Also in this release', 'ja-JP': 'このリリースのその他の変更' } as WhatsNewText,
  /** Label above the spotlight panel. */
  introducing: { 'zh-TW': '隆重介紹', 'en-US': 'Introducing', 'ja-JP': '新登場' } as WhatsNewText,
  /** Heading over the bullet list once feature cards sit above it. */
  details: { 'zh-TW': '細節', 'en-US': 'The details', 'ja-JP': '詳細' } as WhatsNewText,
  /** Buttons on an entry that carries a tour. */
  takeTour: { 'zh-TW': '帶我看一遍', 'en-US': 'Take the tour', 'ja-JP': 'ツアーを見る' } as WhatsNewText,
  retakeTour: { 'zh-TW': '再看一次導覽', 'en-US': 'Replay the tour', 'ja-JP': 'ツアーをもう一度' } as WhatsNewText,
  notNow: { 'zh-TW': '先不用', 'en-US': 'Not now', 'ja-JP': '今はしない' } as WhatsNewText,
  /** Footer hint beside the buttons: where "Not now" leaves the way back. */
  reopenHint: {
    'zh-TW': '之後可從選單列「輔助說明（Help）→ 新版更新…」再打開',
    'en-US': 'Reopen it any time from Help → What’s New…',
    'ja-JP': '「ヘルプ → 新機能…」からいつでも開けます',
  } as WhatsNewText,
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.2.19',
    title: {
      'zh-TW': 'CLI 擴充一覽、不再遺失的最近工作區、資源限制',
      'en-US': 'CLI Extensions at a Glance, a Recent List That Keeps Everything, and Resource Limits',
      'ja-JP': 'CLI 拡張の一覧、消えなくなった最近のワークスペース、リソース制限',
    },
    highlights: [
      {
        'zh-TW': '新增「設定 → CLI 擴充」：列出每個 AI CLI 自己安裝的 CLI 擴充——Claude plugin 與 Claude mod、Codex plugin 與 hook，還有 Copilot、Droid、Cursor、Qwen、opencode、Kilo、Pi 等——以及每一項的執行等級（文字資產、子程序，或在 CLI 程序內執行的程式碼）、能碰到什麼（執行指令、連網、攔截工具呼叫……），還有 CLI 執行前會不會先詢問。Navide 自己裝的 hook 會特別標出。這一頁只讀，不會安裝、啟用或修改任何東西；agent 也能用 cli_extensions_list 查詢名稱與中繼資料。',
        'en-US': 'New Settings → CLI Extensions lists the CLI extensions each AI CLI installed for itself — Claude plugins and mods, Codex plugins and hooks, plus Copilot, Droid, Cursor, Qwen, opencode, Kilo, Pi and more — with each one’s execution tier (text assets, a subprocess, or code running inside the CLI’s own process), what it can reach (running commands, the network, intercepting tool calls…), and whether the CLI asks before running it. Hooks Navide installed are marked. The page only reads: it never installs, enables or changes anything. Agents can query the names and metadata with cli_extensions_list.',
        'ja-JP': '「設定 → CLI 拡張」を追加しました。各 AI CLI が自分でインストールした CLI 拡張（Claude の plugin と mod、Codex の plugin と hook、さらに Copilot、Droid、Cursor、Qwen、opencode、Kilo、Pi など）を一覧にし、それぞれの実行レベル（テキスト資産、サブプロセス、CLI のプロセス内で動くコード）、触れられる範囲（コマンド実行、ネットワーク、ツール呼び出しへの介入など）、CLI が実行前に確認するかどうかを示します。Navide がインストールした hook には印が付きます。このページは読み取るだけで、インストール・有効化・変更は行いません。エージェントも cli_extensions_list で名前とメタデータを照会できます。',
      },
      {
        'zh-TW': '名稱整理：Navide 自己的外掛一律叫「Navide 外掛」，上架的地方叫「Navide 市集」，跟各家 CLI 自己的 CLI 擴充分開。設定側欄的「整合」改名為「Agent 資產」（MCP、技能、Prompt 技能、記憶），「憑證與金鑰」移到「帳號與代理」，「Navide 外掛」與「Navide 市集」移到「系統」。用舊名稱搜尋設定也找得到。',
        'en-US': 'Clearer names: Navide’s own plugins are now always “Navide plugins”, published in the “Navide Marketplace”, and kept apart from each AI CLI’s own CLI extensions. In the Settings sidebar, Integrations is now Agent Assets (MCP, skills, prompts, memory), Credentials & keys moved to Accounts & Agents, and Navide Plugins and Navide Marketplace moved to System. Searching Settings by the old names still finds them.',
        'ja-JP': '名称を整理しました。Navide 自身のプラグインは「Navide プラグイン」、公開の場は「Navide マーケットプレイス」に統一し、各 AI CLI の CLI 拡張と区別します。設定のサイドバーでは「連携」が「エージェント資産」（MCP、スキル、プロンプト、メモリ）になり、「認証情報とキー」は「アカウントとエージェント」へ、「Navide プラグイン」と「Navide マーケットプレイス」は「システム」へ移りました。旧名称で設定を検索しても見つかります。',
      },
      {
        'zh-TW': '「最近」的工作區會一直保留到你自己移除，不會再只留 20 筆、把天天在用的專案擠掉。已開啟與已釘選的排在最上面，其他每次顯示 10 筆、按「顯示更多」看下去，搜尋框會找遍全部紀錄；找不到的資料夾會標示出來但不會消失。保留上限在「設定 → 一般」調整，預設 1000 筆，也可以不設上限，已開啟與已釘選的永遠不會被移除。',
        'en-US': 'Recent now keeps every workspace until you remove it, instead of keeping 20 and pushing out the projects you use every day. Open and pinned workspaces sit on top, the rest show ten at a time with "show more", and the search box looks through the whole history; folders that are missing are marked, not dropped. Set the limit in Settings → General: 1000 by default, or none, and open or pinned workspaces are never removed.',
        'ja-JP': '「最近」のワークスペースは、自分で削除するまで残るようになりました。20 件までしか残らず、毎日使うプロジェクトが押し出されることはもうありません。開いているものとピン留めしたものが上にまとまり、残りは 10 件ずつ「さらに表示」で見られ、検索ボックスは全履歴を探します。見つからないフォルダーは印が付くだけで消えません。上限は「設定 → 一般」で変更でき、既定は 1000 件、上限なしも選べます。開いているものとピン留めしたものは削除されません。',
      },
      {
        'zh-TW': '新增「設定 → 一般 → 資源限制」，每一項在你調整前都維持原本的行為：限制新 pane 跑測試時的 worker 數、列出已關閉的 pane 留下還在跑的伺服器並一鍵停止、讓聚焦中但好幾小時沒動的 pane 也被回收（點一下就能接續）、自我優化逾時後過一段時間收掉它的 pane；macOS 上還能直接打開 Spotlight 的隱私權設定，把建置輸出排除在索引外。',
        'en-US': 'New Settings → General → Resource limits, each leaving things as they were until you change it: cap the test workers new panes use, list servers that closed panes left running and stop one with a click, let a focused pane untouched for hours be reclaimed too (one click resumes it), and reclaim a timed-out self-evolution run’s pane after a grace period. On macOS a button opens Spotlight’s privacy settings so you can keep build output out of the index.',
        'ja-JP': '「設定 → 一般 → リソース制限」を追加しました。どの項目も変更するまでは従来どおりです。新しいペインのテスト worker 数の上限、閉じたペインが残したまま動いているサーバーの一覧とワンクリック停止、フォーカス中でも何時間も操作のないペインの回収（クリックで再開）、タイムアウトした自己改善のペインを猶予後に回収。macOS では Spotlight のプライバシー設定を開くボタンから、ビルド出力をインデックスの対象外にできます。',
      },
      {
        'zh-TW': '關掉的 pane 不會再留下還在跑的 CLI 程序：結束失敗會被察覺並補清，重新接回的 pane 也找得到原本的程序，關閉 Navide 時讓 Claude 有時間正常結束，逾時的指令會連同子程序一起停止；App 關閉期間錯過的排程，補跑時不會再重複執行兩次。pane 上的聊天室標籤改顯示綁定的聊天室名稱；工作區標題上的 ✦ 徽章只顯示狀態，設定改從標題的「⋯」選單或右鍵選單打開。',
        'en-US': 'Closed panes no longer leave CLI processes running: a failed kill is noticed and cleaned up, a reattached pane’s processes are still found, quitting Navide gives Claude time to shut down cleanly, and a timed-out command stops along with its children; a schedule that missed runs while the app was closed no longer fires twice when it catches up. The chat chip on a pane now shows the bound chat’s name, and the ✦ badge on a workspace heading only shows status; open its settings from the heading’s ⋯ menu or right-click menu.',
        'ja-JP': '閉じたペインが CLI のプロセスを残さなくなりました。終了の失敗を検知して後片付けし、再接続したペインのプロセスも見つけ、Navide の終了時は Claude が正常に終了する時間を確保し、タイムアウトしたコマンドは子プロセスごと止めます。アプリを閉じている間に実行されなかったスケジュールが、後から追いつくときに 2 回実行されることもなくなりました。ペインのチャットのラベルには紐づいたチャットの名前が表示されます。ワークスペース見出しの ✦ バッジは状態の表示だけになり、設定は見出しの「⋯」メニューか右クリックメニューから開きます。',
      },
      {
        'zh-TW': '更安全：Navide 不會再覆寫讀不懂的 Claude settings.json、不會再把檔案搬進你的家目錄、不會再讓 Codex 的 config.toml 越長越大、不會把你自己的 Cursor 技能藏起來不讓 git 看到、搬移舊資料時會保留真正的對話紀錄檔，也補上 Cursor 技能清單的路徑漏洞；從 pane 裡啟動 Navide 時，也不會再把你的家目錄誤當成專案（技能與 MCP 設定都已修正）。',
        'en-US': 'Safer: Navide no longer overwrites a Claude settings.json it cannot read, no longer moves files into your home folder, stops growing Codex’s config.toml, no longer hides your own Cursor skills from git, keeps the real session file when migrating old data, and closes a path issue in the Cursor skills manifest. When Navide is started from inside a pane, it no longer mistakes your home folder for a project (fixed in skills and MCP wiring).',
        'ja-JP': 'より安全に：Navide は読み取れない Claude の settings.json を上書きしなくなり、ホームフォルダーにファイルを移動しなくなり、Codex の config.toml が増え続けることもなくなりました。自分の Cursor スキルを git から隠すこともなく、古いデータの移行時は本来のセッションファイルを残し、Cursor スキルの一覧ファイルのパスの問題も修正しました。ペインの中から Navide を起動しても、ホームフォルダーをプロジェクトと取り違えなくなりました（スキルと MCP の設定の両方を修正）。',
      },
      {
        'zh-TW': 'Navide 的程式碼庫搬到 GitHub 的 Navide-dev/Navide，更新的備援來源與「說明」選單的連結都已指向新位置，更新仍優先走下載鏡像。Plans 的圖表改用 mermaid 12，版面與配色維持原樣；Electron、fastapi、anthropic、websockets 等相依套件也一併更新。',
        'en-US': 'Navide’s repository moved to Navide-dev/Navide on GitHub; the update fallback and the Help menu’s links point there, and updates still come from the download mirror first. Plans diagrams now use mermaid 12 with the same layout and colours, and Electron, fastapi, anthropic, websockets and other dependencies are updated.',
        'ja-JP': 'Navide のリポジトリは GitHub の Navide-dev/Navide に移りました。アップデートの予備の取得先と「ヘルプ」メニューのリンクは新しい場所を指し、アップデートは引き続きダウンロードミラーを優先します。Plans の図は mermaid 12 になり、レイアウトと配色はそのままです。Electron、fastapi、anthropic、websockets などの依存関係も更新しました。',
      },
    ],
  },
  {
    version: '0.2.18',
    title: {
      'zh-TW': '雲端同步先經你核准、聊天室報告卡與 PDF、Windows 修正',
      'en-US': 'Cloud Sync You Approve, Report Cards and PDFs in Chats, and Windows Fixes',
      'ja-JP': 'クラウド同期は承認してから反映、チャットのレポートカードと PDF、Windows の修正',
    },
    highlights: [
      {
        'zh-TW': '其他裝置同步過來、會在這台電腦執行的內容——新的或有變更的 MCP server、skill、prompt——會先暫停，在「設定 → 同步」列出完整內容（指令、參數、檔案、哪些可執行、改了什麼），你核准後才寫入；大型 skill 會先下載到隔離區給你檢視。匯入設定包的預覽也會完整顯示每一項。',
        'en-US': 'What another device syncs that would run on this computer — a new or changed MCP server, skill or prompt — now waits in Settings → Sync, shown in full (command, args, files, which are executable, what changed), and lands only once you approve it. A large skill is downloaded into a holding area for you to review first. A settings-bundle import previews every item in full too.',
        'ja-JP': '別のデバイスから同期され、このコンピューターで実行される内容（新規または変更された MCP サーバー・スキル・プロンプト）は、いったん保留され、「設定 → 同期」に全内容（コマンド、引数、ファイル、実行可能なもの、変更点）が表示されます。承認してはじめて反映されます。大きなスキルは先に隔離領域へダウンロードして確認できます。設定パックの取り込みプレビューも各項目を全文表示します。',
      },
      {
        'zh-TW': '同步更安全：舊版紀錄被重送時不會把項目倒回舊版；prompt 與 MCP 參數看起來含有密鑰時會告訴你在哪裡（不顯示內容、不阻擋）；同步區會顯示正在同步的帳號，「立即同步」後列出每一類的結果，存檔後也會自動上傳。記憶（CLAUDE.md 等指示檔）不再雲端同步，本機與雲端既有的檔案都不會被動到。',
        'en-US': 'Safer sync: a replayed older record can no longer roll an item back; prompts and MCP args that look like they hold a secret are flagged with where, never what, and nothing is blocked; the Sync section names the account it syncs with, lists each scope’s result after Sync now, and sends a save up shortly after you make it. Memory (CLAUDE.md and other instruction files) is no longer synced; local files and copies already in the cloud are left as they are.',
        'ja-JP': '同期がより安全に：古い記録が再送されても項目が古い版に戻らなくなりました。プロンプトや MCP の引数に秘密情報らしきものがあると、場所だけを知らせます（内容は表示せず、ブロックもしません）。同期セクションには同期先のアカウントが表示され、「今すぐ同期」の後に種類ごとの結果が並び、保存した変更も自動でアップロードされます。メモリ（CLAUDE.md などの指示ファイル）はクラウド同期の対象外になりました。ローカルのファイルとクラウド上の既存のコピーはそのまま残ります。',
      },
      {
        'zh-TW': '新增「設定 → 憑證與金鑰」：掃描這台電腦的 git 憑證來源、gh／glab 帳號、SSH 金鑰與鑰匙圈項目，標出 remote URL 內含 token、金鑰沒有 passphrase、token 以明文存放這類風險。它不顯示任何值，也不修改任何東西；在安全的情況下會附上可複製的修正指令。agent 也能透過 MCP 查詢名稱與發現項目。',
        'en-US': 'New Settings → Credentials & keys scans this computer’s git credential sources, gh and glab accounts, SSH keys and keychain items, and flags risks such as a token inside a remote URL, a key without a passphrase, or a token kept in plain text. It never shows a value and never changes anything; where it is safe, a finding comes with a fix command you can copy. Agents can query the names and findings over MCP.',
        'ja-JP': '「設定 → 認証情報とキー」を追加しました。このコンピューターの git 認証情報の取得元、gh／glab のアカウント、SSH キー、キーチェーンの項目をスキャンし、remote URL に含まれたトークン、パスフレーズのないキー、平文で保存されたトークンといったリスクを示します。値は一切表示せず、何も変更しません。安全な場合は、コピーして使える修正コマンドを添えます。エージェントも MCP で名前と検出項目を照会できます。',
      },
      {
        'zh-TW': '聊天室：pane 傳出的 HTML 檔會轉成 A4 PDF，每個附件都附上一張報告卡（標題與一句摘要），你回覆報告卡時 pane 會知道你指的是哪份報告；很長的回覆改成一則預覽加上完整內容的 Markdown 檔。「設定 → Channels」會列出每個 bot 的聊天室與綁定的 pane，可以跳過去、多選解除綁定、清掉 pane 已不存在的綁定。',
        'en-US': 'Chats: an HTML file a pane sends arrives as an A4 PDF, every attachment comes with a report card (a title and a one-line summary), and replying to a card tells the pane which report you mean. A very long reply arrives as one preview plus the whole text as a Markdown file. Settings → Channels lists each bot’s chats and bound panes, so you can jump to a pane, unbind several at once, and clear bindings whose pane is gone.',
        'ja-JP': 'チャット：ペインが送る HTML ファイルは A4 の PDF になり、すべての添付にレポートカード（タイトルと一行の要約）が付きます。カードに返信すると、どのレポートの話かがペインに伝わります。長い返信は 1 件のプレビューと全文の Markdown ファイルで届きます。「設定 → Channels」では bot ごとにチャットと紐づいたペインが一覧でき、ペインへの移動、まとめての紐づけ解除、ペインがなくなった紐づけの削除ができます。',
      },
      {
        'zh-TW': 'pane 現在可以把工作區外的檔案、隱藏檔，以及你拖進 Navide 的檔案傳回聊天室；但 ~/.ssh、~/.aws、GitHub CLI、GnuPG、Kubernetes、Docker、鑰匙圈、各 CLI 的登入檔與 Navide 自己的資料，在每個平台上都一律不傳。',
        'en-US': 'A pane can now send files from outside its workspace, hidden files, and files you dragged into Navide; ~/.ssh, ~/.aws, the GitHub CLI, GnuPG, Kubernetes, Docker, keyrings, the CLIs’ sign-in files and Navide’s own data are still never sent, on every platform.',
        'ja-JP': 'ペインはワークスペース外のファイル、隠しファイル、Navide にドラッグしたファイルもチャットへ送れるようになりました。ただし ~/.ssh、~/.aws、GitHub CLI、GnuPG、Kubernetes、Docker、キーリング、各 CLI のログインファイル、Navide 自身のデータは、どのプラットフォームでも送りません。',
      },
      {
        'zh-TW': '給 agent：開啟工作區會等新視窗準備好再回報，視窗還沒好時開 pane 會立刻告知而不是卡住，「~/」路徑也會展開；新增 cli_reclaim_agent 收掉已完成的 pane。排程執行的自我優化不會再停下來問問題，閒置太久會被提醒並一定回報。開 pane 時的記憶體提醒只計算真的在執行的 pane。pane 一輪結束後，cli_get_status 會正確回報已完成，不會再停在進行中；排隊的訊息也不會因此多等最多 2 分鐘。',
        'en-US': 'For agents: opening a workspace waits until its window is ready, opening a pane before then says so at once instead of hanging, and a "~/" path is expanded; cli_reclaim_agent releases a finished pane. Scheduled self-evolution runs no longer stop to ask a question, are nudged when idle too long and always report back. The memory advisory when opening a pane counts only panes that are actually running. Once a pane finishes a turn, cli_get_status now reports it as finished instead of leaving it in progress, and queued messages no longer wait up to 2 minutes extra because of it.',
        'ja-JP': 'エージェント向け：ワークスペースを開くとウィンドウの準備ができるまで待ってから応答し、準備前にペインを開こうとするとすぐにそう伝えて止まらなくなりました。「~/」のパスも展開されます。完了したペインを片付ける cli_reclaim_agent を追加しました。スケジュール実行の自己改善は質問で止まらなくなり、長く停止すると促され、必ず報告します。ペインを開くときのメモリの注意は、実際に動いているペインだけを数えます。ペインのターンが終わると cli_get_status は正しく完了と報告し、実行中のままにならなくなりました。そのせいでキュー内のメッセージが最大 2 分余計に待つこともなくなりました。',
      },
      {
        'zh-TW': '被「…」截斷的文字，滑鼠移上去就能看到完整內容。Windows：同步來的 skill 不能再透過磁碟機路徑、替代資料流或裝置名稱把檔案寫到 skill 以外的地方，「~」開頭的工作區路徑也能正確對應。',
        'en-US': 'Text cut off with "…" shows in full on hover. Windows: a synced skill can no longer place files outside itself through drive paths, alternate data streams or device names, and a workspace path starting with "~" now matches the same folder.',
        'ja-JP': '「…」で切れた文字は、マウスを重ねると全文が表示されます。Windows：同期されたスキルが、ドライブパス・代替データストリーム・デバイス名を使ってスキル外にファイルを書き込めなくなりました。「~」で始まるワークスペースのパスも正しく同じフォルダーを指します。',
      },
    ],
  },
  {
    version: '0.2.17',
    title: {
      'zh-TW': '修正後端自行停止、畫面卡在「connecting…」',
      'en-US': 'Fixes for a Backend That Stopped Itself and a Window Stuck on "connecting…"',
      'ja-JP': 'バックエンドが自ら停止し、画面が「connecting…」のまま止まる問題を修正',
    },
    highlights: [
      {
        'zh-TW': '電腦很忙、pane 很多時，後端偶爾會誤以為 Navide 已經關閉而自行停止，畫面就一直停在「connecting…」。現在查不到 Navide 時只會略過這一次檢查，不會再自行停止。',
        'en-US': 'With a busy machine and many panes, the backend could mistake a momentary lookup failure for Navide having quit and stop itself, leaving the window on "connecting…". A failed lookup is now skipped, never taken as Navide being gone.',
        'ja-JP': 'マシンが混雑しペインが多いとき、バックエンドが一時的な確認の失敗を Navide の終了と取り違えて自ら停止し、画面が「connecting…」のままになることがありました。確認に失敗しても今回は見送るだけになり、停止しなくなりました。',
      },
      {
        'zh-TW': '後端關閉時最多等 3 秒，不會再被 pane 掛著的連線卡住；視窗連續重連 3 次失敗後，會向 Navide 確認後端是否換了位置並改連過去。',
        'en-US': 'The backend now waits at most 3 seconds to shut down, so connections held open by panes can no longer keep it hanging, and after 3 failed reconnects the window asks Navide where the backend is now and follows it.',
        'ja-JP': 'バックエンドの終了待ちは最大 3 秒になり、ペインが保持する接続で止まらなくなりました。再接続に 3 回失敗すると、ウィンドウが Navide にバックエンドの現在の場所を確認して接続し直します。',
      },
      {
        'zh-TW': '後端的啟動、當掉、自動重啟都會寫進 main.log，方便追查；側欄工作區標題上的自我優化徽章縮小成只顯示 ✦，狀態用顏色區分，滑鼠移上去看說明。',
        'en-US': 'Backend start, crash and automatic restarts are now written to main.log for troubleshooting, and the self-evolution badge on a sidebar workspace heading is just ✦, coloured by state, with the details on hover.',
        'ja-JP': 'バックエンドの起動・クラッシュ・自動再起動が main.log に記録されるようになりました。サイドバーのワークスペース見出しにある自己進化バッジは ✦ だけになり、状態は色で示し、詳細はマウスを重ねると表示されます。',
      },
    ],
  },
  {
    version: '0.2.16',
    title: {
      'zh-TW': 'Pipeline 畫布編輯器、在聊天室收發檔案、重開後自動接回工作中的 pane',
      'en-US': 'A Pipeline Canvas Editor, Files in Chats, and Panes That Pick Up Where They Left Off',
      'ja-JP': 'Pipeline キャンバスエディター、チャットでのファイル送受信、再起動後に作業中のペインを自動で再開',
    },
    highlights: [
      {
        'zh-TW': 'Pipeline Manager 改成整個視窗的工作區，每條 pipeline 都能用泳道或自由畫布編輯：把角色拖進同一欄並行、拖到新欄接續，加入核准關卡、設定退回重做的迴圈與次數上限，釘住某一步沿用上次的產出，或從任一步重跑。執行中每個檢視都會顯示進度，有關卡在等你核准時會提示，按「前往核准」直接過去。角色分頁也能編輯這個角色在步驟裡顯示的設定欄位。',
        'en-US': 'The Pipeline Manager is now a full-window workspace where every pipeline can be edited as swimlanes or on a free canvas: drag roles into a column to run them side by side or into a new one to follow on, add approval gates, set a reject loop and how many times it may retry, pin a step to reuse its last output, or rerun from any step. A running pipeline shows its progress in every view, and a gate waiting on you is flagged with a direct Review. The Roles tab can now edit the settings fields a role shows in a step.',
        'ja-JP': 'Pipeline Manager がウィンドウ全体のワークスペースになり、各パイプラインをスイムレーンまたは自由なキャンバスで編集できます。ロールを同じ列にドラッグすると並列に、新しい列にドラッグすると順番に実行され、承認ゲートの追加、差し戻しループと再試行回数の設定、ステップを固定して前回の出力を再利用、任意のステップからの再実行ができます。実行中はどの表示でも進捗が見え、承認待ちのゲートがあると知らせて「確認する」で直接移動できます。ロールタブでは、ステップに表示される設定項目も編集できます。',
      },
      {
        'zh-TW': '聊天室可以傳檔案了：在 Telegram、Discord、Slack 傳給 pane 的檔案與圖片會先下載，pane 會知道檔案放在哪裡；pane 回覆時也能把檔案傳回聊天室，但只限工作區內或剛收到的檔案，不會送出隱藏檔與金鑰。單檔上限 20 MB；其他平台會回覆「此平台尚不支援媒體」，文字照常送達。在 Telegram、Discord 用「回覆」某則訊息時，pane 也會看到被回覆的原文（只引用你信任的發言者）。',
        'en-US': 'Chats can carry files: files and pictures sent to a pane from Telegram, Discord or Slack are downloaded first and the pane is told where they are, and a pane can send files back in its reply, limited to its workspace or the files it just received, never hidden files or keys. Each file can be up to 20 MB; other platforms reply that media is not supported yet and still deliver the text. Replying to a message in Telegram or Discord now shows the pane the message you replied to, quoted only from senders you trust.',
        'ja-JP': 'チャットでファイルを送受信できるようになりました。Telegram・Discord・Slack からペインに送ったファイルや画像は先にダウンロードされ、保存場所がペインに伝わります。ペインも返信でファイルを送り返せますが、ワークスペース内のファイルか受け取ったファイルに限られ、隠しファイルや鍵は送りません。1 ファイル 20 MB まで。その他のプラットフォームでは「このプラットフォームはまだメディアに対応していません」と返し、テキストは通常どおり届きます。Telegram と Discord で特定のメッセージに「返信」すると、返信元の原文もペインに届きます（信頼する送信者のみ引用）。',
      },
      {
        'zh-TW': '重開 Navide 後，原本正在跑回合、或停在權限詢問與提問上的 pane，以及等它們回報的母 pane，會自動接回（最多 6 個）。接回後不會自己繼續，要按「繼續」或由母 pane 下令；母 pane 會收到哪些子 pane 被中斷的通知。沒接回的會標示「重開時工作中」，點一下就能接回。不想要可以在「設定 → 一般」關閉。',
        'en-US': 'After Navide restarts, panes that were running a turn or waiting on a permission prompt or a question, plus the parent panes waiting on their reports, come back by themselves (up to 6). None of them continues on its own: press Continue or let the parent say so, and each parent is told which of its panes were interrupted. Panes left closed are marked "Working at restart" and resume with a click. Turn this off in Settings → General.',
        'ja-JP': 'Navide を再起動すると、ターンの実行中や権限の確認・質問で待っていたペインと、その報告を待つ親ペインが自動で戻ります（最大 6 個）。戻ったペインが勝手に続きを始めることはなく、「続行」を押すか親ペインの指示で再開します。親ペインには、どの子ペインが中断されたかが通知されます。戻らなかったペインには「再起動時に作業中」と表示され、クリックで再開できます。「設定 → 一般」でオフにできます。',
      },
      {
        'zh-TW': 'Claude 帳號可以各自在自己的設定資料夾登入一次，不同 pane 就能同時用不同帳號：從額度徽章選新 pane 要用的帳號，或按「繼續」把單一個 pane 換到另一個帳號接著對話，其他 pane 不受影響；這些帳號的額度也能各自讀取。登入過期時新 pane 會改用目前的帳號並提示重新登入；刪除帳號會一併清掉它的登入，還有 pane 在用時會先擋下並告訴你幾個。',
        'en-US': 'Each Claude account can sign in once inside its own settings folder, so different panes can run on different accounts at the same time: pick the account new panes start on from the quota badge, or press Continue to move one pane onto another account and carry on its conversation, leaving the rest alone. These accounts each get their own quota reading. When such a login expires, new panes fall back to the current account and you are offered to sign in again; deleting an account removes its login too, and is held back, with a count, while panes still use it.',
        'ja-JP': 'Claude アカウントごとに専用の設定フォルダーで一度ログインしておくと、ペインごとに別のアカウントを同時に使えます。クォータバッジで新しいペインが使うアカウントを選ぶか、「続行」で 1 つのペインだけを別のアカウントに移して会話を続けられ、ほかのペインには影響しません。これらのアカウントはそれぞれのクォータも読み取れます。ログインが期限切れになると新しいペインは現在のアカウントに戻り、再ログインを案内します。アカウントを削除するとそのログインも消え、まだ使っているペインがある間は件数を示して削除を止めます。',
      },
      {
        'zh-TW': '新增工作區「自我優化」（預設關閉）：從側欄工作區標題的徽章開啟面板並啟用後，Navide 每天依你設定的時間開一個 pane 檢查這個 repo，在獨立的 worktree 修正小錯誤、逐一 commit 回本機主分支（不會 push），新功能與取捨則寫成提案；每天次數、時間與 token 預算都有上限，每一步都會通知你。',
        'en-US': 'New per-workspace Self-evolution, off by default: open its panel from the badge on the workspace heading in the sidebar and turn it on, and at the time you choose each day Navide opens a pane that checks the repository, fixes small bugs in a separate worktree and commits each fix to the local main branch (never pushing), and writes new features and trade-offs up as proposals instead. Runs per day, time and token budget are all capped, and you are told about every step.',
        'ja-JP': 'ワークスペースごとの「自己改善」を追加しました（既定はオフ）。サイドバーのワークスペース見出しのバッジからパネルを開いて有効にすると、毎日指定した時刻に Navide がペインを開いてリポジトリを確認し、小さなバグを別の worktree で修正して 1 件ずつローカルのメインブランチにコミットします（push はしません）。新機能や判断が必要なものは提案として残します。1 日の回数・時間・トークン予算には上限があり、各ステップは通知されます。',
      },
      {
        'zh-TW': '給 agent 的新能力：agent 可以替其他 pane 回答權限詢問與選單（高風險的仍由 Navide Guard 擋下，每次回答都會記錄）、在工作完成後收掉子 pane，從 agent 開啟工作區也不再逾時。',
        'en-US': 'For agents: an agent can now answer another pane’s permission prompt or menu (Navide Guard still blocks high-risk ones, and every answer is recorded), release its finished child panes, and opening a workspace from an agent no longer times out.',
        'ja-JP': 'エージェント向け：エージェントがほかのペインの権限確認やメニューに回答できるようになりました（高リスクのものは引き続き Navide Guard がブロックし、回答はすべて記録されます）。作業が終わった子ペインの片付けもでき、エージェントからワークスペースを開いてもタイムアウトしなくなりました。',
      },
      {
        'zh-TW': '其他：主視窗畫面意外掛掉時會自動重新載入並接回 pane，不再留下一片空白、pane 最後被清掉；分頁標籤顯示「執行中／總數」；重開不再把其他工作區的分頁群組塞進目前的工作區；「設定 → Prompt 技能」可以拖曳排序 skill；送到另一台裝置的訊息一定會回報結果，不再一直停在排隊中；Windows 上不再重建已經正確的共用連結。',
        'en-US': 'Also: a main window whose page crashes reloads itself and reconnects its panes, instead of staying blank until the panes are cleared; stage tabs show running / total panes; a restart no longer files other workspaces’ tab groups into the one on screen; skills can be dragged into order in Settings → Prompts; a message sent to another device always reports how it ended instead of sitting on queued; and Windows no longer rebuilds shared links that are already correct.',
        'ja-JP': 'そのほか：メインウィンドウの画面が予期せず落ちても自動で再読み込みしてペインに再接続し、真っ白なままペインが消えることはなくなりました。タブに「実行中 / 合計」のペイン数を表示します。再起動時にほかのワークスペースのタブグループが表示中のワークスペースに入り込まなくなりました。「設定 → プロンプト」でスキルをドラッグして並べ替えられます。別のデバイスに送ったメッセージは必ず結果が返り、「待機中」のまま止まらなくなりました。Windows で正しく張られている共有リンクを作り直さなくなりました。',
      },
    ],
  },
  {
    version: '0.2.15',
    title: {
      'zh-TW': '首次使用導覽、一鍵建立 Telegram bot、內嵌 AI 面板成為正式 pane',
      'en-US': 'A First-Run Tour, One-Step Telegram Bots, and Embedded AI Panels That Act Like Panes',
      'ja-JP': 'はじめてのツアー、Telegram ボットのワンステップ作成、内蔵 AI パネルがペインと同じように',
    },
    highlights: [
      {
        'zh-TW': '首次安裝後，導覽會用一個小提示框指著真正的按鈕，一次只請你做一件事：在 Welcome 挑工作區資料夾、按 + 開出第一個 Agent、在 pane 裡下第一個指令。導覽期間其他地方會蓋上灰色遮罩，誤點不會中斷導覽；提示框會一直留著，等你做完，或按「下一個」跳過這一步。',
        'en-US': 'After a fresh install, a small bubble points at the real control and asks for one thing at a time: pick a workspace folder on Welcome, press + to open your first agent, and give it a first instruction in its pane. A grey mask covers the rest of the window so a stray click cannot end the tour, and each bubble stays until you have done its step or press Next to skip it.',
        'ja-JP': '初回インストール後、小さな吹き出しが実際のボタンを指し、一度に 1 つだけ操作をお願いします。Welcome でワークスペースのフォルダーを選び、+ で最初のエージェントを開き、ペインで最初の指示を出します。ツアー中はほかの部分がグレーのマスクで覆われ、誤ってクリックしてもツアーは終わりません。吹き出しは、その手順を終えるか「次へ」でスキップするまで表示されたままです。',
      },
      {
        'zh-TW': '接著陪你試一次讓 agent 互相合作：打 @ 選另一個 pane 叫它做事，或把一個 pane 拖進另一個帶入對話脈絡。最後一步一定會出現：把滑鼠停在額度徽章上看帳號與剩餘額度，需要時直接切換帳號；徽章還沒出現時，提示框會指著它之後出現的位置，按「完成」才結束。',
        'en-US': 'Then it has you try agents working together: type @ to pick another pane and hand it a task, or drag one pane into another to bring its conversation along. The last step always comes: rest the pointer on the quota badge to see the account and what is left, with a switch right there. Before the badge appears, the bubble points at where it will show, and the tour ends only when you press Done.',
        'ja-JP': '続いて、エージェント同士の連携を試します。@ でほかのペインを選んで作業を頼むか、ペインを別のペインにドラッグして会話の文脈を渡します。最後の手順は必ず表示されます。クォータバッジにマウスを重ねるとアカウントと残量が表示され、その場で切り替えられます。バッジがまだ表示されていないときは、表示される位置を吹き出しが指し、「完了」を押すまでツアーは終わりません。',
      },
      {
        'zh-TW': '「設定 → Channels」新增 bot 一步完成：驗證憑證、啟動、開啟綁定引導，憑證被平台接受才會保留。已開啟 Bot Management Mode 的 Telegram bot 還能直接「建立新 bot」，在 Telegram 按下建立後 Navide 自動加入。',
        'en-US': 'Adding a bot in Settings → Channels now checks its credential, starts it and opens its link guide in one go, keeping it only once the platform accepts it. A Telegram bot with Bot Management Mode on can also "Create a new bot": confirm it in Telegram and Navide adds it for you.',
        'ja-JP': '「設定 → Channels」でのボット追加が一度で完了します。認証情報を確認して起動し、リンクガイドを開き、プラットフォームが受け入れた場合のみ保存します。Bot Management Mode を有効にした Telegram ボットからは「新しいボットを作成」もでき、Telegram で作成すると Navide が自動で追加します。',
      },
      {
        'zh-TW': 'Pipeline Manager、Plan、Git、Editor 視窗裡的 AI 面板會記錄歷史、可以收其他 pane 的訊息，並標示自己在哪個視窗；關閉視窗會一併結束面板，重開 Navide 後會接續原本的對話。',
        'en-US': 'The AI panel in the Pipeline Manager, Plan, Git and Editor windows keeps its history, can receive messages from other panes, and shows which window it lives in. Closing the window ends its panel, and it picks up its session again after Navide restarts.',
        'ja-JP': 'Pipeline Manager・Plan・Git・Editor ウィンドウの AI パネルが履歴を記録し、他のペインからメッセージを受け取れ、どのウィンドウにあるかを表示します。ウィンドウを閉じるとパネルも終了し、Navide を再起動すると元のセッションを再開します。',
      },
      {
        'zh-TW': 'Plans 直接讀寫計畫檔，大型計畫庫載入更快；每次存取仍由 Navide 授權，Execution Policy 照常生效。「設定 → 擴充套件」會列出 Plans，並揭露每個擴充套件宣告會讀寫的檔案範圍。',
        'en-US': 'Plans reads and writes plan files directly, so large libraries load faster, while Navide still authorizes every access and Execution Policy keeps applying. Settings → Extensions now lists Plans and shows the files each extension declares it reads and writes.',
        'ja-JP': 'Plans が計画ファイルを直接読み書きするようになり、大きなライブラリの読み込みが速くなりました。各アクセスは引き続き Navide が承認し、Execution Policy も適用されます。「設定 → 拡張機能」に Plans が表示され、各拡張機能が読み書きを宣言したファイル範囲も確認できます。',
      },
      {
        'zh-TW': '聊天室：在已綁定的 Telegram、Discord、Slack 聊天室輸入 /menu，就能用按鈕把這個 pane 的提示詞與 skill 送給它；斷線 5 秒就重連（原本 30 秒）；確認按鈕在電腦上回答、被新提問取代、回合結束或逾時後會標示原因並收起，不會再按出「這個確認已失效」。',
        'en-US': 'Chats: type /menu in a bound Telegram, Discord or Slack chat to send the pane one of its prompts or skills with a button. A dropped connection retries after 5 s instead of 30 s, and a confirmation answered at the computer, replaced by a newer one, outlived by its turn or timed out says why and drops its buttons, instead of answering "this confirmation has expired".',
        'ja-JP': 'チャット：バインド済みの Telegram・Discord・Slack のチャットで /menu と入力すると、そのペインのプロンプトやスキルをボタンで送れます。切断後 5 秒で再接続します（以前は 30 秒）。コンピューターで回答された、新しい確認に置き換えられた、ターンが終わった、または期限切れになった確認は理由を表示してボタンを外し、「この確認は無効です」と返すことはなくなりました。',
      },
      {
        'zh-TW': '其他：排程會跟著重建的 pane 走，目標一直不在會自動停用並通知你；某個工作區的 Plans 後端停止時會跳出通知並說明怎麼恢復；結束 Navide 時若被取消，後端與插件會自動回復；結束 Navide 時關閉終端機不再卡住、CPU 飆到 100%；CLI 自行結束時，它啟動的子行程（例如 MCP server）會一併清掉；Windows 傳給 Claude pane 的中文與多行訊息不再亂碼（#147）；Git 狀態讀取失敗或被截斷時不再假裝乾淨（#144）；修補多個相依套件的安全性弱點。',
        'en-US': 'Also: schedules follow a rebuilt pane and turn off with a notice when their target stays gone; you are told when a workspace’s Plans backend stops, and how to bring it back; a quit that gets cancelled brings the backend and extensions back; quitting no longer hangs at 100% CPU while closing terminals; a CLI that exits on its own no longer leaves its child processes, such as MCP servers, running; on Windows, Chinese and multi-line messages reach Claude panes intact (#147); Git no longer shows a failed or truncated status as clean (#144); and several dependency security advisories are patched.',
        'ja-JP': 'そのほか：スケジュールは再構築されたペインに追従し、対象が見つからない状態が続くと通知して停止します。ワークスペースの Plans バックエンドが停止すると、通知で復旧方法をお知らせします。終了がキャンセルされた場合は、バックエンドと拡張機能が自動で元に戻ります。終了時にターミナルを閉じる処理で止まって CPU が 100% になることはなくなりました。CLI が自分で終了したとき、起動した子プロセス（MCP サーバーなど）も片付けられます。Windows で Claude ペインに送る中国語や複数行のメッセージが文字化けしなくなり（#147）、Git の状態読み取りが失敗または打ち切られてもクリーンと表示しなくなりました（#144）。依存パッケージのセキュリティ勧告にも対応しました。',
      },
    ],
    note: {
      'zh-TW': '已經用過 Navide 的人不會自動看到導覽，只有全新安裝才會出現；隨時可以按「略過導覽」整段結束。想再看一次（Welcome 畫面也可以）：輔助說明 → 首次使用導覽…',
      'en-US': 'Existing installs never get the tour on their own — only a fresh install does — and Skip tour ends it at any point. To see it again, even from Welcome: Help → First-Run Tour…',
      'ja-JP': 'すでに Navide を使っている環境では自動で表示されず、新規インストール時のみ表示されます。「ツアーをスキップ」でいつでも終了できます。もう一度見るには（Welcome 画面からも可）：ヘルプ → はじめてのツアー…',
    },
  },
  {
    version: '0.2.14',
    title: {
      'zh-TW': '擴充套件自帶後端（沙盒）、更安全的 Windows Guard、綁定前先確認',
      'en-US': 'Sandboxed Extension Backends, a Safer Guard on Windows, and Binding That Asks First',
      'ja-JP': 'サンドボックス化された拡張機能バックエンド、Windows の Guard 強化、バインド前の確認',
    },
    highlights: [
      {
        'zh-TW': '擴充套件可以自帶後端程式，預設關閉。要在「設定 → 擴充套件」開啟並同意該版本後才會執行，且在沒有網路、只能寫自己資料夾的沙盒中運作；檔案一變動就會重新詢問。',
        'en-US': 'Extensions can ship their own backend, off by default. It runs only after you enable it in Settings → Extensions and approve that version, inside a sandbox with no network that can write only its own folder; any changed file asks again.',
        'ja-JP': '拡張機能が独自のバックエンドを同梱できるようになりました（既定ではオフ）。「設定 → 拡張機能」で有効にし、そのバージョンを承認した場合のみ、ネットワークなし・自分のフォルダーにのみ書き込めるサンドボックス内で実行されます。ファイルが変わると再度確認します。',
      },
      {
        'zh-TW': 'Windows 上的 Navide Guard 不再經過 PowerShell 啟動，被拒絕的指令不會因為逾時而被放行。',
        'en-US': 'Navide Guard on Windows no longer starts PowerShell, so a denied command can no longer slip through on a slow start.',
        'ja-JP': 'Windows の Navide Guard は PowerShell を起動しなくなり、起動が遅くても拒否したコマンドが実行されることはなくなりました。',
      },
      {
        'zh-TW': '綁定聊天室時先選聊天室，再確認要送出的內容並按「連線」；目前的選擇會清楚標示。',
        'en-US': 'Binding a chat now asks first: pick the chat, confirm what it receives, then Connect. The current choice is clearly marked.',
        'ja-JP': 'チャットのバインド時は、チャットを選んでから送信内容を確認し「接続」を押します。現在の選択がはっきり表示されます。',
      },
      {
        'zh-TW': '同一個平台可以設定多個 bot：每個 bot 有自己的白名單與配對，綁定時依 bot 分組選擇聊天室；原本的 bot 自動成為主要 bot，不用重新登入。在聊天室回答 CLI 的提問也不再卡住：答錯可以再答、下一題會接著推，直接回「1」或「yes」也算數。',
        'en-US': 'Run several bots on one platform: each bot has its own allowlist and pairing, and the bind menu groups chats by bot. Your existing bot becomes the main bot without signing in again. Answering CLI questions from a chat no longer gets stuck: a wrong answer can be retried, the next question follows, and a bare "1" or "yes" counts.',
        'ja-JP': '1 つのプラットフォームで複数のボットを使えるようになりました。ボットごとに許可リストとペアリングを持ち、バインド時はボットごとにチャットを選べます。既存のボットはメインボットとして引き継がれ、再ログインは不要です。チャットから CLI の質問に答えても止まらなくなりました。間違えても答え直せ、次の質問も続けて届き、「1」や「yes」だけでも回答になります。',
      },
      {
        'zh-TW': '其他：Marketplace 評分與檢舉、Windows 存檔與大量檔案變動不再卡住、超大專案的 Git 狀態不再卡住、Keychain 讀取更正確、中文使用者資料夾的 Windows hook 恢復正常。',
        'en-US': 'Also: Marketplace ratings and reports, no more stalls on Windows saves or file bursts, Git status no longer stalls in huge projects, Keychain reads are exact, and Windows hooks work under a non-ASCII user folder.',
        'ja-JP': 'そのほか：マーケットプレイスの評価と報告、Windows の保存や大量のファイル変更で止まらなくなりました。巨大なプロジェクトでも Git の状態表示が止まらず、キーチェーンの読み取りも正確になり、ASCII 以外の文字を含むユーザーフォルダーでも Windows のフックが動作します。',
      },
    ],
  },
  {
    version: '0.2.13',
    title: {
      'zh-TW': '擴充套件市集、Channels 雙向同步與連線監控、大型 Plan',
      'en-US': 'An Extension Marketplace, Two-Way Channels with a Monitor, and Large Plans',
      'ja-JP': '拡張機能マーケットプレイス、Channels の双方向同期と接続モニター、大きな Plan',
    },
    highlights: [
      {
        'zh-TW': '擴充套件市集上線：可以瀏覽、安裝第三方擴充套件與擴充套件包，也能為個別擴充套件開啟預覽版。開發者可以自行登入、驗證網域並發布，上架前會經過審核與密鑰掃描。navide:// 連結會在 App 內開啟擴充套件頁面，安裝一定要你確認。',
        'en-US': 'The extension Marketplace is here: browse and install third-party extensions and extension packs, and opt into pre-releases per extension. Publishers sign in, verify their domain and publish themselves, and every release is reviewed and scanned for secrets before it is listed. navide:// links open an extension\'s page in the app, and installing always asks you first.',
        'ja-JP': '拡張機能マーケットプレイスを公開しました。サードパーティの拡張機能や拡張機能パックを閲覧・インストールでき、拡張機能ごとにプレリリースも選べます。公開者は自分でサインインし、ドメインを検証して公開でき、掲載前に審査とシークレットスキャンが行われます。navide:// リンクはアプリ内で拡張機能のページを開き、インストールには必ず確認が必要です。',
      },
      {
        'zh-TW': '標題列新增 Channels 連線監控：一眼看到哪些 pane 綁定了聊天室，可以直接跳過去或中斷連線。',
        'en-US': 'A Channels monitor in the titlebar shows which panes are bound to a chat, and lets you jump to one or disconnect it.',
        'ja-JP': 'タイトルバーに Channels の接続モニターを追加しました。どのペインがチャットにバインドされているかを確認し、ペインへの移動や切断ができます。',
      },
      {
        'zh-TW': 'Channels 可以把綁定 pane 的活動同步到聊天室，聊天室的回覆也會回到 pane。綁定時先選擇聊天室會收到什麼，預設「只回覆聊天室」，本機輸入不會送出；之後可隨時在 pane 的連接選單更改。',
        'en-US': 'Channels can mirror a bound pane\'s activity to its chat and bring replies back. When you bind, you choose what the chat receives; the default, “Chat replies only”, sends nothing typed locally. You can change it any time from the pane\'s channel menu.',
        'ja-JP': 'Channels でバインドしたペインのアクティビティをチャットに同期し、返信をペインに戻せます。バインド時にチャットが受け取る内容を選べ、既定の「チャットへの返信のみ」ではローカル入力は送信されません。ペインのチャンネルメニューからいつでも変更できます。',
      },
      {
        'zh-TW': 'Plans 可以開啟並儲存任何大小的文件，包含大量中文的 plan。',
        'en-US': 'Plans opens and saves documents of any size, including plans with a lot of CJK text.',
        'ja-JP': 'Plans で任意のサイズのドキュメントを開いて保存できます。CJK 文字の多い plan も含みます。',
      },
      {
        'zh-TW': '語音輸入在連線與模型下載完成時先暖機，第一次說話就有即時字幕；設定頁分開顯示模型與引擎狀態。',
        'en-US': 'Voice input warms up on connect and after the model downloads, so the first take shows live text; Settings shows the model and the engine as separate rows.',
        'ja-JP': '音声入力は接続時とモデルのダウンロード後に準備されるため、最初の発話からリアルタイムに文字が表示されます。設定ではモデルとエンジンの状態を分けて表示します。',
      },
      {
        'zh-TW': '修正：Git 遠端操作不再提早逾時或在輸入密碼時關閉視窗；終端機與 mini-IDE 開檔失敗會提示；pane 內 Ctrl+C 恢復作用；Windows 上關閉 App 後後端會立即結束。',
        'en-US': 'Fixes: Git remote operations no longer time out early or close the password prompt; opening a file from the terminal or the mini-IDE says so when it fails; Ctrl+C works in panes again; on Windows the backend exits promptly when the app closes.',
        'ja-JP': '修正：Git のリモート操作が早すぎるタイムアウトやパスワード入力中のダイアログ終了を起こさなくなりました。ターミナルと mini-IDE でのファイルオープン失敗が通知されます。ペイン内の Ctrl+C が再び機能します。Windows でアプリ終了時にバックエンドがすぐ終了します。',
      },
    ],
  },
  {
    version: '0.2.12',
    title: {
      'zh-TW': 'Channels 一鍵連結、側欄 Free 模式、擴充套件可回滾',
      'en-US': 'One-Click Channel Linking, a Free Sidebar Mode and Extension Rollback',
      'ja-JP': 'Channels のワンクリック連携、サイドバーの Free モード、拡張機能のロールバック',
    },
    highlights: [
      {
        'zh-TW': 'Channels 連上 bot 之後，按一下就能連結你自己的聊天帳號：Telegram 私訊、加進群組或伺服器、Slack 私訊，或取得一次性代碼傳給 bot，不必再核准配對碼。代碼過期或連結失敗時，畫面會直接說明並讓你重新取得。',
        'en-US': 'Once a Channels bot is connected, link your own chat account in one click — a Telegram DM, adding the bot to a group or server, a Slack DM, or a one-time code sent to the bot — with no pairing code to approve. If the code expires or the link fails, the guide says so and lets you get a new one.',
        'ja-JP': 'Channels でボットを接続したら、ワンクリックで自分のチャットアカウントを連携できます。Telegram の DM、グループやサーバーへの追加、Slack の DM、またはボットに送るワンタイムコードに対応し、ペアリングコードの承認は不要です。コードの期限切れや連携失敗時は画面に理由が表示され、新しいコードを取得できます。',
      },
      {
        'zh-TW': '側欄新增 Workspace／Free 兩種模式：Workspace 照工作區分組，Free 把所有 agent 列成一張清單，每個 agent 自成一張線框卡片並標出所屬工作區，主區顯示全部 pane。選擇會記住，已開的視窗也會即時跟著切換。',
        'en-US': 'The sidebar has two modes: Workspace groups agents by workspace, and Free lists every agent in one flat list — each in its own outlined card, labelled with its workspace — with every pane on the stage. The choice is remembered, and windows that are already open follow it live.',
        'ja-JP': 'サイドバーに Workspace／Free の 2 つのモードを追加しました。Workspace はワークスペースごとにグループ化し、Free はすべてのエージェントを 1 つのリストにまとめ、各エージェントを所属ワークスペース付きの枠線カードで表示し、すべてのペインを表示します。選択は保存され、開いている他のウィンドウにもすぐ反映されます。',
      },
      {
        'zh-TW': '「設定 → 擴充套件」可以把已安裝的擴充套件回滾到它取代的版本，失敗時會說明原因並還原畫面。',
        'en-US': 'Settings → Extensions can roll an installed extension back to the package it replaced; a failed rollback explains why and restores the view.',
        'ja-JP': '「設定 → 拡張機能」で、インストールした拡張機能を置き換え前のパッケージにロールバックできます。失敗した場合は理由が表示され、表示も元に戻ります。',
      },
      {
        'zh-TW': 'Pipeline 執行時最多只保留兩個階段的 CLI，減少記憶體占用；更新視窗的版本說明改為可讀的文字；Windows 上關閉 pane 更快。',
        'en-US': 'A pipeline run keeps at most two stages of CLIs alive, using less memory; the updater shows release notes as readable text; and closing a pane is faster on Windows.',
        'ja-JP': 'パイプライン実行中に保持する CLI は最大 2 ステージ分になり、メモリ使用量が減りました。アップデーターのリリースノートは読みやすいテキストで表示され、Windows ではペインを閉じる処理が速くなりました。',
      },
    ],
  },
  {
    version: '0.2.11',
    title: {
      'zh-TW': 'Channels 在安裝版可以正常使用',
      'en-US': 'Channels Works in the Installed App',
      'ja-JP': 'インストール版で Channels が使えるようになりました',
    },
    highlights: [
      {
        'zh-TW': '0.2.10 的安裝版漏掉了所有聊天平台的連接元件，設定任何聊天都會失敗；現在已補齊。',
        'en-US': 'The 0.2.10 installed app left out every chat platform’s adapter, so setting up any chat failed; they are now included.',
        'ja-JP': '0.2.10 のインストール版ではすべてのチャットプラットフォームのアダプターが欠けていたため、チャットの設定が失敗していました。現在は含まれています。',
      },
    ],
  },
  {
    version: '0.2.10',
    major: true,
    tour: [
      {
        id: 'welcome',
        prepare: { kind: 'close-settings' },
        titleKey: 'tour.v0_2_10.welcome.title',
        bodyKey: 'tour.v0_2_10.welcome.body',
      },
      {
        id: 'channels-settings',
        prepare: { kind: 'settings', tab: 'channels' },
        anchor: '[data-settings-section="channels"]',
        titleKey: 'tour.v0_2_10.channelsSettings.title',
        bodyKey: 'tour.v0_2_10.channelsSettings.body',
        missingKey: 'tour.v0_2_10.channelsSettings.missing',
      },
      {
        id: 'channels-pane',
        prepare: { kind: 'close-settings' },
        anchor: '[data-testid="channel-connect"], [data-testid="channel-chip"]',
        titleKey: 'tour.v0_2_10.channelsPane.title',
        bodyKey: 'tour.v0_2_10.channelsPane.body',
        missingKey: 'tour.v0_2_10.channelsPane.missing',
      },
      {
        id: 'voice-settings',
        prepare: { kind: 'settings', tab: 'voice' },
        anchor: '[data-settings-section="voice"]',
        titleKey: 'tour.v0_2_10.voiceSettings.title',
        bodyKey: 'tour.v0_2_10.voiceSettings.body',
        missingKey: 'tour.v0_2_10.voiceSettings.missing',
      },
      {
        id: 'voice-dictate',
        prepare: { kind: 'close-settings' },
        anchor: '.xterm-host[data-pane-id]',
        titleKey: 'tour.v0_2_10.voiceDictate.title',
        bodyKey: 'tour.v0_2_10.voiceDictate.body',
        missingKey: 'tour.v0_2_10.voiceDictate.missing',
      },
      {
        id: 'done',
        titleKey: 'tour.v0_2_10.done.title',
        bodyKey: 'tour.v0_2_10.done.body',
      },
    ],
    title: {
      'zh-TW': '從聊天軟體指揮 CLI，還能直接用說的',
      'en-US': 'Drive Your CLIs from a Chat App — or Just Talk to Them',
      'ja-JP': 'チャットアプリから CLI を操作、そして声でも',
    },
    features: [
      {
        icon: '💬',
        name: { 'zh-TW': 'Channels 聊天頻道', 'en-US': 'Channels', 'ja-JP': 'チャンネル' },
        tagline: {
          'zh-TW': '把 Telegram、Discord、Slack、飛書、釘釘、Matrix、Mattermost 或 iMessage 接到 pane：在聊天室下指令，回合結束時結果回到同一個對話。',
          'en-US': 'Connect Telegram, Discord, Slack, Feishu/Lark, DingTalk, Matrix, Mattermost or iMessage to a pane: send instructions from the chat, and the answer comes back to the same conversation when the turn ends.',
          'ja-JP': 'Telegram、Discord、Slack、Feishu/Lark、DingTalk、Matrix、Mattermost、iMessage をペインにつなぎ、チャットから指示を送ると、ターン終了時に同じ会話へ結果が返ります。',
        },
        where: {
          'zh-TW': '設定 → Channels，再按 pane 標題列的聊天按鈕',
          'en-US': 'Settings → Channels, then the chat button in a pane header',
          'ja-JP': '設定 → チャンネル、次にペインヘッダーのチャットボタン',
        },
      },
      {
        icon: '🎙',
        name: { 'zh-TW': '語音輸入', 'en-US': 'Voice Input', 'ja-JP': '音声入力' },
        tagline: {
          'zh-TW': '按住快捷鍵說話，放開後文字就打進目前的 pane。辨識完全在本機進行，語音不會離開這台電腦。',
          'en-US': 'Hold a key and speak; let go and the words are typed into the focused pane. Transcription runs entirely on this machine — your voice never leaves it.',
          'ja-JP': 'キーを押しながら話し、離すとフォーカス中のペインに文字が入力されます。文字起こしはすべてこのマシン上で行われ、音声は外に出ません。',
        },
        where: {
          'zh-TW': '設定 → 語音輸入（預設關閉）',
          'en-US': 'Settings → Voice Input (off by default)',
          'ja-JP': '設定 → 音声入力（初期状態はオフ）',
        },
      },
    ],
    highlights: [
      {
        'zh-TW': 'Channels：平台在「設定 → Channels」設定一次，之後每個 pane 都能從標題列的聊天按鈕綁到一個聊天位置（Telegram 論壇主題、Discord/Slack 討論串…）。只有配對過的傳送者能下指令；CLI 要求權限時，會把選項送到聊天室讓你回答，但永遠不會代按「永久允許」。',
        'en-US': 'Channels: set a platform up once in Settings → Channels, then bind any pane to one chat location (a Telegram forum topic, a Discord or Slack thread, …) from the chat button in its header. Only paired senders can give instructions; when a CLI asks for permission the options are relayed to the chat for you to answer, and a permanent-allow option is never pressed from chat.',
        'ja-JP': 'チャンネル：プラットフォームは「設定 → チャンネル」で一度設定すれば、各ペインをヘッダーのチャットボタンから 1 つのチャット位置（Telegram フォーラムのトピック、Discord/Slack のスレッドなど）に結び付けられます。指示できるのはペアリング済みの送信者だけです。CLI が許可を求めると選択肢がチャットに届き、そこで回答できますが、「常に許可」がチャットから押されることはありません。',
      },
      {
        'zh-TW': '語音輸入：在「設定 → 語音輸入」打開並下載辨識模型後，按住快捷鍵（預設 Ctrl+Alt+M，也可以改成 fn 🌐、單獨的 ⌘ 或任一單鍵）說話。說話時就會即時顯示文字；只輸入、不送出，錄音中按 Enter 則結束並送出。中文預設轉成台灣繁體。',
        'en-US': 'Voice Input: turn it on in Settings → Voice Input and download the speech model, then hold the shortcut (Ctrl+Alt+M by default — or fn 🌐, a lone ⌘, or any single key) and speak. Words appear as you talk; they are typed, never sent — press Enter during a take to end it and send. Chinese comes out in Traditional (Taiwan) by default.',
        'ja-JP': '音声入力：「設定 → 音声入力」でオンにして音声モデルをダウンロードし、ショートカット（既定は Ctrl+Alt+M。fn 🌐、単独の ⌘、任意の単一キーにも変更可）を押しながら話します。話しながら文字が表示され、入力されるだけで送信はされません。録音中に Enter を押すと終了して送信します。',
      },
    ],
  },
  {
    version: '0.2.9',
    title: {
      'zh-TW': '排程工作、帳號命名、額度用完自動切帳號、日文介面',
      'en-US': 'Scheduled Work, Named Accounts, Quota Failover and a Japanese Interface',
      'ja-JP': 'スケジュール実行、アカウント名、クォータ切れ時の切り替え、日本語 UI',
    },
    highlights: [
      {
        'zh-TW': '「排程」分頁可以替 CLI pane 排工作：指定時間跑一次，或每 N 分鐘、每天、每週重複，時間到了就喚醒該 pane 並送出指令。',
        'en-US': 'Schedule work for a CLI pane from the Schedule tab: once at a set time, or every N minutes, daily or weekly — when due it wakes the pane and sends it the instruction.',
        'ja-JP': '「スケジュール」タブから CLI ペインの作業を予約できます。指定時刻に 1 回、または N 分ごと・毎日・毎週に繰り返し、時刻になるとペインを起こして指示を送ります。',
      },
      {
        'zh-TW': '每個 CLI 帳號都能命名，名稱會出現在 pane 標題列的額度徽章、帳號清單與切換通知。',
        'en-US': 'Name every CLI account; the name leads in the pane header’s quota badge, the account list and switch notices.',
        'ja-JP': 'CLI アカウントごとに名前を付けられ、ペインヘッダーのクォータバッジ、アカウント一覧、切り替え通知に表示されます。',
      },
      {
        'zh-TW': '帳號額度用完時，可以選擇關閉、只通知，或自動切到另一個帳號並接續對話。',
        'en-US': 'When an account runs out of quota, choose Off, Notify, or Auto — which switches to another account and resumes the conversation.',
        'ja-JP': 'アカウントのクォータが尽きたとき、オフ・通知のみ・自動（別のアカウントに切り替えて会話を再開）から選べます。',
      },
      {
        'zh-TW': '新增日文介面，可在「設定 → 語言」切換。',
        'en-US': 'A Japanese interface, chosen from Settings → Language.',
        'ja-JP': '日本語インターフェースを追加しました。「設定 → 言語」で切り替えられます。',
      },
    ],
  },
  {
    version: '0.2.8',
    title: {
      'zh-TW': '摺疊群組、整個專案一次回收、Claude 往上滑的先前提示回來了',
      'en-US': 'Fold a Group, Reclaim a Whole Project, and Claude\u2019s Scroll-Back Row Returns',
    },
    highlights: [
      {
        'zh-TW': '群組可以整個摺疊起來，側欄與專案標題都能操作。摺疊後拖曳那一列，被藏起來的子代會跟著走——以前只有父列會動，孩子留在原地。多選時只有你抓的那一列會展開成子樹，其他摺疊列仍單獨移動。',
        'en-US': 'A group folds up everything under it, from the sidebar or the workspace heading. Drag a folded row and the hidden descendants travel with it — before, the parent moved alone and left its children behind. In a multi-selection only the row you grabbed expands into its subtree.',
      },
      {
        'zh-TW': 'Claude Code 全螢幕時往上滑會顯示先前提示的那一列深色橫幅，之前會莫名消失。原因是 Navide 關 pane 時直接強制終止，claude 來不及跑自己的退出處理，在設定檔留下殘跡；累積兩次它就自己把全螢幕關掉。現在 macOS 與 Linux 會先送 SIGTERM 並等它收尾。**Windows 尚未支援**，追蹤於 #120。',
        'en-US': 'Claude Code\u2019s dim row of previous prompts — the one that appears when you scroll up in fullscreen — stopped showing for some people. Navide was terminating the pane outright, so claude never ran its own exit handler and left a trace behind; two of those and it turns fullscreen off itself. macOS and Linux now send SIGTERM and wait. **Not on Windows yet** — tracked in #120.',
      },
      {
        'zh-TW': '側欄可以一次回收整個專案的 CLI，每個 pane 變成點一下就能接續的佔位。正在使用的、等你回答的、有未送出文字的、還有無法接續的，都不會被收走。',
        'en-US': 'Reclaim a whole project\u2019s CLIs from the sidebar; each pane becomes a click-to-resume placeholder. The focused pane, one awaiting your answer, one holding unsent text and one that cannot be resumed are left alone.',
      },
      {
        'zh-TW': '在一個視窗裡開多個專案時，切換途中開的 pane 會被歸到「正要離開的那個專案」的群組底下，嚴重時還會把一個專案的群組記錄蓋掉另一個。這版修好了。**如果你在 0.2.7 已經遇到，舊資料要手動清**：關掉 Navide 後執行 scripts/repair-run-group-ids.py（預設乾跑、寫入前自動備份）。',
        'en-US': 'With two workspaces in one window, a pane opened mid-switch filed itself under the workspace being left, and saving could write one workspace\u2019s groups over another\u2019s. Fixed. **If 0.2.7 already mixed your rows**, the fix only stops new ones — close Navide and run scripts/repair-run-group-ids.py to clean up (dry-runs by default, backs up first).',
      },
      {
        'zh-TW': 'Navide Cloud 的 pane 清單改成依裝置 → 狀態 → 專案分層，可摺疊、可搜尋，不再是一長串。Welcome 的「New…」現在可以直接命名新資料夾，不必再靠系統對話框改名。',
        'en-US': 'The Navide Cloud pane list nests by device, state and workspace, foldable and searchable, instead of one flat run of rows. Welcome\u2019s New… now asks for a name rather than leaving you to rename in the file picker.',
      },
    ],
  },
  {
    version: '0.2.7',
    title: {
      'zh-TW': 'Codex pane 不再誤判失敗、更新改走自家載點',
      'en-US': 'Codex Panes Stop Failing, Updates Come From Our Own Mirror',
    },
    highlights: [
      {
        'zh-TW': 'Codex pane 開起來約 30 秒後被判「失敗」、但 Codex 自己明明還停在提示字元——這個已修。原因是建立終端機時要先掃完該廠商的整棵 session 樹（Codex 會逐一打開每個 rollout 檔讀檔頭），樹一大就超過前端 30 秒的等待上限。現在 PTY 一起來就先回報成功，掃描在背後跑。',
        'en-US': 'A Codex pane that reported failed about 30 seconds after starting — while Codex itself sat at its prompt — is fixed. Creating a terminal waited for a scan that opens every rollout file in the vendor\u2019s session tree; on a large tree it ran past the renderer\u2019s 30-second deadline. The pane now reports success as soon as its PTY is up, and the scan runs behind it.',
      },
      {
        'zh-TW': 'Codex CLI 0.155 改了日誌格式，pane 命名因此空白、每呼叫一次工具就誤報回合結束——已跟上新格式，命名恢復，回合以 task_complete 為準。',
        'en-US': 'Codex CLI 0.155 changed its rollout log, leaving pane names blank and reporting a turn finished on every tool call. The reader now follows the new format: names come back, and a turn ends at task_complete.',
      },
      {
        'zh-TW': 'App 內自動更新改成優先向 dl.navide.dev 取得，和官網下載按鈕同一個載點，連不上時才退回 GitHub。GitHub 的檔案主機在部分網路下只有數十 KB/s，200 MB 的安裝檔常常下不完。',
        'en-US': 'In-app updates now come from dl.navide.dev first — the same host the website\u2019s download buttons use — and fall back to GitHub only when the mirror cannot be reached. GitHub\u2019s asset host runs at tens of KB/s on some networks, too slow to finish a 200 MB installer.',
      },
      {
        'zh-TW': '「設定」側欄的「外掛程式」群組併入「整合」：擴充功能與市集移到記憶體之後；「通知」從冗長的一般頁獨立成自己的分頁，排在版面之後。搜尋設定仍然找得到每一列。',
        'en-US': 'The Settings sidebar folds its Plugins group into Integrations — Extensions and Marketplace now sit after Memory — and Notifications leaves the long General page for a tab of its own after Layout. Searching Settings still finds every row.',
      },
      {
        'zh-TW': '從專案標題的 ＋ 選單點另一個 CLI，現在只是「開這一次」，不會把它改成預設。要換預設請用 Ctrl+1～9 或設定。',
        'en-US': 'Picking another CLI from a workspace heading\u2019s ＋ menu now opens it once instead of changing the default. Ctrl+1\u20269 and Settings still set the default.',
      },
    ],
  },
  {
    version: '0.2.6',
    title: {
      'zh-TW': 'Marketplace 獨立分頁、原生選單跟隨語言、用量徽章不再誤亮',
      'en-US': 'Marketplace Page, Localized Native Menu, Usage Badge That Stays Honest',
    },
    highlights: [
      {
        'zh-TW': '「設定 → 外掛程式」現在是兩頁：搜尋與安裝擴充功能請到新的「市集」；「擴充功能」頁只剩已安裝清單，而原本獨立的「執行政策」分頁變成這一頁最上方的區塊，沒有消失。「Navide Cloud」也從「一般」群組搬到「帳號與代理」。',
        'en-US': 'Settings → Extensions is now two pages: search and install on the new Marketplace page; Extensions keeps what is installed, with the former Execution Policy tab folded into a block at its top. Navide Cloud moves from General to Accounts & Agents.',
      },
      {
        'zh-TW': 'Electron 原生選單（檔案／編輯／檢視／視窗）跟隨介面語言，切換語言時即時重建。專案標題的 ⋯ 選單收進了原本只有右鍵才有的動作（在 Finder 開啟、複製路徑、重新命名、獨立視窗、關閉工作區）。',
        'en-US': 'The native application menu follows the UI language and rebuilds when you switch. A workspace\u2019s ⋯ menu gains the actions that used to need a right-click: reveal in Finder, copy path, rename, open in its own window, close.',
      },
      {
        'zh-TW': '用量上限徽章改以帳號的 /usage 讀數為準：終端裡出現的「已達上限」句子若與新讀數矛盾會被否決，不再因為重播歷史或討論額度而誤亮好幾個小時；反過來帳號真的用完時即使 CLI 沒印任何字也會亮。',
        'en-US': 'The usage-limit badge now trusts the account\u2019s /usage reading: a limit sentence in the terminal that contradicts a fresh reading is overruled, so a replayed transcript or a conversation about quotas no longer lights it for hours; and it lights from the reading alone when the account really is spent.',
      },
      {
        'zh-TW': '裝了 xAI grok 的機器不會再把它當成 Cursor CLI（同名的 agent 執行檔）；從「設定 → 帳號」登入現用 Claude／Kilo 帳號時 pane 不再秒退；Copilot 與 Muse 的登入按鈕現在直接執行各自的 login 指令。',
        'en-US': 'grok is no longer detected or launched as Cursor CLI (same `agent` binary name); signing in to the current Claude or Kilo account from Settings → Accounts no longer kills the pane; Copilot and Muse sign in with their own login commands.',
      },
      {
        'zh-TW': 'Codex 若每次開 pane 都跳「Hooks need review」，看過一次後這台機器就不再注入該 hook——session 綁定改走 log 偵測，功能不缺但目前沒有 UI 可以重新開啟。',
        'en-US': 'If Codex asks "Hooks need review" on every pane, seeing it once now stops the hook being injected on this machine; session binding falls back to log detection, and there is no UI yet to turn it back on.',
      },
      {
        'zh-TW': '說明中心新增「Windows、Linux 與跨裝置」主題與「用量」章節，介面標籤改由產品自身的翻譯鍵引用，修正了二十處寫錯的說明。側欄拖曳已折疊的父列會連同隱藏的子樹一起搬。',
        'en-US': 'Help gains a Windows, Linux & cross-device topic and a Usage section; interface labels in help text now come from the same keys the UI renders, correcting twenty descriptions. Dragging a folded pane row carries its hidden subtree along.',
      },
    ],
  },
  {
    version: '0.2.5',
    title: {
      'zh-TW': '每個 CLI 的啟動設定、一次關掉整組面板',
      'en-US': 'Per-CLI Launch Settings, Closing a Whole Branch at Once',
    },
    highlights: [
      {
        'zh-TW': '「設定 → CLI Agents」現在把每個 CLI 的東西收在同一頁：預設模型與 reasoning effort、自訂啟動指令、額外環境變數、權限略過、推送通道、安裝引導。手動開 pane 的對話框也多了 Model 與 Effort 欄位。注意：填了自訂啟動指令就等於完全接管命令列，Navide 不會再往上加任何參數（包含預設模型與權限略過）。',
        'en-US': 'Settings → CLI Agents now holds everything about a CLI in one place: a default model and reasoning effort, a custom launch command, extra environment variables, permission bypass, push channels and guided install. The manual spawn dialog gains Model and Effort fields. Note: a custom launch command takes the command line over completely — Navide adds nothing to it, including the default model and the permission-bypass flag.',
      },
      {
        'zh-TW': '面板右鍵選單新增「一次關掉這個與它衍生的全部代理」，不必再看著子代理重新掛到別的父節點上。',
        'en-US': 'A pane\u2019s context menu can now close it together with every agent it spawned, instead of leaving the children to reattach to another parent.',
      },
      {
        'zh-TW': '額度用盡的 ⛔ 徽章可以點掉了（會先確認），正在等額度的 loop 會立刻續跑；也修好了「關掉一次之後，隔天或切回該帳號再次撞到額度卻完全沒有提示」的問題。',
        'en-US': 'The out-of-quota badge can be dismissed (with a confirmation), and a loop waiting on quota resumes at once. It also no longer swallows the next real limit the following day, or when you switch back to the account that ran out.',
      },
      {
        'zh-TW': '修好用 npm -g／nvm／volta／pnpm／bun 安裝的 CLI 從 Finder 啟動時開不了 pane（「在終端機跑得動、在 Navide 開不起來」），安裝引導也改成 shell 真的回報找不到指令才提示。',
        'en-US': 'Fixed panes refusing to open for a CLI installed through npm -g, nvm, volta, pnpm or bun when Navide was started from Finder — the "works in Terminal, will not open in Navide" case. Guided install now waits until the shell actually reports the command is missing.',
      },
      {
        'zh-TW': 'macOS 上 nvm 的路徑順序改了：你用 nvm use 選的 node 版本不會再被換掉。若你原本（無意間）依賴 Navide 把 nvm 的 node 排到最前面，現在拿到的會是你自己 shell PATH 裡的那一個。',
        'en-US': 'On macOS the nvm directories now come after your own PATH, so the node you selected with nvm use is no longer replaced. If you were relying on Navide putting an nvm node first, you will now get the one your shell would.',
      },
      {
        'zh-TW': 'Pipeline 的「繼續執行」修好了——原本每個開出來的 pane 都會以「cwd does not exist」失敗；連點兩次也不會再重複開。',
        'en-US': 'Resuming a pipeline stage works again — every pane it opened used to fail with "cwd does not exist" — and pressing Resume twice no longer spawns the stage twice.',
      },
    ],
  },
  {
    version: '0.2.4',
    title: {
      'zh-TW': 'Token Monitor 與額度週期、下載鏡像',
      'en-US': 'Token Monitor & Quota Cycles, Download Mirror',
    },
    highlights: [
      {
        'zh-TW': '新增「視窗 → Token Monitor」獨立視窗：每輪 token 用量與模型分佈、5 小時／月／年額度週期彙總，以及 14／30／90 天的平均與中位數。額度觀測只讀既有輪詢資料，不會多送任何請求。',
        'en-US': 'New Window → Token Monitor: per-turn token usage and model mix, 5-hour / monthly / yearly quota cycles, and 14/30/90-day averages and medians. Quota observations reuse existing polls and send no extra provider requests.',
      },
      {
        'zh-TW': '更正：原本預告的「設定 → Sharing」分頁在 0.2.4 出貨前已移除、等待重新設計。匯出／匯入設定全集仍可在「設定 → General → 設定管理」使用；雲端分享碼與已配對裝置清單尚未推出。',
        'en-US': 'Correction: the Settings → Sharing page announced for this release was removed before 0.2.4 shipped and is awaiting a redesign. Exporting and importing the settings bundle is still available under Settings → General → Settings Management; the cloud share code and paired-device list did not ship.',
      },
      {
        'zh-TW': '關閉工作區時可選擇保留 CLI 繼續在背景執行：右鍵選單分成「關閉工作區」與「關閉工作區與 CLI 視窗」，關掉畫面不再等於砍掉正在跑的 agent。',
        'en-US': 'Closing a workspace can now leave its CLI panes running: the context menu separates "close workspace" from "close workspace and its CLI panes", so putting a project away no longer kills the agents working in it.',
      },
      {
        'zh-TW': '下載改走鏡像 dl.navide.dev：GitHub 載點連不上或太慢時，官網會自動改用鏡像，App 內更新也會在 GitHub 失敗後改走鏡像重試一次。',
        'en-US': 'Downloads now have a mirror at dl.navide.dev: the website switches to it automatically when GitHub is unreachable or slow, and the in-app updater retries there after a network failure on GitHub.',
      },
      {
        'zh-TW': '終端機輸入在 CLI 大量輸出時不再卡住；工作區側邊欄支援子樹摺疊；Codex 面板重啟後能正確接回原本的對話。',
        'en-US': 'Terminal input no longer stalls while a CLI floods the pane with output; the workspace sidebar folds subtrees; and Codex panes reconnect to their original conversation after a restart.',
      },
    ],
  },
  {
    version: '0.2.3',
    title: {
      'zh-TW': '四平台同一版本、Windows ARM64 原生版',
      'en-US': 'One Build for Four Platforms, Native Windows ARM64',
    },
    highlights: [
      {
        'zh-TW': 'macOS、Windows x64、Windows ARM64 與 Linux x64 首次由同一個 commit 出貨；Windows on Arm 有了原生安裝檔，不再靠模擬執行。',
        'en-US': 'macOS, Windows x64, Windows ARM64 and Linux x64 ship from one commit for the first time, and Windows on Arm gets a native installer instead of running emulated.',
      },
      {
        'zh-TW': '修正終端機面板在分析器輪詢期間逾時的問題（外連 TLS 內容改為只建一次且不佔用事件迴圈）。',
        'en-US': 'Fixed terminal panes timing out while the analyzer polled: the outbound TLS context is now built once, off the event loop.',
      },
      {
        'zh-TW': 'MCP 面板可接續既有的 CLI 對話；側邊欄拖放會建立面板血緣關係。',
        'en-US': 'MCP panes can resume an existing CLI conversation, and sidebar drag-and-drop assigns pane lineage.',
      },
    ],
  },
  {
    version: '0.2.2',
    title: {
      'zh-TW': 'Windows 與 Linux 跨平台支援、Prompt Skills 自訂圖示與工作區別名',
      'en-US': 'Windows & Linux Multi-Platform Support, Custom Prompt Skill Icons & Workspace Aliases',
    },
    highlights: [
      {
        'zh-TW': 'Windows 與 Linux 正式支援：新增 Windows NSIS 安裝包、ConPTY 終端機與 DPAPI 安全加密；Linux 支援 AppImage（內建靜態 FUSE3 執行期）與桌面整合。',
        'en-US': 'Windows & Linux support: Official Windows NSIS installer, ConPTY terminal, and DPAPI encryption; Linux AppImage with static FUSE3 runtime and desktop integration.',
      },
      {
        'zh-TW': 'Prompt Skills 升級：支援自訂 Emoji/單字元圖示與 24 款內建向量圖示；非預設技能支援一鍵單次呼叫（One-shot Cast），不再強制循環。',
        'en-US': 'Prompt Skills enhancements: Support for custom single-character emoji icons and 24 builtin vector icons, plus one-shot casting for non-default skills without loop lock.',
      },
      {
        'zh-TW': '工作區別名與階層狀態：支援設定工作區顯示名稱別名；側邊欄整合子 Agent 樹狀狀態標籤（Subtree Status）、Token 消耗分組與長路徑清晰展示。',
        'en-US': 'Workspace aliases & hierarchy status: Custom workspace display names, sidebar subtree status badges, token attribution by run group, and clear path hierarchy.',
      },
      {
        'zh-TW': 'Plans 穩定性加固：實作單一飛行（Single-flight）併發掃描合併與防抖機制，支援目錄搬移即時追蹤與重試復原。',
        'en-US': 'Plans performance & hardening: Single-flight concurrent scan coalescing, debounced watcher events, directory move tracking, and recovery retries.',
      },
      {
        'zh-TW': 'MCP 與訊息協議加強：支援喚醒冷啟動面板、Ack-only 確認訊息不佔用終端輸入、以及多裝置連線感知。',
        'en-US': 'MCP & messaging extensions: Wake cold-restored agent panes, ack-only receipt messages, and multi-device presence hints.',
      },
    ],
  },
  {
    version: '0.2.1',
    title: {
      'zh-TW': '外掛架構升級：打包 Plans 執行期與執行策略（Execution Policy）設定',
      'en-US': 'Plugin Runtime Upgrade: Packaged Plans & Execution Policy',
    },
    highlights: [
      {
        'zh-TW': 'Plans 外掛化：計畫文件遷移至獨立打包的 navide.plans 外掛執行期，支援離線執行、沙盒隔離與容錯復原。',
        'en-US': 'Packaged Plans runtime: Plans migrated to the isolated navide.plans plugin runtime with fallback recovery.',
      },
      {
        'zh-TW': '執行策略（Execution Policy）加固：新增設定介面與黑白名單防護，加強 Agent 執行命令與檔案系統權限控制。',
        'en-US': 'Execution Policy hardening: New settings pane with allowlist/denylist modes to tightly govern agent authority.',
      },
      {
        'zh-TW': '外部 MCP 控制協議擴充：支援 Pipeline 啟動與重啟、階段與角色定義、工作區與用量資源讀取。',
        'en-US': 'Expanded MCP control: Pipeline management, stage/role definitions, and workspace/usage resources.',
      },
      {
        'zh-TW': '外掛後端健康監控優化：提高冷啟動逾時時間，避免重載環境下誤入復原模式。',
        'en-US': 'Plugin backend supervisor: Longer cold boot timeout budget to prevent spurious recovery fallback.',
      },
    ],
  },
  {
    version: '0.2.0',
    major: true,
    title: {
      'zh-TW': 'Navide Cloud 上線：你的裝置，連成一個 agent 網路',
      'en-US': 'Navide Cloud is here: your devices, joined into one agent network',
    },
    spotlight: {
      name: 'Navide Cloud',
      tagline: {
        'zh-TW': '一個帳號，把你所有裝置上的 agent 串成一個私有網路。',
        'en-US': 'One account joins the agents on every device you own into one private network.',
      },
      points: [
        {
          'zh-TW':
            '看得到你的裝置：登入同一個帳號，就能看到哪些機器在線、各自開了哪些 agent、在忙什麼。',
          'en-US':
            'See your machines: sign in on each one and you can tell which are online, which agents they are running, and what those agents are doing.',
        },
        {
          'zh-TW':
            '跨裝置派工：這台的 agent 可以直接對另一台的 agent 下指令、等它回話，就像它們在同一台機器上。',
          'en-US':
            'Hand work across devices: an agent here can instruct an agent there and wait for its answer, as if they shared a machine.',
        },
        {
          'zh-TW':
            '六位數確認才算數：配對時兩台機器各自算出同一組六位數，兩邊都按「一致」才建立信任——中間人做不出這組數字。',
          'en-US':
            'Six digits, confirmed at both ends: pairing shows the same six digits on both machines and trusts neither until both people say they match — a relay cannot produce them.',
        },
        {
          'zh-TW':
            '內容只有你們讀得到：跨裝置訊息端對端加密後才離開本機，伺服器只搬密文；私鑰、絕對路徑與終端機畫面從不上傳。',
          'en-US':
            'Only the two ends can read it: cross-device messages are encrypted before they leave your machine and the server only relays ciphertext. Private keys, absolute paths and terminal output never leave.',
        },
        {
          'zh-TW':
            '預設誰都不准：外來訊息一律拒收，除非你寫下規則放行；封鎖優先於一切規則，連你自己的裝置也擋。',
          'en-US':
            'Nothing is allowed by default: messages from other devices are refused until a rule of yours allows them, and a block outranks every rule — including one for your own machines.',
        },
      ],
    },
    highlights: [
      {
        'zh-TW':
          'MCP 新增四個工具：cli_interrupt（中止對方正在跑的回合）、cli_whoami（問自己是誰）、cli_read_incoming（讀收件匣）、cli_cancel_message（收回還沒送達的訊息）。cli_open_agent 現在也能指定模型與推理強度。',
        'en-US':
          'Four new MCP tools: cli_interrupt (stop a turn in progress), cli_whoami, cli_read_incoming, and cli_cancel_message (take back a message that has not landed). cli_open_agent can now pick the model and reasoning effort.',
      },
      {
        'zh-TW':
          '側欄血緣導軌：面板依「誰開出誰」畫出連續的分支軌，滑過會整條亮起；執行群組列改為黏頂區段標題，附自己的 ＋ 按鈕。',
        'en-US':
          'Sidebar lineage rails: panes are drawn on continuous branch rails showing which opened which, with the whole trunk highlighting on hover. Run-group rows became sticky section headers with their own ＋.',
      },
      {
        'zh-TW':
          '關閉面板前先提醒：還在跑的回合、排隊中的訊息、以及會一起消失的子面板，會在你按下關閉前列出來。',
        'en-US':
          'Advice before you close a pane: an active turn, queued messages, and child panes that would go with it are listed before the pane closes.',
      },
      {
        'zh-TW':
          '終端機拿回控制終端：PTY 子行程現在有自己的 controlling terminal，sudo 密碼提示、Ctrl+C 與視窗縮放通知都恢復正常。',
        'en-US':
          'Panes get a controlling terminal: PTY children now own one, which restores sudo password prompts, Ctrl+C, and resize notifications.',
      },
      {
        'zh-TW':
          '狀態徽章可自訂：Settings 新增徽章分頁，色盤與文字都能改；分頁狀態圓點改為方形，與側欄群組記號一致。',
        'en-US':
          'Customizable status badges: a new settings pane for badge palettes and labels, and the tab status dot is now square to match the sidebar group key.',
      },
      {
        'zh-TW':
          '關閉 App 有畫面了：退出流程會顯示進度覆蓋層，讓你看到它正在收尾而不是卡住。',
        'en-US':
          'Quitting shows its work: a shutdown overlay reports the teardown sequence instead of leaving the window looking frozen.',
      },
      {
        'zh-TW':
          '本機攻擊面收斂：CLI hook 端點、HTTP 檔案路由與 MCP 伺服器清單全部改為需要驗證，並封掉兩條路徑穿越與非 loopback 的 Host 標頭。',
        'en-US':
          'A smaller local attack surface: CLI hook endpoints, HTTP file routes and the MCP server list all require authentication now, and two path-traversal bypasses plus non-loopback Host headers are refused.',
      },
      {
        'zh-TW':
          '啟動與重繪更省：活動掃描只看有面板在跑的工作區、面板檢視不再重複重繪、WebGL 游標閃爍計時器不再洩漏，較重的對話框改為閒置時預先載入。',
        'en-US':
          'Lighter startup and redraw: activity scanning is scoped to workspaces with live panes, unchanged pane views skip re-render, the WebGL cursor-blink timer no longer leaks, and heavy modals prewarm while idle.',
      },
      {
        'zh-TW':
          '計畫文件可封存：新增 plan_archive 工具、封存區段與批次封存，完成的計畫不再擠在清單裡。',
        'en-US':
          'Plans can be archived: a plan_archive tool, an archived section, and batch archiving keep finished plans out of the list.',
      },
    ],
    note: {
      'zh-TW':
        '要開始使用 Navide Cloud：點標題列右上角的雲朵圖示登入，在另一台裝置登入同一個帳號，然後在兩邊按「配對」並核對那六位數。沒有登入的話，這一版的其他功能完全不受影響。',
      'en-US':
        'To start using Navide Cloud: click the cloud mark in the titlebar and sign in, sign in to the same account on another device, then press Pair on both and check the six digits match. Everything else in this release works exactly the same if you never sign in.',
    },
  },
  {
    version: '0.1.93',
    title: {
      'zh-TW': 'Git 插件 Manifest v2 遷移、MCP 核心模組化、插件主題即時同步與 UI 控制增強',
      'en-US': 'Git Plugin Manifest v2 Runtime, Modular MCP Core, Plugin Theme Sync & UI Control',
    },
    highlights: [
      {
        'zh-TW':
          'Git 插件 Manifest v2 架構遷移：全面切換至 Manifest v2 插件沙盒運行時，支援持久化儲存分區與獨立 Host/Plugin 傳輸適配層。',
        'en-US':
          'Git Plugin Manifest v2 Migration: fully cut over to Manifest v2 isolated sandbox runtime with durable storage partitioning and decoupled transport adapters.',
      },
      {
        'zh-TW':
          'MCP 核心伺服器模組化解耦：將 MCP 伺服器核心抽離至獨立模組，計畫（Plan）工具改由插件透過標準擴充點註冊。',
        'en-US':
          'Modular MCP Server Architecture: decoupled the core MCP server into dedicated modules with plan tools registered cleanly via plugin extension points.',
      },
      {
        'zh-TW':
          '插件 WebView 即時主題同步：主進程在 Guest WebView 附加時自動同步 Host 主題與外觀變更，徹底解耦 Preload 全局橋接。',
        'en-US':
          'Plugin WebView Theme Synchronization: main process automatically syncs host theme states and switch events to guest webviews upon attachment.',
      },
      {
        'zh-TW':
          '外部 MCP UI 快照與目標工作區過濾：ui_snapshot 與 ui_diagnostics 工具支援精準指定目標工作區路徑，強化多視窗自動化控制。',
        'en-US':
          'Target Workspace Filtering for UI MCP: ui_snapshot and ui_diagnostics tools now support targeting specific workspace paths across multi-window setups.',
      },
      {
        'zh-TW':
          '側邊欄工作區拖曳與層級縮排優化：完善多工作區拖曳分離為獨立視窗的手勢反饋，並修復子面板折疊導軌與縮排對齊。',
        'en-US':
          'Sidebar Workspace Drag-Out & Lineage Rails: enhanced gestures for dragging workspaces into standalone windows and resolved lineage rail indentation alignment.',
      },
      {
        'zh-TW':
          'Git 左側面板佈局與剪貼簿路徑安全修復：修復左側面板 Flex 容器排版防止區塊裁切，並淨化拖放檔案名稱避免輸入重試遺失。',
        'en-US':
          'Git Panel Flex Layout & Drag-Drop Path Sanitization: fixed column flex layout preventing clipped panel sections and sanitized dropped file paths.',
      },
    ],
  },
  {
    version: '0.1.92',
    title: {
      'zh-TW': '終端 @ 提及選單、原生 MCP/Memory 管理、Prompt Skills 與縮放重排優化',
      'en-US': 'Terminal @-Mention Menu, Native MCP & Memory Panes, Prompt Skills & Resize Reflow Fixes',
    },
    highlights: [
      {
        'zh-TW':
          '終端 @ 提及選單與冷還原修復：在終端輸入 @ 即時彈出跨面板與上下文候選選單，並修復冷還原面板註冊 handle 與深淺主題固定色盤適配。',
        'en-US':
          'Terminal @-Mention Menu & Lazy Restore Fix: popup mention menu for panes and context autocomplete on @, with lazy restore handle registration and terminal palette styling.',
      },
      {
        'zh-TW':
          '原生 MCP 伺服器與 Native Memory 管理面板：獨立視覺化面板支援 MCP 伺服器健康檢查、工具調用診斷與系統進程記憶體即時採樣分析。',
        'en-US':
          'Native MCP & Memory Management: dedicated visual panes for MCP server health diagnostics, tool inspection, and kernel-level memory monitoring.',
      },
      {
        'zh-TW':
          'Prompt Skills 懸浮技能選取器：終端頂部新增技能快捷輪播選單，支援懸浮預覽與一鍵施放常用 Prompt 技能。',
        'en-US':
          'Prompt Skills Hover Picker: quick carousel menu for invoking and previewing reusable prompt skills directly from the terminal.',
      },
      {
        'zh-TW':
          '終端寬度縮放雙層競態修復：引入 Ack Barrier 與 Generation Guard，徹底消除視窗縮放與 TUI 寬度重排時的畫面殘留問題。',
        'en-US':
          'Terminal Resize Reflow Dual-Race Fix: incorporates ack barrier and generation guard to prevent resize race conditions and frame residue.',
      },
      {
        'zh-TW':
          'Droid (Factory) CLI 正式整合：新增 Droid 官方支援，支援參數自訂、日誌串流與獨立進程生命週期管理。',
        'en-US':
          'Droid (Factory) CLI Vendor: official Droid integration with tailored settings, log streaming, and lifecycle management.',
      },
      {
        'zh-TW':
          'Preview 預覽面板日誌與 MCP 遠端讀取：環形緩衝區自動捕獲 Console 與 Network 請求，並提供 MCP 診斷工具。',
        'en-US':
          'Preview Console/Network Ingestion & MCP Tools: ring-buffer log capture for preview panels with remote MCP inspection tools.',
      },
    ],
  },
  {
    version: '0.1.91',
    title: {
      'zh-TW': '全新資源管理器、背景子代理追蹤、Loop 迴圈等待退避與日誌防護',
      'en-US': 'Resource Manager, Background Subagent Tracking, Loop Wait Backoff & Log Stability',
    },
    highlights: [
      {
        'zh-TW':
          '全新資源管理器 (Resource Manager)：整合 CPU 佔用、記憶體與 Token 消耗即時監控，支援全局面板跳轉與閒置回收。',
        'en-US':
          'Unified Resource Manager: real-time CPU, memory, and token monitoring with cross-window pane jumping and idle reclaim.',
      },
      {
        'zh-TW':
          '背景子代理追蹤與 Loop 等待退避：支援 <<LOOP_WAIT>> 標記與階梯式退避，精準識別子代理執行狀態，防止迴圈空轉。',
        'en-US':
          'Subagent Tracking & Loop Wait Backoff: supports <<LOOP_WAIT>> markers and tiered backoff to prevent loops from spinning on background tasks.',
      },
      {
        'zh-TW':
          '工作區多視窗拖曳交接：側邊欄工作區標題支援拖曳至獨立新視窗，無縫移交運作中的 Agent 會話。',
        'en-US':
          'Workspace Detach Gesture: drag workspace headers out to their own windows without interrupting active agent processes.',
      },
      {
        'zh-TW':
          '日誌讀取與回合結束訊號防護：修復未完成行導致 High-Water Mark 提前推進的問題，確保回合結束訊號不遺失。',
        'en-US':
          'Log Ingestion & Turn-End Protection: prevents half-written log lines from prematurely advancing watermarks and dropping turn ends.',
      },
      {
        'zh-TW':
          'Claude 配額直接查詢：改採 Print 模式直接非同步執行獲取額度與原因，消除終端模擬輸入的延遲與誤報。',
        'en-US':
          'Claude Quota Direct Probing: fetches Claude quotas directly via print mode, eliminating PTY input lag and false errors.',
      },
    ],
  },
  {
    version: '0.1.90',
    title: {
      'zh-TW': '終端 PTY 二進位幀串流傳輸與後端日誌探索效能優化',
      'en-US': 'Terminal PTY Binary Frame Streaming & Background Rescan Performance',
    },
    highlights: [
      {
        'zh-TW':
          '終端 PTY 二進位幀傳輸：終端輸出全面改採 WebSocket Binary Frame 串流，避免 JSON 字串編碼與轉義負擔，巨量輸出更加極速流暢。',
        'en-US':
          'PTY Binary Frame Streaming: terminal outputs now stream over WebSocket binary frames, eliminating JSON escaping overhead for high-speed terminal throughput.',
      },
      {
        'zh-TW':
          '後端檔案探索非同步化：日誌監控（LogWatcher）磁碟檔案探索全面移至背景執行緒，徹底杜絕大型專案下的主事件循環延遲。',
        'en-US':
          'Non-blocking Rescan Discovery: moves disk session discovery into background threads, keeping the main asyncio event loop completely responsive.',
      },
    ],
  },
  {
    version: '0.1.89',
    title: {
      'zh-TW': '官方 Brand 視覺升級、Git 多倉庫選擇器、靜音閒置回收與品質守衛',
      'en-US': 'Official Brand Assets, Git Multi-Repo Selector, Quiet Idle Sweep & Quality Gates',
    },
    highlights: [
      {
        'zh-TW':
          '官方 Brand Assets 視覺升級：全新深淺色 Logo、向量 SVG、macOS Canvas 規範應用程式圖標與多尺寸 Web Favicon。',
        'en-US':
          'Official Brand Assets: new light/dark logos, vector SVGs, macOS canvas icons, and multi-size web favicons.',
      },
      {
        'zh-TW':
          'Git 多倉庫選擇器：工作區包含多個 Git 倉庫時，Git 面板支援下拉快速切換當前焦點儲存庫。',
        'en-US':
          'Git Multi-Repo Selector: easily switch between repositories in multi-repository workspaces directly within the Git pane.',
      },
      {
        'zh-TW':
          '定時閒置回收靜音：背景定時掃描並回收長時間閒置的 CLI 終端時僅記錄於日誌，不再彈出打擾 Toast 提示。',
        'en-US':
          'Quiet Idle Sweep: background timed idle sweeps log quietly without popping up disruptive toast notifications.',
      },
      {
        'zh-TW':
          'WebSocket 指數退避重連：WebSocket 連線中斷時自動依指數退避策略重試連線（1.5s 至 30s）。',
        'en-US':
          'WebSocket Exponential Reconnect: automatic reconnection with exponential backoff on dropped WebSocket connections.',
      },
      {
        'zh-TW':
          'Ruff 靜態分析與發布守衛：發布流程正式引入 Ruff ASYNC 與 F821 規則檢查，嚴防未定義變數與 Event Loop 阻塞。',
        'en-US':
          'Release Quality Gates: integrates Ruff ASYNC and F821 checks into release gates to guard against unhandled imports and loop stalls.',
      },
    ],
  },
  {
    version: '0.1.88',
    title: {
      'zh-TW': '後端 Event Loop 延遲監控、視窗最小尺寸防護與 Kimi 延遲優化',
      'en-US': 'Event-Loop Latency Watchdog, Window Minimum Dimensions & Kimi TUI Optimization',
    },
    highlights: [
      {
        'zh-TW':
          'Event Loop 延遲監控看門狗：每秒探測後端排程延遲，及時發現並記錄潛在的長耗時操作。',
        'en-US':
          'Event-Loop Latency Watchdog: monitors and logs backend scheduling latency to catch blocking operations early.',
      },
      {
        'zh-TW':
          '視窗最小尺寸限制：為桌面視窗設定合理的最小寬高防護，避免過度縮小導致介面擠壓。',
        'en-US':
          'Window Minimum Dimensions: enforces minimum window bounds to prevent layout distortion when resized small.',
      },
      {
        'zh-TW':
          'Kimi CLI 退出鍵瞬間響應：預設配置 escape sequence 延遲時間，消除 Kimi TUI 介面下的選單切換延遲。',
        'en-US':
          'Kimi TUI Esc Sequence Fix: configures escape timeouts so menu and navigation keys respond immediately.',
      },
      {
        'zh-TW':
          'Git 倉庫受限掃描時間：大型或網路檔案系統上的倉庫探索加入時間預算，不阻塞後端事件循環。',
        'en-US':
          'Bounded Git Discovery: bounds filesystem repository discovery scans with a timeout budget to keep the backend responsive.',
      },
    ],
  },
  {
    version: '0.1.87',
    title: {
      'zh-TW': '工作區 Slot 佈局、檔案預覽面板、Process 記憶體探針與閒置回收',
      'en-US': 'Workbench Layout Model, File Previews, Process Memory Probes & Idle Reclaim',
    },
    highlights: [
      {
        'zh-TW':
          '工作區 Slot 自訂佈局：支援左/右/底側欄自訂槽位與快捷鍵折疊切換。',
        'en-US':
          'Workbench Layout Model: custom slot containers across left, right, and bottom panels with collapse shortcuts.',
      },
      {
        'zh-TW':
          '檔案與產物預覽面板：支援 Markdown、HTML 與程式碼片段即時預覽，以及 Diff 唯讀檢視。',
        'en-US':
          'File & Artifact Previews: inline rendering for Markdown, HTML, code snippets, and Diff views.',
      },
      {
        'zh-TW':
          '後端 Process 記憶體探針：狀態列即時顯示後端與終端記憶體佔用與 Token 詳細統計。',
        'en-US':
          'Process Memory Telemetry: status bar popovers with real-time memory usage and token usage breakdowns.',
      },
      {
        'zh-TW':
          '終端長時間閒置回收：自動回收長時間無操作的 CLI 面板釋放系統記憶體，支援點擊一鍵恢復。',
        'en-US':
          'Terminal Idle Reclaim: automatically reclaims memory from long-idle CLI processes with one-click restore.',
      },
    ],
  },
  {
    version: '0.1.86',
    title: {
      'zh-TW': '階段分頁狀態燈號、⌘W 彈窗關閉優化、剪貼簿貼上防禦與 Dev 正式版隔離',
      'en-US': 'Stage Tab Status Dots, ⌘W Modal Close, Paste Timeout Defense & Dev/Prod Isolation',
    },
    highlights: [
      {
        'zh-TW':
          'StageTabBar 狀態燈號：頂部階段標籤新增彩色動態狀態燈號與 Tooltip，即時匯總該階段所有 Agent 的運行、提問等待或錯誤狀態。',
        'en-US':
          'Stage Tab Status Dots: stage tabs show live color status dots and tooltips summarizing running, awaiting question, or error states across all agents in that stage.',
      },
      {
        'zh-TW':
          '⌘W 彈窗關閉與防誤觸確認：按 ⌘W 優先關閉最上層 Modal 彈窗；關閉閒置 CLI 面板前新增防誤觸確認與「不再詢問」選項。',
        'en-US':
          '⌘W Modal Close & Pane Protection: ⌘W prioritizes closing open modals; closing idle panes includes a confirmation dialog with a "Don\'t ask again" option.',
      },
      {
        'zh-TW':
          '剪貼簿貼上防禦與逾時延長：延長 Paste ACK 逾時至 60 秒，避免 Agent 高負載輸出時誤報貼上遺失，精準區分逾時與真實傳輸中斷。',
        'en-US':
          'Paste Timeout Defense: extends paste ACK timeout to 60s to prevent false paste failure warnings during heavy terminal bursts.',
      },
      {
        'zh-TW':
          'Dev 與正式版全域隔離：Dev 模式主動保護正式版全域 Hooks 與日誌流，避免多實例搶佔端口與背景卡死。',
        'en-US':
          'Dev & Production Isolation: dev mode preserves production hooks and bounds startup scans so dev and production can run side-by-side without interference.',
      },
      {
        'zh-TW':
          'Manifest v2 外掛架構升級：支援 Combined 前後端外掛規範、發布者信任驗證、Shell Broker 與能力授權機制。',
        'en-US':
          'Manifest v2 Plugin Architecture: full support for combined frontend/backend plugins, publisher trust validation, and Shell Broker capability grants.',
      },
    ],
  },
  {
    version: '0.1.85',
    title: {
      'zh-TW': '外掛平台 Manifest v2 升級、發布者信任驗證與 Shell Broker 安全授權',
      'en-US': 'Manifest v2 Plugin Platform, Publisher Trust & Shell Broker Capability Grants',
    },
    highlights: [
      {
        'zh-TW':
          'Manifest v2 外掛架構：支援前後端組合（Combined）與後端專用外掛規範，外掛與主程式版本嚴格解耦。',
        'en-US':
          'Manifest v2 Plugin Platform: supports combined frontend/backend plugins and backend-only manifests decoupled from core versions.',
      },
      {
        'zh-TW':
          '發布者信任與能力授權：引進外掛發布者金鑰簽署與 Shell Broker 權限授權，確保外掛環境執行安全。',
        'en-US':
          'Publisher Trust & Capability Grants: introduces publisher signature checks and Shell Broker capability grants for hermetic plugin execution.',
      },
    ],
  },
  {
    version: '0.1.84',
    title: {
      'zh-TW': 'CLI 互傳訊息：投遞失敗回報、Claude Stop hook 直送、打字時暫緩投遞',
      'en-US': 'Inter-CLI Messaging: Delivery-Failure Notices, Claude Stop-Hook Hand-Over & Typing Hold',
    },
    highlights: [
      {
        'zh-TW':
          '投遞失敗回報：訊息送不到時，寄件 pane 會收到一則 `[Navide MSG] delivery failed` 系統通知，說明目標與原因。',
        'en-US':
          'Delivery-failure notices: when a message cannot be delivered, the sending pane receives a `[Navide MSG] delivery failed` notice naming the target and the reason.',
      },
      {
        'zh-TW':
          'Claude Stop hook 直送：Claude pane 回合結束時若有訊息在等，會直接經由 Stop hook 交給 agent 當下一步指令，完全不經過輸入框。',
        'en-US':
          'Claude Stop-hook hand-over: a message waiting for a Claude pane is handed to the agent as its next instruction when its turn ends, without ever touching the input box.',
      },
      {
        'zh-TW':
          '打字時暫緩投遞與整段貼上：目標 pane 有人在輸入時訊息會顯示為「輸入中」暫緩，注入一律以 bracketed paste 整段送入，不再打斷你打到一半的提示。',
        'en-US':
          'Typing hold & whole-paste injection: delivery waits while someone is typing in the target pane, and injections land as a single bracketed paste so a half-written prompt is never submitted with them.',
      },
      {
        'zh-TW':
          '訊息種類持久化與系統通知標章：訊息記錄面板會記住每則訊息的種類，系統通知重新載入後仍顯示「系統通知」標章。',
        'en-US':
          'Kind persistence & system-notice badge: the message log remembers each message\'s kind, so system notices keep their "system notice" badge across reloads.',
      },
    ],
  },
  {
    version: '0.1.83',
    title: {
      'zh-TW': '自訂快捷鍵編輯器、多面板批量拖曳與 CLI 提問狀態提示',
      'en-US': 'Custom Keybindings Editor, Multi-Pane Batch Dragging & QUESTION Status Badge',
    },
    highlights: [
      {
        'zh-TW':
          '自訂快捷鍵編輯器：重構全域快捷鍵系統並提供 Keybindings 編輯器，支援按鍵錄製、衝突偵測與一鍵恢復預設值。',
        'en-US':
          'Custom Keybindings Editor: overhauled keybinding engine with an interactive editor supporting live key recording, conflict detection, and default resets.',
      },
      {
        'zh-TW':
          '多面板批量拖曳與 Drop 貼上：支援 Shift 多選面板批量拖曳與 Ghost 懸浮圖示，可一次性拖入終端機貼上批量 @mention 標籤。',
        'en-US':
          'Multi-pane batch dragging & dropping: Shift-select multiple agent panes to drag with a ghost image and drop all @mention tags into terminals at once.',
      },
      {
        'zh-TW':
          'CLI 提問 QUESTION 標章與通訊優化：Agent 在終端等待提問回答時自動切換為橙色 QUESTION 標章，並優化 Agent 跨工作區通訊與訊息日誌持久化。',
        'en-US':
          'QUESTION badge & agent messaging: displays an orange QUESTION badge when an agent awaits input, with persistent agent message logging across workspaces.',
      },
    ],
  },
  {
    version: '0.1.82',
    title: {
      'zh-TW': 'Agents 側邊欄分頁獨立、未註冊帳號自動歸併與 Git Unstage 容錯優化',
      'en-US': 'Dedicated Agents sidebar tab, automatic account registration/deduplication & resilient Git unstage',
    },
    highlights: [
      {
        'zh-TW':
          'Agents 側邊欄分頁獨立：將代理人列表獨立為標籤分頁（⌘1 Agents、⌘2 Pipeline、⌘3 Explorer、⌘4 Git、⌘5 Plans），享有全高度獨佔捲動空間。',
        'en-US':
          'Dedicated Agents sidebar tab: split the agents list into its own tab (⌘1 Agents, ⌘2 Pipeline, ⌘3 Explorer, ⌘4 Git, ⌘5 Plans) with full-height scrollable space.',
      },
      {
        'zh-TW':
          '帳號自動註冊與重複去重：偵測到本機外部 CLI 登入自動建立 Profile 進行管理，並對同信箱多重登入自動去重歸併，保持選單簡潔。',
        'en-US':
          'Automatic account registration & deduplication: automatically creates profiles for new CLI logins and folds duplicate same-email credentials into single profiles.',
      },
      {
        'zh-TW':
          'Plan MCP 鑑權與 Git Unstage 容錯：Plan MCP 服務加入 Token 安全鑑權；Git 面板取消暫存（Unstage）自動過濾過期路徑並進行容錯重試。',
        'en-US':
          'Plan MCP auth & resilient Git unstage: added token security for Plan MCP server and auto-filtered stale pathspec retries on Git unstage actions.',
      },
    ],
  },
  {
    version: '0.1.81',
    title: {
      'zh-TW': '外部 CLI 憑證自動監控同步、Terminal 滾動無痕狀態與 Meta Muse Code Agent 支援',
      'en-US': 'Automatic credential sync watcher, smooth terminal scroll activity & Meta Muse Code CLI support',
    },
    highlights: [
      {
        'zh-TW':
          '外部 CLI 憑證自動監控同步：新增背景 Credential Watcher 服務，本機外部 CLI 登入或 Token 變更時自動同步寫入 Vault 快取與帳號切換面板。',
        'en-US':
          'Automatic credential sync watcher: added a background Credential Watcher service that syncs external CLI login changes into the profile vault and account switcher instantly.',
      },
      {
        'zh-TW':
          'Terminal 滾動活動時間繼承：優化終端機滾動狀態，長滾動期間活動時間戳記自動繼承，防止查看歷史紀錄時 RUNNING 狀態標籤誤閃為 IDLE。',
        'en-US':
          'Smooth terminal scroll activity: activity timestamps carry forward during sustained scrolling, preventing the RUNNING badge from flickering to IDLE while browsing history.',
      },
      {
        'zh-TW':
          'Meta Muse Code Agent 支援：新增對 Meta Muse Code CLI Agent 的選單支援、啟動與安裝檢測，並完備 CLI Vendor 開發手冊。',
        'en-US':
          'Meta Muse Code Agent support: added menu options, spawn detection, and installer checks for the Meta Muse Code CLI agent.',
      },
    ],
  },
  {
    version: '0.1.80',
    title: {
      'zh-TW': 'LLM 智慧 Pane 命名、Copilot/Qwen Hooks 路由與 WebGL 終端加速',
      'en-US': 'LLM-assisted Pane Naming, Copilot/Qwen Hooks & WebGL Terminal Acceleration',
    },
    highlights: [
      {
        'zh-TW':
          'LLM 智慧標題命名與平滑升級：首回合對話完成後自動請求本地模型生成高適配性 Pane 標題，並在不干擾使用者自訂命名的前提下平滑升級面板名稱。',
        'en-US':
          'LLM-assisted pane naming: automatically generates relevant pane titles using local models after the first turn and smoothly upgrades panel labels without overwriting custom renames.',
      },
      {
        'zh-TW':
          'Copilot / Qwen Hooks 路由與 Plan MCP 隔離：新增 Copilot 與 Qwen CLI 專屬 Hook 路由 Endpoint；Plan MCP Server 支援獨立目錄隔離與權限保護。',
        'en-US':
          'Copilot/Qwen CLI hooks & Plan MCP isolation: added dedicated hook endpoint routes for Copilot and Qwen CLI; isolated Plan MCP server homes with permission security.',
      },
      {
        'zh-TW':
          'WebGL 終端渲染加速與輸入緩衝：Terminal 支援 WebGL 硬體加速渲染，並新增 prepareGate 輸入緩衝防護，防止啟動準備階段丟失輸入按鍵。',
        'en-US':
          'WebGL terminal acceleration & input buffering: enabled WebGL hardware-accelerated rendering in Terminal with prepareGate input buffering during pane startup.',
      },
    ],
  },
  {
    version: '0.1.79',
    title: {
      'zh-TW': '剪貼簿圖片貼上轉檔、拖曳路徑轉義優化與 Agent 總覽詳情面板',
      'en-US': 'Clipboard image-to-file paste, escaped drop paths & Agent Overview panel',
    },
    highlights: [
      {
        'zh-TW':
          '剪貼簿截圖與拖曳路徑轉義：⌘V 貼上剪貼簿截圖自動寫入實體檔（`userData/dropped-files/`）；拖曳檔案自動使用斜線轉義格式，便於 CLI Agent 直接掃描識別。',
        'en-US':
          'Clipboard screenshot paste & escaped drop paths: ⌘V pasting a screenshot saves a real image file under `userData/dropped-files/`; dragged paths use backslash escaping for instant CLI agent scanning.',
      },
      {
        'zh-TW':
          'Agent 狀態總覽與狀態列面板互斥：新增 Agent 總覽面板 (`AgentOverviewPanel`) 與時間詳情面板 (`ClockPanel`)，狀態列 Popover 具備互斥開啟機制，且 UsageBadge 支援 Esc/Blur 自動關閉防護。',
        'en-US':
          'Agent Overview & status-bar popover management: added AgentOverviewPanel and ClockPanel, mutually exclusive status-bar popovers, and Esc/blur auto-dismissal for UsageBadge.',
      },
      {
        'zh-TW':
          '對話記錄保護與重連 Session 標題繼承：修復從 Claude/Grok 環境啟動 Navide 時對話紀錄遺失問題，並在恢復舊 Session 時自動繼承面板 `auto_name` 標籤。',
        'en-US':
          'Transcript protection & session auto-name inheritance: fixed transcript loss when launching inside Claude/Grok environments, and carried `auto_name` labels on session resumes.',
      },
    ],
  },
  {
    version: '0.1.78',
    title: {
      'zh-TW': '對話記錄遺失修復、跨工作區訊息持久化與 CLI 後端一家一檔重構',
      'en-US': 'Transcript-loss fix, cross-workspace message persistence & per-vendor CLI backend',
    },
    highlights: [
      {
        'zh-TW':
          '修復無聲對話遺失：從 Claude Code 環境裡啟動 Navide 時，pane 會繼承子 session 標記而靜默停寫對話記錄，重啟後 pane 變空白。後端現於啟動時剝除該標記（並防禦 Grok 同型標記），對話記錄保證落盤。',
        'en-US':
          'Fixed silent transcript loss: launching Navide from inside a Claude Code environment made panes inherit a child-session marker and silently stop writing transcripts (blank panes after restart). The backend now strips the marker at startup (plus Grok’s equivalents), so transcripts always persist.',
      },
      {
        'zh-TW':
          '跨工作區 CLI 訊息升級：訊息紀錄改用 SQLite v2 結構持久化、跨工作區外送追蹤與重連補水，並新增狀態列公告面板與版本/時鐘顯示。',
        'en-US':
          'Cross-workspace CLI messaging upgrade: message logs persist in a SQLite v2 schema with outbound tracking and reconnect hydration, plus a new status-bar announcements panel and version/clock chips.',
      },
      {
        'zh-TW':
          '終端效能與架構整併：PTY 生命週期改用獨立執行緒池並一次汲取讀取緩衝（長輸出更順）；後端 CLI 程式碼完成「一家一檔」重構（12 家各自獨立模組 + 統一 registry），新增 CLI 支援從此只需一個檔案。',
        'en-US':
          'Terminal performance & architecture: PTY lifecycle moved to an isolated thread pool with drained reads (smoother long outputs); the CLI backend finished its one-file-per-vendor refactor (12 self-contained vendor modules + a single registry), so adding a CLI now takes one file.',
      },
    ],
  },
  {
    version: '0.1.77',
    title: {
      'zh-TW': '三方 Git 衝突解決面板、預設外部編輯器路由與 DebugModal 診斷視窗',
      'en-US': '3-way Git conflict resolution pane, default external editor routing & DebugModal diagnostics',
    },
    highlights: [
      {
        'zh-TW':
          '三方 Git 衝突視覺化解決與外掛相容：新增 ConflictPane 能直接讀取 Git Index 三方 Merge Stages，高亮標記衝突解決與即時切換，並完全對映給外掛與獨立編輯器視窗。',
        'en-US':
          '3-way Git conflict resolution & plugin compatibility: added ConflictPane with direct Git Index merge stages reading, highlight resolve actions, and full mapping to plugins and standalone windows.',
      },
      {
        'zh-TW':
          '預設外部編輯器與快速鍵操作提升：可選擇 VS Code / Cursor 等為預設外部編輯器並支援開啟專案資料夾；新增 Ctrl+Tab 面板切換與 ⌘⇧L 系統診斷工具 DebugModal。',
        'en-US':
          'Default external editor & keybindings overhaul: choose VS Code or Cursor as your default editor with Open Folder support; added Ctrl+Tab pane cycling and ⌘⇧L DebugModal diagnostics.',
      },
      {
        'zh-TW':
          'CLI 訊息傳遞擴充與自動退避防禦：補齊 Grok、Kimi、Pi、Qwen 的訊息轉發與 Copilot/OpenCode/Kilo 的 Plan MCP 自動掛載，並新增 CLI 停滯 (Stall) 退避與帳號切換快取保護。',
        'en-US':
          'Expanded CLI messaging & stall protection: added turn-text messaging for Grok, Kimi, Pi, Qwen and Plan MCP wiring for Copilot/OpenCode/Kilo, plus CLI stall backoff and parked account cache preservation.',
      },
    ],
  },
  {
    version: '0.1.76',
    title: {
      'zh-TW': 'Claude CLI 用量讀取優化、自動更新 Pipeline 與安穩關機保護',
      'en-US': 'Claude CLI usage panel integration, update pipeline UI & robust app shutdown',
    },
    highlights: [
      {
        'zh-TW':
          'Claude CLI 直接面板讀取與帳號容錯：改由直接驅動 Claude CLI 內建用量面板讀取額度，徹底避免輪詢時 Token 旋轉問題，並能自動偵測被本機清空的失效憑證。',
        'en-US':
          'Claude CLI panel scraping & credential resilience: directly reads usage from Claude CLI without rotating OAuth refresh tokens, with automatic detection of wiped credentials.',
      },
      {
        'zh-TW':
          '自動更新 Pipeline 視覺化與確認還原：新增「檢查 ➔ 下載 ➔ 安裝」三階段進度條，並在更新安裝異常或逾時時自動復原使用者設定的「關閉 App 確認」視窗。',
        'en-US':
          'Visual update pipeline & quit confirmation recovery: added 3-stage update pipeline indicators and restored quit confirmation dialogs when an install fails or times out.',
      },
      {
        'zh-TW':
          '依賴安裝連鎖鏈與 Terminal IME 輸入優化：CLI 安裝對話框支援自動接續連鎖安裝步驟，並優化 Terminal 在輸入法 (IME) 及視窗切換時的 Focus 清除與狀態復原。',
        'en-US':
          'Sequential dependency installer & Terminal IME focus fixes: automated multi-step CLI dependency installation and resolved focus/IME state leakage during terminal pane disposal.',
      },
    ],
  },
  {
    version: '0.1.75',
    title: {
      'zh-TW': '跨工作區 Agent 通訊與定址系統',
      'en-US': 'Cross-workspace Agent addressing & inter-agent messaging',
    },
    highlights: [
      {
        'zh-TW':
          '跨工作區 CLI 定址與 MCP 工具：發布跨工作區通訊註冊表，將 CLI 訊息傳送包裝為 MCP 工具，實現跨視窗、跨工作區 Agent 之間的無縫對話。',
        'en-US':
          'Cross-workspace CLI addressing & MCP tools: introduced a global addressing registry exposing inter-agent messaging as MCP tools for cross-window collaboration.',
      },
      {
        'zh-TW':
          '拖曳面板 @ 定址輸入：支援將遠端視窗或頁籤面板直接拖曳至 "@" 提及輸入框，自動帶入其全區目標位址。',
        'en-US':
          'Drag-to-mention @ addressing: drag any remote pane onto the "@" mention box to automatically insert its fully qualified address.',
      },
      {
        'zh-TW':
          '環境初始化與 Plan 加載強化：改善全新安裝時的依賴安裝順序與錯誤呈現，並優化 Plan 文件讀取的後端等待流程。',
        'en-US':
          'Onboarding & Plan loading fixes: refined dependency bootstrap ordering and plan document loading readiness.',
      },
    ],
  },
  {
    version: '0.1.74',
    title: {
      'zh-TW': 'Tasker 排程引擎與人性化 Cron 表達式文字',
      'en-US': 'Tasker scheduling engine & human-readable cron descriptions',
    },
    highlights: [
      {
        'zh-TW':
          'Cron 定時與循環任務：後端排程服務升級，支援 Cron 表達式定時觸發、單次與循環 Timer、以及 Max Iterations 最大執行次數限制。',
        'en-US':
          'Cron scheduling & recurring tasks: backend execution engine now supports cron expressions, one-shot/recurring timers, and max iteration bounds.',
      },
      {
        'zh-TW':
          'Tasker 控制介面：Tasker 面板新增直覺的 Cron 排程輸入框，動態顯示人性化中文/英文時間描述（例如「每 5 分鐘」）。',
        'en-US':
          'Tasker schedule UI: added intuitive cron controls with real-time human-readable time descriptions (e.g. "Every 5 minutes").',
      },
      {
        'zh-TW':
          '背景 Timer 邊界保護：強化背景排程 Timer 綁定與早期終止機制，確保逾時排程不佔用背景資源。',
        'en-US':
          'Protected background timers: hardened background timer binding and early termination to ensure idle schedules do not leak resources.',
      },
    ],
  },
  {
    version: '0.1.73',
    title: {
      'zh-TW': '模組化 CLI Agent 面板與互動能力全面升級',
      'en-US': 'Modular CLI Agent panel & interactive PTY capabilities',
    },
    highlights: [
      {
        'zh-TW':
          '全新 AiCliDock 面板：全面替換原本純文字 Chat 介面，為 mini-IDE、Git 與 Plans 外掛視窗帶入完全互動式、功能齊全的 CLI Agent 面板。',
        'en-US':
          'New AiCliDock panel: replaces legacy plain-text chat with a fully interactive CLI agent panel across mini-IDE, Git, and Plans windows.',
      },
      {
        'zh-TW':
          '外掛 PTY 互動能力管道：允許外掛視窗順暢呼叫互動式 PTY 能力，享受同主視窗級別的 Agent 互動與終端呈現。',
        'en-US':
          'Plugin PTY capability broker: pipes interactive PTY capabilities through the broker to grant plugin windows full main-window agent power.',
      },
      {
        'zh-TW':
          '後端架構輕量化：完全移除舊版 AI Chat 後端介面，專注於高效能、高穩定的原生 CLI Agent Engine。',
        'en-US':
          'Lightweight backend architecture: retired legacy AI chat backend surfaces to focus on high-performance native CLI agent engines.',
      },
    ],
  },
  {
    version: '0.1.72',
    title: {
      'zh-TW': '獨立視窗 AI 面板整合與極速終端回應',
      'en-US': 'Embedded AI chat in standalone windows & ultra-fast terminal response',
    },
    highlights: [
      {
        'zh-TW':
          '獨立視窗內建 AI Chat 面板：Git 與 Plan 獨立視窗全新整合 AI Chat 右側面板，並支援直接拖曳（Drag & Drop）Git 變更檔案列至終端機。',
        'en-US':
          'Embedded AI Chat in standalone windows: Git & Plan windows now feature an embedded AI Chat panel and support dragging file rows to terminals.',
      },
      {
        'zh-TW':
          'Git 視窗 Editorial Calm 介面重構：採用雜誌感簡潔視覺設計與折疊卡片排版，大幅提升工作區狀態與 Diff 閱讀舒適度。',
        'en-US':
          'Git window Editorial Calm redesign: fresh magazine-style layout and collapsible cards for cleaner working tree and diff reading.',
      },
      {
        'zh-TW':
          '終端機打字延遲大幅降低：優化 CLI 高速輸出時的輸入快取機制，打字回應與動態渲染更加順暢無卡頓。',
        'en-US':
          'Reduced typing latency: optimized input caching during heavy CLI streaming for smoother typing and dynamic rendering.',
      },
    ],
  },
  {
    version: '0.1.71',
    title: {
      'zh-TW': '終端隱藏頁籤渲染優化與 AI Chat CLI 引擎',
      'en-US': 'Hidden terminal tab rendering & CLI-driven AI chat',
    },
    highlights: [
      {
        'zh-TW':
          '隱藏頁籤終端尺寸快取：快取並持久化 Terminal 最佳行列尺寸，解決背景或開機還原時啟動 PTY 輸出繪製過窄且無法拉寬的問題。',
        'en-US':
          'Hidden terminal dimension caching: persists terminal dimensions so background PTYs start at realistic layout widths instead of narrow defaults.',
      },
      {
        'zh-TW':
          'AI Chat 改由 CLI 驅動：AI 聊天視窗改由底層 CLI Engine 驅動，大幅提升回應速度、並能自動回收僵死或孤兒 subprocess。',
        'en-US':
          'CLI-driven AI Chat: AI chat frontend now runs on the native CLI engine for higher stability, automatic orphan cleanup, and better resilience.',
      },
      {
        'zh-TW':
          'Git 獨立視窗與體驗改善：重構 Git 獨立視窗側邊欄為折疊卡片介面，修復 Cmd+C 終端複製、右鍵選取菜單與 Mouse-tracking 拖曳選取。',
        'en-US':
          'Git window & terminal UX: reworked Git window sidebar into collapsible cards, fixed Cmd+C terminal copying, context menu, and mouse text selection.',
      },
    ],
  },
  {
    version: '0.1.70',
    title: {
      'zh-TW': '多帳號憑證管理與系統穩定度提升',
      'en-US': 'Multi-account credentials & stability improvements',
    },
    highlights: [
      {
        'zh-TW':
          '多帳號憑證整合：CLI 憑證統一保管於真實 Home 目錄，支援帳號快速 Swap 切換，Codex 登入憑證自動提升至全域共享。',
        'en-US':
          'Unified multi-account credentials: CLI auth files now live in your real home directory with instant swap switching, and Codex logins auto-promote to shared auth.',
      },
      {
        'zh-TW':
          'CLI 重建安全防護：針對執行中的 CLI 按下 Rebuild/重構時增加二次確認彈窗，防止誤觸致使工作中 Task 中斷。',
        'en-US':
          'Safer CLI rebuilds: a confirmation dialog now protects running CLIs from accidental rebuilds while tasks are active.',
      },
      {
        'zh-TW':
          '獨立 Git 視窗與新手安裝優化：修復獨立 Git 視窗追蹤細節，並確保全新安裝時環境依賴檢測與自動安裝順暢完成。',
        'en-US':
          'Git window & onboarding fixes: refined follow-up interactions in standalone Git windows and hardened onboarding dependency setup.',
      },
    ],
  },
  {
    version: '0.1.69',
    title: {
      'zh-TW': '更新檢查更即時、滾輪捲動不再誤鎖 RUNNING 狀態',
      'en-US': 'More responsive update checks & scroll no longer latches the RUNNING badge',
    },
    highlights: [
      {
        'zh-TW':
          '自動更新檢查間隔由較長週期縮短為 30 分鐘，且開啟「自動檢查」時立刻重新檢查一次，不必等下一輪。',
        'en-US':
          'Background update checks now run every 30 minutes, and enabling auto-check re-checks immediately instead of waiting for the next cycle.',
      },
      {
        'zh-TW': '終端轉發的滾輪捲動不再被當成活動訊號，瀏覽歷史時 RUNNING 標籤不會被鎖住。',
        'en-US':
          'Wheel scrolls forwarded to the terminal no longer count as activity, so browsing history keeps the RUNNING badge from latching on.',
      },
      {
        'zh-TW': 'Agent 歷史載入時，對已無對應 pane 的項目補上移除時間戳，時間欄位不再空白。',
        'en-US':
          'Agent History stamps a removal time on load for entries with no live pane, so their timestamp column is no longer blank.',
      },
    ],
  },
  {
    version: '0.1.68',
    title: {
      'zh-TW': '儲存架構升級：更快、更可靠',
      'en-US': 'Storage upgrade: faster and more reliable',
    },
    highlights: [
      {
        'zh-TW':
          '你的設定、token 用量與工作區資料已自動搬入資料庫（SQLite）。搬移在首次啟動時自動完成，所有資料原樣保留，無需任何操作。',
        'en-US':
          'Your settings, token usage and workspace data now live in a database (SQLite). The move happens automatically on first launch — everything is preserved, nothing to do.',
      },
      {
        'zh-TW':
          '大幅降低磁碟寫入：token 記帳從每 10 秒重寫一份大檔，改為只寫入變動的部分（約 30 倍減少）。',
        'en-US':
          'Far less disk churn: token accounting now writes only what changed instead of rewriting a large file every 10 seconds (~30x less I/O).',
      },
      {
        'zh-TW':
          '舊的 JSON 檔案會保留為 *.migrated-v1 備份，不會被刪除。',
        'en-US':
          'Your old JSON files are kept as *.migrated-v1 backups — nothing is deleted.',
      },
    ],
    note: {
      'zh-TW':
        '注意：若你之後改回安裝舊版本，App 會像全新安裝一樣看不到既有資料（資料並未消失——把 *.migrated-v1 檔案改回原名即可還原）。',
      'en-US':
        'Note: if you later downgrade to an older version, the app will look freshly installed (your data is not lost — rename the *.migrated-v1 files back to restore it).',
    },
  },
  {
    version: '0.1.67',
    title: {
      'zh-TW': '儲存空間監控與安全清理、Claude 憑證跨目錄複製修復與終端效能調校',
      'en-US': 'Storage monitor with guarded cleanup, Claude credential fix & terminal performance',
    },
    highlights: [
      {
        'zh-TW':
          '設定新增 Storage 分頁：檢視各項資料佔用的空間並進行清理，清理只會動它能證明無人使用的資料（Codex pane home 等），live 資料受保護。',
        'en-US':
          'New Storage tab in Settings: see what is using disk and reclaim it. Cleanup only offers data it can prove no pane still references (stale Codex pane homes and the like) — live data is protected.',
      },
      {
        'zh-TW':
          '憑證修復：停止跨 config 目錄複製 Claude token（切帳號後舊 pane 顯示 Login expired 的根因），改由該 Profile 自己的 home 讀取登入狀態；aider 每個 pane 也有各自的對話歷史檔。',
        'en-US':
          'Credential fixes: stopped copying Claude tokens across config dirs (the root cause of “Login expired” on older panes after an account switch) and read a managed profile’s login from its own home; aider panes now get their own chat-history file.',
      },
      {
        'zh-TW':
          '終端與效能：修復 RUNNING 標籤中途誤閃 idle、localStorage 滿時靜默丟失 scrollback、--resume 產生的重複 PTY；PTY 每次喚醒改讀整個 viewport，token 匯入改為五分鐘合併並只追加變動日誌。',
        'en-US':
          'Terminal & performance: fixed the RUNNING badge flickering to idle mid-task, scrollback silently dropped when localStorage is full, and the duplicate PTY a --resume spawn left behind; PTY wakeups now repaint a whole viewport and token ingestion coalesces into a five-minute window with an append-only delta log.',
      },
    ],
  },
  {
    version: '0.1.66',
    title: {
      'zh-TW': '多家 CLI 額度偵測、帳號切換器餘額顯示與 Agent SPAWN 開面板',
      'en-US': 'Quota detection for more CLIs, per-account remaining quota & agent SPAWN blocks',
    },
    highlights: [
      {
        'zh-TW':
          '額度偵測擴充至 opencode、qwen、kilo、pi、copilot、cursor 等供應商，帳號切換器直接顯示每個帳號的剩餘額度。',
        'en-US':
          'Quota fetchers added for opencode, qwen, kilo, pi, copilot and cursor, with each account’s remaining quota shown right in the account switcher.',
      },
      {
        'zh-TW': 'CLI Agent 可用 SPAWN 區塊直接開出新的 CLI 面板，把工作交給另一個 agent。',
        'en-US':
          'CLI agents can open new CLI panes themselves via SPAWN blocks, handing work off to another agent.',
      },
      {
        'zh-TW':
          'CLI 還原可設定為延遲載入（開啟時才起 CLI）；Claude Profile Home 改以執行中狀態優先播種，避免舊快照覆蓋剛刷新的 token。',
        'en-US':
          'CLI restore can be configured to load lazily (a CLI starts when you open it), and Claude profile homes seed runtime-first so an old snapshot can no longer overwrite a freshly refreshed token.',
      },
    ],
  },
  {
    version: '0.1.65',
    title: {
      'zh-TW': '我們更名為「Navide」',
      'en-US': 'We’re now “Navide”',
    },
    highlights: [
      {
        'zh-TW':
          '應用程式已從「Navide (Agent-Team)」更名為「Navide」。這是同一個 App，你的資料與設定都不受影響。',
        'en-US':
          'The app was renamed from “Navide (Agent-Team)” to “Navide”. It’s the same app — your data and settings are untouched.',
      },
      {
        'zh-TW': 'macOS 自動更新已修復（先前一個打包問題會讓更新失敗）。',
        'en-US':
          'macOS auto-update now installs correctly — a packaging issue that broke updates has been fixed.',
      },
    ],
    note: {
      'zh-TW':
        '若這次更新後 App 沒有自動重新開啟，請從「應用程式」再開一次即可；之後的更新會自動重啟。',
      'en-US':
        'If the app didn’t reopen by itself after this update, just launch it again from Applications — future updates relaunch automatically.',
    },
  },
]

/** The announcement authored for a specific version, if any. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((entry) => entry.version === version)
}

/** Compare two X.Y.Z versions. An empty/blank string sorts as the oldest. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The announcement to show on startup: the newest entry the user hasn't seen
 * yet whose version has actually shipped (i.e. seenVersion < entry.version <=
 * currentVersion). This lets an announcement be authored under the version the
 * change happened in — it still fires for anyone whose update jumps past it,
 * even though the module itself only ships from the next release on. Returns
 * null when there is nothing to show.
 */
export function pickWhatsNew(
  currentVersion: string,
  seenVersion: string,
): WhatsNewEntry | null {
  if (!currentVersion) return null
  const unseen = WHATS_NEW.filter(
    (entry) =>
      cmpSemver(entry.version, seenVersion) > 0 &&
      cmpSemver(entry.version, currentVersion) <= 0,
  )
  if (unseen.length === 0) return null
  return unseen.reduce((newest, entry) =>
    cmpSemver(entry.version, newest.version) > 0 ? entry : newest,
  )
}

/**
 * The entry Help → What's New reopens. A shipped build reopens the newest one
 * it is running (seen or not); a dev build runs the last released version
 * from package.json while the notes for the next one are being written, so
 * it reopens the newest entry authored — that is the one being tried out.
 */
export function pickWhatsNewOnDemand(currentVersion: string, dev: boolean): WhatsNewEntry | null {
  if (dev) return pickWhatsNew('999999.0.0', '')
  return pickWhatsNew(currentVersion, '')
}

/** Resolve localized text, falling back to the default locale then en-US. */
export function pickText(text: WhatsNewText, locale: string): string {
  return (
    (text as Record<string, string>)[locale] ?? text['zh-TW'] ?? text['en-US'] ?? ''
  )
}
