// @vitest-environment happy-dom
// Scheme B's one confirm (plan_8debb8): choosing a default account while some
// following panes are mid-turn lists those panes and offers to move them once
// they finish (the follow batch waits, never interrupts) or to leave them out.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountFollowSwitchDialog, { type FollowDialogRow } from '../AccountFollowSwitchDialog.vue'

const tMock = (key: string, args?: Record<string, unknown>): string =>
  args ? `${key}:${JSON.stringify(args)}` : key

function row(paneId: string): FollowDialogRow {
  return { paneId, name: paneId, profileId: 'A', accountLabel: 'a@x', state: 'running', checked: true }
}

function mountDialog(rows: FollowDialogRow[]): VueWrapper {
  return mount(AccountFollowSwitchDialog, {
    props: { open: true, mode: 'follow', subject: 'B', rows },
    global: { mocks: { $t: tMock }, stubs: { Teleport: true }, directives: { truncate: {} } },
  })
}

describe('AccountFollowSwitchDialog – follow mode', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('lists the running panes without checkboxes and names the account', () => {
    wrapper = mountDialog([row('p1'), row('p2')])
    expect(wrapper.get('h2').text()).toBe('account-follow.follow-title:{"account":"B","count":2}')
    expect(wrapper.find('[data-testid="account-follow-row-p1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-follow-row-p2"]').exists()).toBe(true)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('"move when finished" confirms every running pane', async () => {
    wrapper = mountDialog([row('p1'), row('p2')])
    await wrapper.get('[data-testid="account-follow-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[['p1', 'p2'], null]])
  })

  it('"skip running" confirms with none of them', async () => {
    wrapper = mountDialog([row('p1')])
    await wrapper.get('[data-testid="account-follow-skip-running"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[[], null]])
  })

  it('cancel answers nothing', async () => {
    wrapper = mountDialog([row('p1')])
    await wrapper.get('[data-testid="account-follow-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('keeps the buttons of the other modes off', () => {
    wrapper = mountDialog([row('p1')])
    expect(wrapper.get('[data-testid="account-follow-confirm"]').text()).toBe('account-follow.follow-wait')
    expect(wrapper.get('[data-testid="account-follow-cancel"]').text()).toBe('account-follow.cancel')
  })
})
