import { hostStrings, type HostStringTable, type SupportedLocale } from './hostLocale'

/**
 * Main-process text for agents using Navide plugin web views. Main has no
 * i18n of its own (see menuStrings.ts); the place names follow the renderer's
 * settings.nav.extensions and settings.nav.executionPolicy, and the glossary.
 */

const POLICY: HostStringTable<{ allowlist: string; denylist: string }> = {
  'en-US': {
    allowlist: 'Your agent Execution Policy allowlist does not include web. Add web in Settings → Navide Plugins → Execution Policy.',
    denylist: 'Your agent Execution Policy is a denylist, which never allows web. Use an allowlist that includes web in Settings → Navide Plugins → Execution Policy.',
  },
  'zh-TW': {
    allowlist: '你的 agent 執行政策 allowlist 沒有包含 web，請到「設定 → Navide 外掛 → 執行政策」加入 web。',
    denylist: '你的 agent 執行政策是 denylist，denylist 一律不允許 web。請到「設定 → Navide 外掛 → 執行政策」改用包含 web 的 allowlist。',
  },
  'ja-JP': {
    allowlist: 'agent の実行ポリシーの allowlist に web が含まれていません。「設定 → Navide プラグイン → 実行ポリシー」で web を追加してください。',
    denylist: 'agent の実行ポリシーは denylist のため、web は常に許可されません。「設定 → Navide プラグイン → 実行ポリシー」で web を含む allowlist を使ってください。',
  },
}

/** Why an agent call that needs `web` was refused by the user's own policy. */
export function webPolicyDeniedMessage(locale: SupportedLocale, mode: 'allowlist' | 'denylist'): string {
  return hostStrings(POLICY, locale)[mode]
}

interface WritePromptStrings {
  title: string
  message: (tool: string, name: string, version: string) => string
  origin: string
  buttons: [string, string]
}

const WRITE_PROMPT: HostStringTable<WritePromptStrings> = {
  'en-US': {
    title: 'Agent wants to use web pages',
    message: (tool, name, version) =>
      `An agent asked to use ${tool} of ${name} ${version}, which operates web pages (clicks, types, submits). Allow agents to do this in this workspace?`,
    origin: 'The agent, not you, started this. You are asked again after an update or a new permission.',
    buttons: ['Don\'t allow', 'Allow'],
  },
  'zh-TW': {
    title: 'Agent 要操作網頁',
    message: (tool, name, version) =>
      `有 agent 要使用 ${name} ${version} 的 ${tool}，這會操作網頁（點擊、輸入、送出）。要允許 agent 在這個 workspace 這樣做嗎？`,
    origin: '這是 agent 發起的，不是你。更新或新增權限後會再問一次。',
    buttons: ['不允許', '允許'],
  },
  'ja-JP': {
    title: 'agent が Web ページを操作しようとしています',
    message: (tool, name, version) =>
      `agent が ${name} ${version} の ${tool} を使おうとしています。これは Web ページを操作します（クリック、入力、送信）。この workspace で agent に許可しますか？`,
    origin: 'これはあなたではなく agent が開始しました。更新や新しい権限の後に再度確認します。',
    buttons: ['許可しない', '許可'],
  },
}

/** The DB3 first-write question for a Navide plugin whose tools drive web
 *  pages rather than change files. `tool` is already display-safe. */
export function webAgentWritePrompt(
  locale: SupportedLocale,
  tool: string,
  name: string,
  version: string,
): { title: string; message: string; origin: string; buttons: [string, string] } {
  const strings = hostStrings(WRITE_PROMPT, locale)
  return {
    title: strings.title,
    message: strings.message(tool, name, version),
    origin: strings.origin,
    buttons: strings.buttons,
  }
}
