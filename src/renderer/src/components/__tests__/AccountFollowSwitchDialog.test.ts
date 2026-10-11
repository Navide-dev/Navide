// @vitest-environment happy-dom
// The follow-switch dialog: after a claude switch it lists the pinned panes
// the switch did not reach (pre-checked as the pure rows say); on an
// out-of-quota pane it picks a landable account and the peers to take along.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountFollowSwitchDialog, { type FollowDialogRow } from '../AccountFollowSwitchDialog.vue'
import type { QuotaTarget } from '../../lib/accountFollowSwitch'

const tMock = (key: string): string => key

function row(paneId: string, checked: boolean, state: FollowDialogRow['state'] = 'idle'): FollowDialogRow {
  return { paneId, name: paneId, profileId: 'A', accountLabel: 'a@x', state, checked }
}

function mountDialog(props: Record<string, unknown>): VueWrapper {
  return mount(AccountFollowSwitchDialog, {
    props: { open: true, mode: 'switch', subject: 'B', rows: [], ...props },
    global: { mocks: { $t: tMock }, stubs: { Teleport: true }, directives: { truncate: {} } },
  })
}

describe('AccountFollowSwitchDialog', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('switch mode: emits the ticked panes, pre-checked as given', async () => {
    wrapper = mountDialog({ rows: [row('p1', true), row('p2', false), row('p3', true, 'running')] })
    await wrapper.get('[data-testid="account-follow-row-p2"] input').setValue(true)
    await wrapper.get('[data-testid="account-follow-row-p3"] input').setValue(false)
    await wrapper.get('[data-testid="account-follow-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[['p1', 'p2'], null]])
  })

  it('switch mode: nothing ticked cannot be confirmed; skip cancels', async () => {
    wrapper = mountDialog({ rows: [row('p1', false)] })
    expect(wrapper.get('[data-testid="account-follow-confirm"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="account-follow-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('quota mode: preselects the first landable account with quota and disables the rest', async () => {
    const targets: QuotaTarget[] = [
      { id: 'X', label: 'x', remaining: '', eligible: false, exhausted: false },
      { id: 'Y', label: 'y', remaining: '0%', eligible: true, exhausted: true },
      { id: 'Z', label: 'z', remaining: '70%', eligible: true, exhausted: false },
    ]
    wrapper = mountDialog({ mode: 'quota', subject: 'pane', targets, rows: [row('peer', true, 'quota')] })
    expect(wrapper.get('[data-testid="account-follow-target-X"] input').attributes('disabled')).toBeDefined()
    expect((wrapper.get('[data-testid="account-follow-target-Z"] input').element as HTMLInputElement).checked).toBe(true)
    await wrapper.get('[data-testid="account-follow-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[['peer'], 'Z']])
  })

  it('quota mode: no landable account means nothing to confirm', () => {
    wrapper = mountDialog({
      mode: 'quota',
      subject: 'pane',
      targets: [{ id: 'X', label: 'x', remaining: '', eligible: false, exhausted: false }],
    })
    expect(wrapper.get('[data-testid="account-follow-confirm"]').attributes('disabled')).toBeDefined()
  })
})
