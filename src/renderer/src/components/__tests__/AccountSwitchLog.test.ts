// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AccountSwitchLog, { type AccountSwitchLogEntry } from '../accounts/AccountSwitchLog.vue'

// Plan agent-0-2-42_3f728e D7: Settings → Accounts lists the switches nobody
// clicked, read-only, from account_switch_log.list.
function entry(over: Partial<AccountSwitchLogEntry> = {}): AccountSwitchLogEntry {
  return {
    id: 1, created_at: 1_800_000_000, source: 'mcp', requester: 'builder', agent_key: 'claude',
    from_name: 'Personal', to_name: 'Work', to_profile_id: 'p-2', pane_name: null,
    reason: 'quota ran out', status: 'switched', code: null, ...over,
  }
}

function mountWith(entries: AccountSwitchLogEntry[]) {
  const send = vi.fn(async () => ({ payload: { entries } }))
  const wrapper = mount(AccountSwitchLog, {
    props: { backend: { send } as never },
    global: { plugins: [i18n] },
  })
  return { wrapper, send }
}

describe('AccountSwitchLog', () => {
  it('lists each switch with who, the accounts, the result and the reason', async () => {
    const { wrapper, send } = mountWith([
      entry(),
      entry({ id: 2, requester: 'telegram:me', status: 'refused', code: 'LIVE_DRIFT', pane_name: 'worker' }),
    ])
    await flushPromises()
    expect(send).toHaveBeenCalledWith('account_switch_log.list', { limit: 200 })
    const rows = wrapper.findAll('[data-testid="account-switch-log-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('builder')
    expect(rows[0].text()).toContain('Personal → Work')
    expect(rows[0].text()).toContain('quota ran out')
    expect(rows[1].text()).toContain('LIVE_DRIFT')
    expect(rows[1].text()).toContain('worker')
  })

  it('says when there is nothing yet', async () => {
    const { wrapper } = mountWith([])
    await flushPromises()
    expect(wrapper.findAll('[data-testid="account-switch-log-row"]')).toHaveLength(0)
    expect(wrapper.text()).toContain(String(i18n.global.t('settings.accounts.cli.switch-log-empty')))
  })
})
