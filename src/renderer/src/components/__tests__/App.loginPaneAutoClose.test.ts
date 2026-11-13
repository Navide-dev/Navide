// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { loginPaneExitAction, loginPaneRestartable } from '../../lib/loginPaneLifecycle'

// A sign-in pane opened with no account slot (the install dialog's sign-in,
// the live account's sign-in) used to sit EXITED after `codex login` printed
// "Successfully logged in" — nothing ever closed it or said what to do next.
// Executes the real App.vue code (onCliLoginSpawn, the terminal.exit handler,
// rebuildPaneViaResume's sign-in branch) with IO replaced.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const transpile = (code: string): string => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const fn = (name: string): string => transpile(ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
)!.getText(ast))

let exitHandler = ''
ast.forEachChild(function visit(node) {
  if (
    ts.isCallExpression(node) && node.expression.getText(ast) === 'backend.on'
    && node.arguments[0]?.getText(ast) === "'terminal.exit'"
  ) {
    exitHandler = transpile(`const onExit = ${node.arguments[1].getText(ast)}`)
  }
  node.forEachChild(visit)
})

function harness(opts: { loginCommand: boolean }) {
  const panes = ref<any[]>([])
  const paneRefs: Record<string, any> = {}
  let next = 0
  const scope = {
    panes,
    paneRefs,
    pendingLoginPanes: new Map<string, any>(),
    slotlessLoginPanes: new Map<string, string>(),
    currentWorkspace: ref('/ws'),
    showSettings: ref(true),
    onManualSpawn: vi.fn(async () => {
      const id = `p${++next}`
      panes.value.push({ id, agentKey: 'codex', agentLabel: 'Codex CLI (OpenAI)', isLogin: true, realized: true })
      paneRefs[id] = { status: 'running' }
      return id
    }),
    onKill: vi.fn(async () => undefined),
    noteViewJump: vi.fn(),
    onFocusPane: vi.fn(),
    cliProfilesApi: { capabilityFor: () => ({ loginCommand: opts.loginCommand }) },
    notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string) => key } },
    loginPaneExitAction,
    loginPaneRestartable,
    stopLoopLimitWatcher: vi.fn(),
    setPrepStatus: vi.fn(),
    syncViews: vi.fn(),
    promptCliInstall: vi.fn(),
    paneExitFault: (code: number | null) => (code ? { code } : null),
    recordDiagnostic: vi.fn(),
    acp: { owns: () => false },
    rebuildPaneClean: vi.fn(async () => undefined),
  }
  const run = new Function(
    ...Object.keys(scope),
    `${fn('onCliLoginSpawn')}\n${fn('rebuildPaneViaResume')}\n${exitHandler}\nreturn { onCliLoginSpawn, rebuildPaneViaResume, onExit }`,
  )(...Object.values(scope)) as {
    onCliLoginSpawn: (agentKey: string, loginProfileId?: string) => Promise<boolean>
    rebuildPaneViaResume: (paneId: string) => Promise<unknown>
    onExit: (ev: { pane_id: string; exit_code: number | null }) => void
  }
  return { scope, ...run }
}

describe('a sign-in pane once its CLI ends', () => {
  it('closes a slot-less sign-in pane that signed in, and says how to start working', async () => {
    const h = harness({ loginCommand: true })
    await h.onCliLoginSpawn('codex')
    h.onExit({ pane_id: 'p1', exit_code: 0 })
    expect(h.scope.onKill).toHaveBeenCalledWith('p1')
    expect(h.scope.notifyRestore.toast).toHaveBeenCalledWith(
      'settings.accounts.cli.login-pane-done', { type: 'success' },
    )
    expect(h.scope.slotlessLoginPanes.size).toBe(0)
  })

  it('keeps a slot-less sign-in pane whose sign-in failed, with its error on screen', async () => {
    const h = harness({ loginCommand: true })
    await h.onCliLoginSpawn('codex')
    h.onExit({ pane_id: 'p1', exit_code: 1 })
    expect(h.scope.onKill).not.toHaveBeenCalled()
    expect(h.scope.notifyRestore.toast).not.toHaveBeenCalled()
  })

  it('leaves a slot sign-in pane to the login-harvest broadcast, success or failure', async () => {
    for (const exitCode of [0, 1]) {
      const h = harness({ loginCommand: true })
      await h.onCliLoginSpawn('codex', 'slot-1')
      expect(h.scope.pendingLoginPanes.get('slot-1')?.paneId).toBe('p1')
      expect(h.scope.slotlessLoginPanes.size).toBe(0)
      h.onExit({ pane_id: 'p1', exit_code: exitCode })
      expect(h.scope.onKill).not.toHaveBeenCalled()
    }
  })

  it('does not treat quitting a CLI that signs in inside itself as a sign-in', async () => {
    const h = harness({ loginCommand: false })
    await h.onCliLoginSpawn('qwen')
    h.onExit({ pane_id: 'p1', exit_code: 0 })
    expect(h.scope.onKill).not.toHaveBeenCalled()
  })

  it('restarts an ended sign-in pane as the ordinary CLI, not as another sign-in', async () => {
    const h = harness({ loginCommand: true })
    await h.onCliLoginSpawn('codex')
    h.scope.paneRefs.p1.status = 'exited'
    await expect(h.rebuildPaneViaResume('p1')).resolves.toBeUndefined()
    expect(h.scope.rebuildPaneClean).toHaveBeenCalledWith('p1')
  })
})
