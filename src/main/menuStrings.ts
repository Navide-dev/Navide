import { LEGAL_LABELS } from '../shared/legalLinks'
import type { LegalRoute } from '../shared/legalLinks'
import type { SupportedLocale } from './hostLocale'

/**
 * Native application-menu strings, one table per supported locale.
 *
 * Main has no i18n of its own and cannot borrow the renderer's: vue-i18n needs
 * `navigator.language` and the settings cache, neither of which exists here,
 * `tsconfig.node.json` does not list `packages/plugin-ui` (a composite project
 * rejects an import from outside its file list), and the locale JSONs are
 * hundreds of KB each — a heavy price for the two dozen strings below, none of which
 * have a key over there anyway.
 *
 * The wording is not invented where the renderer already settled on one, so
 * the same action reads the same in both surfaces:
 *   Copy → action.copy, Settings… → action.settings,
 *   New Window → settings.keybindings.cmd.workbench_action_newWindow,
 *   Reload Window → settings.keybindings.cmd.workbench_action_reloadWindow,
 *   Pipeline Manager → label.pipeline-manager, Resource Manager → resource.title,
 *   Turn Stats → turn-stats.title, Privacy → settings.p2p.legal-privacy,
 *   Boundaries → settings.p2p.legal-boundaries.
 *
 * Items carrying an Electron `role` are absent on purpose. Their labels come
 * from Chromium in the SYSTEM locale, and Electron has no API to re-localize
 * them — so on an English system a zh-TW menu reads as a mix, which is the
 * accepted cost of leaving Undo/Cut/Paste/Quit worded the way every other app
 * on that machine words them.
 */
export interface MenuStrings {
  file: string
  edit: string
  view: string
  window: string
  copy: string
  settings: string
  checkUpdates: string
  newWindow: string
  openWorkspace: string
  openRecent: string
  noRecentWorkspaces: string
  pickWorkspace: string
  useFolder: string
  createWorkspace: string
  workspaceName: string
  create: string
  reloadWindow: string
  pipelineManager: string
  resourceManager: string
  turnStats: string
  tokenMonitor: string
  repo: string
  reportIssue: string
  shortcuts: string
  whatsNew: string
  welcomeTour: string
  legal: Record<LegalRoute, string>
}

export const MENU_STRINGS: Record<SupportedLocale, MenuStrings> = {
  'en-US': {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    copy: 'Copy',
    settings: 'Settings…',
    checkUpdates: 'Check for Updates…',
    newWindow: 'New Window',
    openWorkspace: 'Open Workspace…',
    openRecent: 'Open Recent',
    noRecentWorkspaces: 'No Recent Workspaces',
    pickWorkspace: 'Pick workspace folder',
    useFolder: 'Use this folder',
    createWorkspace: 'Create workspace folder',
    workspaceName: 'Workspace name:',
    create: 'Create',
    reloadWindow: 'Reload Window',
    pipelineManager: 'Pipeline Manager',
    resourceManager: 'Resource Manager',
    turnStats: 'Turn Stats',
    tokenMonitor: 'Token Monitor',
    repo: 'Navide on GitHub',
    reportIssue: 'Report an Issue…',
    shortcuts: 'Keyboard Shortcuts',
    whatsNew: 'What’s New…',
    welcomeTour: 'First-Run Tour…',
    // The legal table is the one place those titles are written; English reads
    // them straight from it rather than keeping a second copy in step.
    legal: LEGAL_LABELS
  },
  'ja-JP': {
    file: 'ファイル',
    edit: '編集',
    view: '表示',
    window: 'ウィンドウ',
    copy: 'コピー',
    settings: '設定…',
    checkUpdates: 'アップデートを確認…',
    newWindow: '新しいウィンドウ',
    openWorkspace: 'ワークスペースを開く…',
    openRecent: '最近使用した項目を開く',
    noRecentWorkspaces: '最近使用したワークスペースはありません',
    pickWorkspace: 'ワークスペースのフォルダーを選択',
    useFolder: 'このフォルダーを使用',
    createWorkspace: 'ワークスペースのフォルダーを作成',
    workspaceName: 'ワークスペース名：',
    create: '作成',
    reloadWindow: 'ウィンドウを再読み込み',
    pipelineManager: 'パイプライン管理',
    resourceManager: 'リソース管理',
    turnStats: 'ターン別使用量',
    tokenMonitor: 'トークンモニター',
    repo: 'GitHub で Navide を見る',
    reportIssue: '問題を報告…',
    shortcuts: 'キーボードショートカット',
    whatsNew: '新機能…',
    welcomeTour: 'はじめてのツアー…',
    legal: {
      privacy: 'プライバシー',
      security: 'セキュリティポリシー',
      'code-of-conduct': '行動規範',
      boundaries: '利用上の制限',
      licenses: 'ライセンス',
      legal: '法的情報'
    }
  },
  'zh-TW': {
    file: '檔案',
    edit: '編輯',
    view: '檢視',
    window: '視窗',
    copy: '複製',
    settings: '設定…',
    checkUpdates: '檢查更新…',
    newWindow: '開新視窗',
    openWorkspace: '開啟工作區…',
    openRecent: '開啟最近使用',
    noRecentWorkspaces: '沒有最近使用的工作區',
    pickWorkspace: '選擇工作區資料夾',
    useFolder: '使用此資料夾',
    createWorkspace: '建立工作區資料夾',
    workspaceName: '工作區名稱：',
    create: '建立',
    reloadWindow: '重新載入視窗',
    pipelineManager: '流程管理',
    resourceManager: '資源控管',
    turnStats: '每輪消耗',
    tokenMonitor: 'Token 監看',
    repo: '在 GitHub 上的 Navide',
    reportIssue: '回報問題…',
    shortcuts: '鍵盤快捷鍵',
    whatsNew: '新版更新…',
    welcomeTour: '首次使用導覽…',
    // The pages themselves are served in English; these label the entrance,
    // not the destination's language, and Settings already says 隱私權 for the
    // same link — a menu reading "Privacy" next to it is the real mismatch.
    legal: {
      privacy: '隱私權',
      security: '安全性政策',
      'code-of-conduct': '行為準則',
      boundaries: '使用界線',
      licenses: '授權條款',
      legal: '法律資訊'
    }
  }
}
