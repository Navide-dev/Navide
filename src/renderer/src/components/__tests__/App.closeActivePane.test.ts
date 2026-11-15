// @vitest-environment happy-dom
// ⌘W in the main window closes the focused CLI pane, after confirming.
//
// The key was dead here until now: closeActiveEditor guards on `editorOpen`,
// which this window never sets, so the main window had ⌘⇧W (close the window)
// and nothing for the tier below it. Closing a pane was not even a command —
// only the ✕ button and the context menu reached onKill.
//
// Mounting App starts backend, terminal, settings and onboarding lifecycles, so
// these stay narrow source-text assertions like the other App tests. The rule
// routing is covered behaviourally in keybindings/__tests__/keyResolver.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

const closeFn = appSource.slice(
  appSource.indexOf('async function closeFocusedPane'),
  appSource.indexOf('async function onKill')
)

describe('App ⌘W closes the focused pane', () => {
  it('registers the command and routes it through closeFocusedPane', () => {
    expect(appSource).toContain("registerCommand('workbench.action.closeActivePane'")
    expect(appSource).toContain('return closeFocusedPane(paneId)')
  })

  it('declines when no pane has focus, leaving the keystroke alone', () => {
    // `false` is the dispatcher's not-handled signal: it skips preventDefault so
    // nothing downstream loses the key.
    const handler = appSource.slice(
      appSource.indexOf("registerCommand('workbench.action.closeActivePane'"),
      appSource.indexOf("registerCommand('workbench.action.openSettings'")
    )
    expect(handler).toContain('const paneId = focusPaneId.value')
    expect(handler).toContain('if (!paneId) return false')
  })

  it('asks before killing a running turn, reusing the rebuild busy check', () => {
    expect(closeFn).toContain('paneBusyForRebuild(')
    expect(closeFn).toContain("if (busy === 'running')")
    expect(closeFn).toContain('close-running-confirm-body')
    expect(closeFn).toContain('if (!ok) return')
  })

  it('asks before closing an idle pane too, unless the user opted out', () => {
    // ⌘W is one-handed and sits next to keys pressed while typing into the very
    // pane it kills, so an idle close is a prompt as well — gated on the
    // setting, which is the only thing the opt-out flips.
    expect(closeFn).toContain('else if (confirmBeforeClosePane.value)')
    expect(closeFn).toContain('close-idle-confirm-body')
    expect(closeFn).toContain("checkboxLabel: i18n.global.t('confirm-close.dont-show-again')")
    expect(closeFn).toContain('await onKill(paneId)')
  })

  it('records the opt-out only after a confirmed close', () => {
    // Cancelling means "not this pane" and must not silently disable the
    // prompt — same rule the workspace-close dialog follows.
    const optOut = 'if (notifyRestore.dialogCheckbox.value) confirmBeforeClosePane.value = false'
    expect(closeFn).toContain(optOut)
    const idleBranch = closeFn.slice(closeFn.indexOf('else if (confirmBeforeClosePane.value)'))
    expect(idleBranch.indexOf('if (!ok) return')).toBeLessThan(idleBranch.indexOf(optOut))
  })

  it('leaves the ✕ button closing outright', () => {
    // The mouse path is deliberate; only the keystroke gained a prompt.
    expect(appSource).toContain('@click="onKill(paneCtxMenu!.paneId); closePaneCtxMenu()"')
  })

  it('keeps the opt-out reversible in Settings', () => {
    // A tick that cannot be undone trades one trap for a worse one.
    const settings = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'), 'utf8'
    )
    expect(settings).toContain('data-settings-section="general-confirm-close-pane"')
    expect(settings).toContain('confirmBeforeClosePaneModel')
    expect(appSource).toContain('v-model:confirm-before-close-pane="confirmBeforeClosePane"')
  })

  it('persists the preference under a stable settings key', () => {
    expect(appSource).toContain("makeStickyBool('agentTeam.confirmClosePane', true)")
  })

  it('has the confirm strings in every shipped locale', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const dict = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/renderer/src/i18n/locales/${locale}.json`), 'utf8')
      )
      const terminal = dict.pane.terminal
      for (const key of [
        'close-running-confirm-title',
        'close-running-confirm-body',
        'close-running-confirm-confirm',
        'close-idle-confirm-title',
        'close-idle-confirm-body',
      ]) {
        expect(terminal[key], `${locale} is missing ${key}`).toBeTruthy()
      }
      for (const key of ['confirm-close-pane', 'confirm-close-pane-hint']) {
        expect(dict.settings.general[key], `${locale} is missing settings.general.${key}`).toBeTruthy()
      }
      expect(dict['confirm-close']['dont-show-again'], `${locale} is missing the opt-out label`).toBeTruthy()
    }
  })
})
