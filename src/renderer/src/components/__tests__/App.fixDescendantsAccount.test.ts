// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — the wiring is asserted against the source text. The
// row rules are covered through subtreeFixRows in accountFollowSwitch.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const locale = (name: string): Record<string, Record<string, string>> =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${name}.json`), 'utf8')
  )

describe('App pane context menu — Fix sub-panes to my account', () => {
  it('uses the same subtree as Remove sub-panes, on claude panes only', () => {
    expect(appSource).toContain('const childIds = new Set(descendantPaneIds(paneId))')
    expect(appSource).toContain('if (!m || !ctxDescendantIds.value.length) return null')
    expect(appSource).toContain('return p && p.agentKey === FOLLOW_SWITCH_AGENT && !p.isLogin ? subtreeFixTarget(p) : null')
  })

  it('targets the account the pane runs on now, and refuses the Default slot', () => {
    expect(appSource).toContain('if (paneAccountFixed(p) && p.profileId) return p.profileId')
    expect(appSource).toContain('return cliProfilesApi.defaultProfileId(FOLLOW_SWITCH_AGENT) ?? DEFAULT_SLOT_ID')
    expect(appSource).toContain(":class=\"{ muted: ctxFixChildrenTarget === DEFAULT_SLOT_ID }\"")
    expect(appSource).toContain("notifyRestore.toast(i18n.global.t('action.fix-children-account-default'), { type: 'error' })")
  })

  it('opens the dir sign-in instead of moving anything when the account has none', () => {
    expect(appSource).toContain(
      "void onCliLoginSpawn(FOLLOW_SWITCH_AGENT, undefined, { accountDirProfileId: target })"
    )
  })

  it('asks first, then reopens each ticked sub-pane in the account dir without interrupting busy ones', () => {
    expect(appSource).toContain("mode: 'fix-children',")
    expect(appSource).toContain('parentFollows: !paneAccountFixed(parent),')
    expect(appSource).toContain(
      'rebuildPaneViaResume(id, { profileId: target, suppressBusyToast: true, freshWhenNoTranscript: true })'
    )
    // Fixed = off the follow set; restored when that pane's rebuild fails.
    expect(appSource).toContain('if (failure && wasFollowing) accountFollow.add(id)')
    expect(appSource).not.toMatch(/fixDescendantsToAccount[\s\S]{0,4000}forceWhenRunning/)
  })

  it('every new string exists in every locale', () => {
    const names = ['en-US', 'zh-TW', 'zh-CN', 'ja-JP', 'ko-KR', 'de-DE', 'es-ES', 'fr-FR', 'pt-BR', 'ru-RU', 'vi-VN']
    const action = ['fix-children-account', 'fix-children-account-mine', 'fix-children-account-title', 'fix-children-account-default']
    const follow = [
      'fix-children-title', 'fix-children-body', 'fix-children-parent-follows', 'fix-children-confirm',
      'skip-not-claude', 'skip-no-session', 'skip-already', 'fix-children-done', 'fix-children-waiting',
      'fix-children-none', 'fix-children-needs-dir-login',
    ]
    for (const name of names) {
      const l = locale(name)
      for (const k of action) expect(l.action[k], `${name} action.${k}`).toBeTruthy()
      for (const k of follow) expect(l['account-follow'][k], `${name} account-follow.${k}`).toBeTruthy()
    }
    expect(locale('en-US').action['fix-children-account']).toBe('Fix {count} Sub-panes to {account}')
    expect(locale('zh-TW').action['fix-children-account']).toBe('旗下 {count} 個子分格固定到 {account}')
  })
})
