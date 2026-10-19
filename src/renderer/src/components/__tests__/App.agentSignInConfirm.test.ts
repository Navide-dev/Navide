// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { planAgentSignIn, runAgentSignIn, type AgentSignInConfirmAnswer } from '../../lib/agentSignIn'

// Review #438 LOW-3: App.vue's agentSignIn (MCP cli_account_sign_in) goes
// through the user's confirmation. A no, a lapsed or withdrawn confirmation,
// or another one already waiting opens no sign-in pane. Executes the real
// App.vue function with the window's state and IO replaced; the scope also
// carries what the function used before the confirmation existed, so a
// wiring that skips it fails here instead of passing.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const decl = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'agentSignIn'
)!
const js = ts.transpileModule(decl.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function harness(answer: AgentSignInConfirmAnswer) {
  const pendingLoginPanes = new Map<string, { paneId: string }>()
  const scope = {
    planAgentSignIn,
    runAgentSignIn,
    cliProfilesApi: {
      findProfile: (id: string) => (id === 'p-parked' ? { agentKey: 'codex' } : undefined),
      defaultProfileId: () => null,
      loginIsGlobal: () => false,
    },
    currentWorkspace: ref('/ws/alpha'),
    panes: ref([{ id: 'pa', workspacePath: '/ws/alpha', messagingName: 'builder' }]),
    pendingLoginPanes,
    onCliLoginSpawn: vi.fn(async (_agentKey: string, profileId?: string) => {
      pendingLoginPanes.set(profileId ?? '', { paneId: 'login-1' })
      return true
    }),
    agentSignInConfirm: { ask: vi.fn(async () => answer) },
    accountLabel: (_api: unknown, _agentKey: string, id: string) => id,
    notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string) => key } },
  }
  const agentSignIn = new Function(...Object.keys(scope), `${js}\nreturn agentSignIn`)(...Object.values(scope)) as (
    args: Record<string, unknown>, callerPaneId: string, signal?: AbortSignal
  ) => Promise<Record<string, unknown>>
  return { scope, agentSignIn }
}

const args = () => ({
  agentKey: 'codex', profileId: 'p-parked', mode: 'isolated', reason: 'quota ran out',
  reasonTruncated: false, confirmBy: Date.now() + 45_000,
})

describe("App.vue agentSignIn asks the user first", () => {
  for (const [answer, status] of [['declined', 'declined'], ['expired', 'confirm-timeout'], ['busy', 'busy']] as const) {
    it(`opens no sign-in pane when the confirmation answers ${answer}`, async () => {
      const { scope, agentSignIn } = harness(answer)
      expect((await agentSignIn(args(), 'pa')).status).toBe(status)
      expect(scope.onCliLoginSpawn).not.toHaveBeenCalled()
      expect(scope.notifyRestore.toast).not.toHaveBeenCalled()
    })
  }

  it('opens the sign-in pane once the user agrees, after asking them', async () => {
    const { scope, agentSignIn } = harness('confirmed')
    expect(await agentSignIn(args(), 'pa')).toEqual({ status: 'started', loginPaneId: 'login-1' })
    expect(scope.agentSignInConfirm.ask).toHaveBeenCalledTimes(1)
    expect(scope.onCliLoginSpawn).toHaveBeenCalledWith('codex', 'p-parked')
  })

  it('hands the bus signal to the confirmation', async () => {
    const { scope, agentSignIn } = harness('expired')
    const controller = new AbortController()
    await agentSignIn(args(), 'pa', controller.signal)
    expect(scope.agentSignInConfirm.ask).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p-parked' }), controller.signal)
  })
})
