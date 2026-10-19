// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Review 0.2.26 R2 LOW-9: a CLI sign-in pane writes no transcript, so moving
// it to another account (the usage badge's "continue on this account", or the
// title bar's pin toggle) would reopen it fresh as an ordinary pane and drop
// the sign-in without a word. Both leave a sign-in pane alone; every other
// pane behaves as before. Executes the real App.vue code with IO replaced.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const transpile = (code: string): string => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const toggleDecl = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'toggleAccountPin'
)!
let continueWithText = ''
ast.forEachChild(function visit(node) {
  if (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'provide'
    && node.arguments[0]?.getText(ast) === 'cliAccountDirActionsKey'
  ) {
    const actions = node.arguments[1] as ts.ObjectLiteralExpression
    const prop = actions.properties.find((p) => p.name?.getText(ast) === 'continueWith') as ts.PropertyAssignment
    continueWithText = prop.initializer.getText(ast)
  }
  node.forEachChild(visit)
})

function harness(isLogin: boolean) {
  const panes = ref<any[]>([{ id: 'p1', agentKey: 'claude', realized: true, profileId: 'acct-a', isLogin: isLogin || undefined }])
  const scope = {
    panes,
    FOLLOW_SWITCH_AGENT: 'claude',
    DEFAULT_SLOT_ID: '__default__',
    paneAccountFixed: () => true,
    accountFollow: { add: vi.fn(), remove: vi.fn(), has: () => false },
    rebuildPaneViaResume: vi.fn(async () => undefined),
    cliProfilesApi: { defaultProfileId: () => 'acct-b' },
    notifyRestore: { toast: vi.fn(), confirm: vi.fn(async () => true) },
    i18n: { global: { t: (key: string) => key } },
    followDirSignedIn: () => true,
    followAccountLabel: (id: string) => id,
    onCliLoginSpawn: vi.fn(async () => true),
    accountLabel: (_api: unknown, _agent: string, id: string) => id,
  }
  const run = new Function(
    ...Object.keys(scope),
    `${transpile(toggleDecl.getText(ast))}\nconst continueWith = ${transpile(continueWithText)}\nreturn { toggleAccountPin, continueWith }`
  )(...Object.values(scope)) as {
    toggleAccountPin: (paneId: string) => Promise<void>
    continueWith: (paneId: string, profileId: string) => Promise<void>
  }
  return { scope, ...run }
}

describe('account moves on a CLI sign-in pane (LOW-9)', () => {
  it('the pin toggle leaves a sign-in pane alone', async () => {
    const { scope, toggleAccountPin } = harness(true)
    await toggleAccountPin('p1')
    expect(scope.rebuildPaneViaResume).not.toHaveBeenCalled()
    expect(scope.accountFollow.add).not.toHaveBeenCalled()
    expect(scope.accountFollow.remove).not.toHaveBeenCalled()
    expect(scope.onCliLoginSpawn).not.toHaveBeenCalled()
  })

  it('the pin toggle still reopens an ordinary pinned pane on the live login', async () => {
    const { scope, toggleAccountPin } = harness(false)
    await toggleAccountPin('p1')
    expect(scope.accountFollow.add).toHaveBeenCalledWith('p1')
    expect(scope.rebuildPaneViaResume).toHaveBeenCalledWith('p1', { freshWhenNoTranscript: true })
  })

  it('"continue on this account" leaves a sign-in pane alone, without asking', async () => {
    const { scope, continueWith } = harness(true)
    await continueWith('p1', 'acct-b')
    expect(scope.notifyRestore.confirm).not.toHaveBeenCalled()
    expect(scope.rebuildPaneViaResume).not.toHaveBeenCalled()
  })

  it('"continue on this account" still asks, then reopens an ordinary pane', async () => {
    const { scope, continueWith } = harness(false)
    await continueWith('p1', 'acct-b')
    expect(scope.notifyRestore.confirm).toHaveBeenCalledTimes(1)
    expect(scope.rebuildPaneViaResume).toHaveBeenCalledWith(
      'p1', { profileId: 'acct-b', forceWhenRunning: true, freshWhenNoTranscript: true }
    )
  })
})
