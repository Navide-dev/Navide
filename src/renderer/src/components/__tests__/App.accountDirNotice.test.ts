// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A claude pane pinned to an account dir that Windows could not link, or whose
// saved conversation was not reachable there (the backend then started a new
// one with a handoff prompt). App.vue cannot be mounted by this suite, so its
// wiring is asserted against the source like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const localesDir = resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales')
const LOCALES = ['de-DE', 'en-US', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR', 'pt-BR', 'ru-RU', 'vi-VN', 'zh-CN', 'zh-TW']

function handler(): string {
  const start = appSource.indexOf("backend.on('claude.account_dir_notice'")
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n})\n', start))
}

describe('claude.account_dir_notice', () => {
  it('makes the pane adopt the new session, as a restored pane does', () => {
    expect(handler()).toMatch(/if \(ev\.resume_fallback_session_id\) \{\s*if \(pane\) markResumeFallback\(pane, ev\.resume_fallback_session_id\)/)
    // The restore branch of the attribution handler is what replaces the pin.
    expect(appSource).toMatch(/if \(pane\.pinnedFromRestore\) \{\s*pane\.pinnedFromRestore = undefined\s*if \(pane\.pinnedSessionId !== attributedId\) adopt\(\)/)
  })

  it('toasts the resume fallback only when the backend names one', () => {
    expect(handler()).toMatch(/if \(ev\.resume_fallback_session_id\) \{\s*if \(pane\) markResumeFallback\(pane, ev\.resume_fallback_session_id\)\s*notifyRestore\.toast\(\s*i18n\.global\.t\('cli-account-dir\.resume-fallback'/)
  })

  it('toasts the Developer Mode hint only for unshared entries', () => {
    expect(handler()).toMatch(/if \(\(ev\.unshared \?\? \[\]\)\.length > 0\) \{\s*notifyRestore\.toast\(\s*i18n\.global\.t\('cli-account-dir\.links-unavailable'/)
  })

  it.each(LOCALES)('%s has both sentences with the label', (locale) => {
    const messages = JSON.parse(readFileSync(resolve(localesDir, `${locale}.json`), 'utf8'))
    for (const key of ['links-unavailable', 'resume-fallback']) {
      expect(messages['cli-account-dir'][key]).toContain('{label}')
    }
  })
})
