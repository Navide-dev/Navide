// @vitest-environment happy-dom
// "Fix N sub-panes to <account>" from the pane menu: the sub-panes are listed
// with checkboxes; the ones that cannot move are greyed out with the reason,
// and the confirm sends only the ticked panes.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountFollowSwitchDialog, { type FollowDialogRow } from '../AccountFollowSwitchDialog.vue'

const tMock = (key: string, args?: Record<string, unknown>): string =>
  args ? `${key}:${JSON.stringify(args)}` : key

function row(paneId: string, over: Partial<FollowDialogRow> = {}): FollowDialogRow {
  return { paneId, name: paneId, profileId: 'A', accountLabel: 'Team-A', state: 'idle', checked: true, fixed: false, ...over }
}

function mountDialog(rows: FollowDialogRow[], parentFollows = false): VueWrapper {
  return mount(AccountFollowSwitchDialog, {
    props: { open: true, mode: 'fix-children', subject: 'Team-B', rows, parentFollows },
    global: { mocks: { $t: tMock }, stubs: { Teleport: true }, directives: { truncate: {} } },
  })
}

describe('AccountFollowSwitchDialog – fix-children mode', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper.unmount())

  it('titles with the target account and says the parent still follows only when it does', () => {
    wrapper = mountDialog([row('p1')], true)
    expect(wrapper.get('h2').text()).toBe('account-follow.fix-children-title:{"account":"Team-B"}')
    expect(wrapper.text()).toContain('account-follow.fix-children-body:{"account":"Team-B"}')
    expect(wrapper.text()).toContain('account-follow.fix-children-parent-follows')
    wrapper.unmount()
    wrapper = mountDialog([row('p1')], false)
    expect(wrapper.text()).not.toContain('account-follow.fix-children-parent-follows')
  })

  it('greys out skipped rows with their reason and marks fixed panes with the pin', () => {
    wrapper = mountDialog([
      row('pinned', { fixed: true, accountLabel: 'Team-C' }),
      row('codex', { checked: false, skip: 'not-claude' }),
      row('same', { checked: false, skip: 'already', fixed: true, accountLabel: 'Team-B' }),
    ])
    expect(wrapper.get('[data-testid="account-follow-row-pinned"]').text()).toContain('📌 Team-C')
    const codex = wrapper.get('[data-testid="account-follow-row-codex"]')
    expect(codex.get('input').attributes('disabled')).toBeDefined()
    expect(codex.text()).toContain('account-follow.skip-not-claude')
    expect(codex.find('.acct').exists()).toBe(false)
    expect(wrapper.get('[data-testid="account-follow-row-same"]').text()).toContain('account-follow.skip-already:{"account":"Team-B"}')
  })

  it('confirms only the ticked rows, and cannot confirm with none ticked', async () => {
    wrapper = mountDialog([row('p1'), row('p2'), row('codex', { checked: false, skip: 'not-claude' })])
    const confirm = wrapper.get('[data-testid="account-follow-confirm"]')
    expect(confirm.text()).toBe('account-follow.fix-children-confirm:{"count":2}')
    await wrapper.get('[data-testid="account-follow-row-p2"] input').trigger('change')
    await confirm.trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[['p1'], null]])
    await wrapper.get('[data-testid="account-follow-row-p1"] input').trigger('change')
    expect(wrapper.get('[data-testid="account-follow-confirm"]').attributes('disabled')).toBeDefined()
  })
})
