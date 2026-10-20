// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Pins that both login panes of the two-step Claude sign-in (scheme D) carry
// the sign-in markers #433's isolation keys on: the Settings slot sign-in
// (loginProfileId) and the own-folder step that follows it (isLogin +
// accountDirLogin). Source-read like the other App.*.test.ts files.
const src = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = src('src/renderer/src/App.vue')
const terminalSource = src('src/renderer/src/platform/terminal/composables/useTerminal.ts')
const portsSource = src('src/renderer/src/composables/hostSurfacePorts.ts')

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n}', start))
}

describe('two-step sign-in panes keep the sign-in isolation', () => {
  it('step two opens through onCliLoginSpawn with the own-folder flag', () => {
    expect(functionBody(appSource, 'startDirLoginStep')).toContain(
      'onCliLoginSpawn(agentKey, undefined, { accountDirProfileId: profileId })',
    )
  })

  it('every pane onCliLoginSpawn opens is spawned as a sign-in', () => {
    const body = functionBody(appSource, 'onCliLoginSpawn')
    expect(body).toContain('loginProfileId: dirProfileId ? undefined : loginProfileId')
    expect(body).toContain('isLogin: true,')
    expect(body).toContain('accountDirLogin: dirProfileId ? true : undefined')
    expect(body).toContain('profileId: dirProfileId')
  })

  it('onManualSpawn forwards the markers to spawnPane', () => {
    const body = functionBody(appSource, 'onManualSpawn')
    expect(body).toContain('loginProfileId: payload.loginProfileId')
    expect(body).toContain('isLogin: payload.isLogin')
    expect(body).toContain('accountDirLogin: payload.accountDirLogin')
  })

  it('spawnPane marks the pane, its backend terminal and its xterm as a sign-in', () => {
    const body = functionBody(appSource, 'spawnPane')
    expect(body).toContain('isLogin: opts.isLogin || opts.loginProfileId ? true : undefined')
    expect(body).toContain('login_pane: pane.isLogin')
    expect(body).toContain('opts.workspacePath && !pane.isLogin')
    expect(body).toContain('isLogin: opts.isLogin,')
    expect(body).toContain('accountDirLogin: opts.accountDirLogin')
    expect(portsSource).toContain('account_dir_login: true')
  })

  it('pane reads for agents leave a sign-in pane screen out', () => {
    expect(appSource).toContain("buffer: pane?.isLogin ? '' : readPaneShareText(ref, CLI_CHIP_LINE_CAP)")
    expect(appSource).toContain("buffer: pane.isLogin ? '' : readPaneShareText(ref, CLI_CHIP_LINE_CAP)")
    expect(appSource).toContain("if (pane.isLogin) return { ok: false, sent: false, error: SIGN_IN_PANE_INPUT_REFUSAL")
  })

  it('xterm never snapshots a sign-in pane to localStorage', () => {
    expect(terminalSource).toContain('isSignInPane = !!(opts.isLogin || opts.loginProfileId)')
    const save = functionBody(terminalSource, 'saveScrollSnapshot')
    // The sign-in branch must both drop the key and return before setItem;
    // removeItem(key) also appears in the empty-payload branch below it.
    expect(save).toMatch(
      /if \(isSignInPane\) \{\s*try \{ localStorage\.removeItem\(key\) \} catch \{[^}]*\}\s*return\s*\}/,
    )
  })
})
