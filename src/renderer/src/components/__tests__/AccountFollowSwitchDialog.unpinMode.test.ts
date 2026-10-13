// @vitest-environment happy-dom
// Scheme A's "make all follow" (plan claude_f1bf4b): fixed panes reopen on the
// live login. The ones mid-turn are asked about once — moved when they finish
// (the follow batch waits, never interrupts), skipped, or the whole thing
// cancelled.
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
    props: { open: true, mode: 'unpin', subject: '', rows },
    global: { mocks: { $t: tMock }, stubs: { Teleport: true }, directives: { truncate: {} } },
  })
}

describe('AccountFollowSwitchDialog – unpin mode', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('titles and explains the change, listing the running panes without checkboxes', () => {
    wrapper = mountDialog([row('p1'), row('p2')])
    expect(wrapper.get('h2').text()).toBe('account-follow.unpin-title:{"count":2}')
    expect(wrapper.text()).toContain('account-follow.unpin-body')
    expect(wrapper.find('[data-testid="account-follow-row-p2"]').exists()).toBe(true)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
  })

  it('"move when finished" confirms every running pane', async () => {
    wrapper = mountDialog([row('p1'), row('p2')])
    await wrapper.get('[data-testid="account-follow-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[['p1', 'p2'], null]])
  })

  it('"skip running" confirms with none of them; cancel answers nothing', async () => {
    wrapper = mountDialog([row('p1')])
    await wrapper.get('[data-testid="account-follow-skip-running"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[[], null]])
    await wrapper.get('[data-testid="account-follow-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
