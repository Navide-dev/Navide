// A disabled Plans must never put the session into legacy Plans recovery:
// after Enable it would stay there for the rest of the session.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'

function extractFunction(name: string): string {
  const source = createSourceFile('index.ts', readFileSync(resolve('src/main/index.ts'), 'utf8'), ScriptTarget.Latest, true)
  const statement = source.statements.find((item) => isFunctionDeclaration(item) && item.name?.text === name)
  expect(statement).toBeDefined()
  return transpileModule(statement!.getText(source), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
}

function recoveryHarness(disabled: boolean) {
  const manager = {
    isBuiltinPluginDisabled: vi.fn((id: string) => disabled && id === 'navide.plans'),
    markPlansBackendUnavailable: vi.fn(),
  }
  const window = { id: 1, isDestroyed: () => false, webContents: { send: vi.fn() } }
  const state = { enabled: false }
  const enter = new Function(
    'frontendPluginManager', 'PLANS_PLUGIN_ID', 'warnMain', 'contributionWindows', 'mainWindows', 'detachedWindowIds', 'state',
    `let plansRecoveryEnabled = false; let plansRecoveryReason = null;
     ${extractFunction('enterPlansRecovery')}
     return (reason) => { enterPlansRecovery(reason); state.enabled = plansRecoveryEnabled }`,
  )(manager, 'navide.plans', () => undefined, new Map(), new Set([window]), new Set(), state) as (reason: string) => void
  return { manager, window, state, enter }
}

describe('enterPlansRecovery', () => {
  it('does nothing while Plans is disabled', () => {
    const { manager, window, state, enter } = recoveryHarness(true)
    enter('guest-prepare-failure')
    expect(state.enabled).toBe(false)
    expect(manager.markPlansBackendUnavailable).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('still enters recovery as before while Plans is enabled', () => {
    const { manager, window, state, enter } = recoveryHarness(false)
    enter('guest-prepare-failure')
    expect(state.enabled).toBe(true)
    expect(manager.markPlansBackendUnavailable).toHaveBeenCalledWith('guest-prepare-failure')
    expect(window.webContents.send).toHaveBeenCalledWith('plans:recoveryChanged', { legacy: true, reason: 'guest-prepare-failure' })
  })
})
