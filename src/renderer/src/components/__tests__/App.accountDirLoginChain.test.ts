// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Like the other App.*.test.ts files these read the source: mounting App
// starts backend/terminal/settings lifecycles. They pin the two-step Claude
// sign-in wiring (plan claude-vault-slot_71f222, scheme D): a Settings
// sign-in that lands in the vault slot goes on to the account's own-folder
// sign-in through the existing login pane entry point. The decisions are
// unit-tested in lib/__tests__/accountDirLoginChain.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

const harvestStart = appSource.indexOf("if (ev?.reason !== 'login-harvest') return")
const harvestBlock = appSource.slice(harvestStart, appSource.indexOf('\n})\n', harvestStart))

const localesDir = resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales')
function locale(name: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(resolve(localesDir, `${name}.json`), 'utf8'))
}

describe('two-step Claude sign-in wiring', () => {
  it('records which step each pending login pane is', () => {
    const body = functionBody('onCliLoginSpawn')
    expect(body).toContain("step: dirProfileId ? 'dir' : 'slot'")
  })

  it('opens the own-folder sign-in pane through the existing entry point after the slot sign-in', () => {
    expect(harvestStart).toBeGreaterThan(-1)
    expect(harvestBlock).toContain(
      'chainsDirLogin(pending, profileId, dirSignedIn, cliProfilesApi.defaultProfileId(pending.agentKey))',
    )
    expect(harvestBlock).toContain('void onCliLoginSpawn(pending.agentKey, undefined, { accountDirProfileId: profileId })')
    expect(harvestBlock).toContain("i18n.global.t('settings.accounts.cli.login-step2'")
  })

  it('ends the own-folder step only once the folder is signed in', () => {
    expect(harvestBlock).toContain('dirLoginLanded(pending, profileId, dirSignedIn)')
    expect(harvestBlock).toContain("i18n.global.t('settings.accounts.cli.login-step2-done'")
  })

  it('keeps the confirmation every other sign-in shows on main', () => {
    expect(harvestBlock).toContain("i18n.global.t('settings.accounts.cli.login-complete', { email })")
    expect(harvestBlock).toContain("i18n.global.t('settings.accounts.cli.login-complete-no-email')")
  })

  it('a closed own-folder pane leaves only a reminder, and reopens nothing', () => {
    const body = functionBody('noteSkippedDirLogins')
    expect(body).toContain('skippedDirLogins(pendingLoginPanes, ')
    expect(body).toContain("i18n.global.t('settings.accounts.cli.login-step2-skipped'")
    expect(body).not.toContain('onCliLoginSpawn')
  })

  it('reminds an existing account once, only after the account list has loaded', () => {
    const body = functionBody('remindDirLogins')
    expect(body).toContain('if (!cliProfilesApi.loaded.value) return')
    expect(body).toContain('dirLoginReminderTargets(')
    expect(body).toContain('saveDirLoginReminded(')
    expect(body).not.toContain('onCliLoginSpawn')
  })

  it('sends nothing of its own to the backend', () => {
    for (const name of ['noteSkippedDirLogins', 'remindDirLogins']) {
      const body = functionBody(name)
      expect(body, name).not.toContain('backend.send')
      expect(body, name).not.toContain('setDefault')
    }
    expect(harvestBlock).not.toContain('backend.send')
  })
})

describe('two-step Claude sign-in copy', () => {
  const keys = ['login-step2', 'login-step2-no-email', 'login-step2-done', 'login-step2-done-no-email', 'login-step2-skipped', 'login-step2-skipped-no-email', 'dir-remind']
  for (const name of ['en-US', 'zh-TW', 'ja-JP']) {
    it(`${name} has every step string`, () => {
      const cli = (locale(name).settings as Record<string, Record<string, Record<string, string>>>).accounts.cli
      for (const key of keys) expect(cli[key], `${name} ${key}`).toBeTruthy()
    })
  }

  it("the badge button says where it signs in, in #409's words", () => {
    expect((locale('en-US').usage as Record<string, string>)['dir-sign-in']).toBe('Sign in to its own folder')
    expect((locale('zh-TW').usage as Record<string, string>)['dir-sign-in']).toBe('登入到帳號資料夾')
    expect((locale('ja-JP').usage as Record<string, string>)['dir-sign-in']).toBe('専用フォルダーでサインイン')
  })
})
