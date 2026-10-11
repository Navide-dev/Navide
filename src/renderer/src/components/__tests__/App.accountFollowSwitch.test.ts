// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Like the other App.*.test.ts files these read the source: mounting App
// starts backend/terminal/settings lifecycles. They pin the follow-switch
// flag's wiring (agentTeam.accounts.followSwitch): with the flag off every
// entry point is inert, so the window behaves exactly as before. The logic
// itself is unit-tested in lib/__tests__/accountFollowSwitch.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

const followBlock = appSource.slice(
  appSource.indexOf('// ── Follow switch (agentTeam.accounts.followSwitch'),
  appSource.indexOf('async function rebuildPanesViaResume('),
)

describe('follow switch wiring: off means unchanged', () => {
  it('wraps the account-switch handler, gated on the flag read at call time', () => {
    const start = appSource.indexOf('  cliAccountSwitchKey,\n  // withFollowSwitch')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n)\n', start))
    expect(block).toContain('withFollowSwitch(createCliAccountSwitchHandler(cliProfilesApi, {')
    expect(block).toContain('enabled: accountFollowSwitchEnabled,')
  })

  it('offers the quota button only with the flag on, for a claude pane that can be rebuilt', () => {
    expect(appSource).toContain(
      ':quota-switch-offered="followSwitchFlag && p.agentKey === FOLLOW_SWITCH_AGENT && paneCanRebuild(p)"',
    )
    expect(functionBody('onQuotaSwitchAccount')).toContain('if (!followSwitchFlag.value) return')
  })

  it('renders the dialog only while one is asked for, and only the two flag paths ask', () => {
    expect(appSource).toContain('<AccountFollowSwitchDialog\n    v-if="followDialog"')
    const asks = appSource.split('askFollowDialog(').length - 1
    // definition + offerFollowSwitch + onQuotaSwitchAccount
    expect(asks).toBe(3)
    expect(functionBody('offerFollowSwitch')).toContain('askFollowDialog(')
    expect(functionBody('onQuotaSwitchAccount')).toContain('askFollowDialog(')
  })

  it('sends nothing of its own to the backend: moves are ordinary resume rebuilds', () => {
    expect(followBlock).not.toContain('backend.send')
    expect(followBlock).not.toContain('sendQuiet')
    expect(followBlock).not.toContain('setDefault')
    expect(followBlock).not.toContain('quotaFailover')
  })
})

describe('follow switch wiring: flag on', () => {
  it('rebuilds on the chosen account and never forces a pane mid-turn', () => {
    const body = functionBody('moveFollowPanes')
    expect(body).toContain('rebuildPaneViaResume(id, { profileId, suppressBusyToast: true })')
    expect(body).not.toContain('forceWhenRunning')
    expect(body).toContain("i18n.global.t('account-follow.done-partial'")
  })

  it('moves to the account switched to, the Default as its reserved id', () => {
    const body = functionBody('offerFollowSwitch')
    expect(body).toContain('if (rows.length === 0) return')
    expect(body).toContain('const target = targetId ?? DEFAULT_SLOT_ID')
    expect(body).toContain('await moveFollowPanes(choice.paneIds, target)')
  })

  it('moves the out-of-quota pane first, then the peers ticked', () => {
    expect(functionBody('onQuotaSwitchAccount')).toContain(
      'await moveFollowPanes([paneId, ...choice.paneIds], choice.targetId)',
    )
  })
})
