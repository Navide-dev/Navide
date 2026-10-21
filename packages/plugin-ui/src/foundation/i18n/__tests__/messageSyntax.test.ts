import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'

// vue-i18n reads | as a plural separator, { } as a placeholder and @ as a
// linked message, so a literal one has to be written {'|'}, {'{'} or {'@'}.
// Left bare, `curl | sh` turned guard.policy.levels into a two-case plural and
// the Security page showed only the text before the pipe.
const localeDirs = [
  'packages/plugin-ui/src/foundation/i18n/locales',
  'plugins/navide-plans/src/locales',
  'plugins/navide-browser/src/locales'
]
const LOCALES = ['en-US', 'zh-TW', 'ja-JP'] as const

// Keys that are meant to be plurals (called with a count).
const PLURAL_KEYS = [
  'plans.share.days',
  'settings.credentials.banner-high',
  'settings.cliAgents.chip.accounts',
  'time.ago-minutes',
  'time.ago-hours',
  'time.ago-days',
  'time.ago-months',
  'pipelineEditor.lane.more',
  'editorWindow.problems.errors',
  'editorWindow.problems.warnings',
  'git.branch-diff.file-count',
  'git.branch-diff.hidden-lines'
]

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function load(dir: string, locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'))
}

describe('locale message syntax', () => {
  for (const dir of localeDirs) {
    it.each(LOCALES)(`${dir}/%s has no accidental plurals`, (locale) => {
      // Outside a {…} placeholder every | splits the message into plural cases.
      const plurals = leaves(load(dir, locale))
        .filter(([, text]) => text.replace(/\{[^{}]*\}/g, '').includes('|'))
        .map(([key]) => key)
        .filter((key) => !PLURAL_KEYS.includes(key))
      expect(plurals, `unescaped | in: ${plurals.join(', ')}`).toEqual([])
    })
  }

  it.each(LOCALES)('renders guard.policy.levels in %s with the literal curl | sh', (locale) => {
    const messages = load(localeDirs[0], locale)
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } as Record<string, Record<string, string>> })
    // The full message tree is too deep for vue-i18n's key typing (TS2589).
    const { t } = i18n.global as unknown as { t: (key: string) => string }
    const text = t('guard.policy.levels')
    expect(text).toContain('curl | sh')
    expect(text).toContain('rm -rf')
  })
})
