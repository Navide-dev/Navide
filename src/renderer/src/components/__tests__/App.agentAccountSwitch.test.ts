// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { runAgentAccountSwitch } from '../../lib/agentAccountSwitch'
import { revealInvisibleText } from '../../../../shared/pluginAgentTools'
import type { AgentSignInConfirmAnswer } from '../../lib/agentSignIn'

// Plan mcp_614482 P3: App.vue's agentAccountSwitch (MCP cli_account_switch)
// asks the user, and only on their yes calls the window's own switch handler
// cliAccountSwitch with the vendor and the account — never setDefault
// directly, never force. Executes the real App.vue function with the window's
// state and IO replaced; setDefault is in scope too, so a wiring that skips
// the handler fails here instead of passing.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const decl = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'agentAccountSwitch'
)!
const js = ts.transpileModule(decl.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function harness(answer: AgentSignInConfirmAnswer) {
  const profiles: Record<string, { agentKey: string; name: string }> = {
    'p-a': { agentKey: 'claude', name: 'Account 1' },
    'p-b': { agentKey: 'claude', name: 'Account 2' },
  }
  const setDefault = vi.fn(async () => ({ ok: true }))
  const scope = {
    runAgentAccountSwitch,
    revealInvisibleText,
    cliProfilesApi: {
      findProfile: (id: string | null) => (id ? profiles[id] : undefined),
      defaultProfileId: () => 'p-a',
      aliasFor: () => undefined,
      setDefault,
    },
    panes: ref([{ id: 'pa', workspacePath: '/ws/alpha', messagingName: 'builder\u200b' }]),
    cliAccountSwitch: vi.fn(async () => ({ ok: true })),
    agentAccountSwitchConfirm: { ask: vi.fn(async () => answer) },
    accountLabel: (_api: unknown, _agentKey: string, id: string | null) => `label:${id}`,
    notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}` } },
  }
  const agentAccountSwitch = new Function(...Object.keys(scope), `${js}\nreturn agentAccountSwitch`)(...Object.values(scope)) as (
    args: Record<string, unknown>, callerPaneId: string, signal?: AbortSignal
  ) => Promise<Record<string, unknown>>
  return { scope, agentAccountSwitch }
}

const args = () => ({
  agentKey: 'claude', profileId: 'p-b', reason: 'quota ran out', reasonTruncated: false, confirmBy: Date.now() + 45_000,
})

describe('App.vue agentAccountSwitch asks the user first', () => {
  for (const [answer, status] of [['declined', 'declined'], ['expired', 'confirm-timeout'], ['busy', 'busy']] as const) {
    it(`switches nothing when the confirmation answers ${answer}`, async () => {
      const { scope, agentAccountSwitch } = harness(answer)
      expect((await agentAccountSwitch(args(), 'pa')).status).toBe(status)
      expect(scope.cliAccountSwitch).not.toHaveBeenCalled()
      expect(scope.cliProfilesApi.setDefault).not.toHaveBeenCalled()
      expect(scope.notifyRestore.toast).not.toHaveBeenCalled()
    })
  }

  it('switches through cliAccountSwitch with the vendor and the account only, then tells the user', async () => {
    const { scope, agentAccountSwitch } = harness('confirmed')
    expect(await agentAccountSwitch(args(), 'pa')).toEqual({ status: 'switched', from: 'Account 1', to: 'Account 2' })
    expect(scope.agentAccountSwitchConfirm.ask).toHaveBeenCalledTimes(1)
    expect(scope.cliAccountSwitch.mock.calls).toEqual([['claude', 'p-b']])
    expect(scope.cliProfilesApi.setDefault).not.toHaveBeenCalled()
    expect(scope.notifyRestore.toast).toHaveBeenCalledTimes(1)
  })

  it('shows the agent name and reason in the toast with invisible characters revealed', async () => {
    const { scope, agentAccountSwitch } = harness('confirmed')
    await agentAccountSwitch({ ...args(), reason: 'quota\u202e out' }, 'pa')
    const [[text]] = scope.notifyRestore.toast.mock.calls as unknown as [[string]]
    expect(text).toContain('quota\\\\u{202e} out')
    expect(text).toContain('builder\\\\u{200b}')
    expect(text).not.toMatch(/[\u200b\u202e]/)
  })

  it('hands the bus signal to the confirmation', async () => {
    const { scope, agentAccountSwitch } = harness('expired')
    const controller = new AbortController()
    await agentAccountSwitch(args(), 'pa', controller.signal)
    expect(scope.agentAccountSwitchConfirm.ask).toHaveBeenCalledWith(expect.objectContaining({ agentKey: 'claude' }), controller.signal)
  })
})
