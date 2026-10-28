// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import AgentAccountSwitchConfirmDialog from '../AgentAccountSwitchConfirmDialog.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { AgentAccountSwitchConfirmRequest } from '../../lib/agentAccountSwitch'

// Plan mcp_614482 P3: the user's yes before an agent's cli_account_switch
// runs. It starts on Cancel, says which agent asked and which account it
// switches from and to, and shows the agent's reason as the agent's,
// invisible characters revealed.
const request: AgentAccountSwitchConfirmRequest = {
  agentKey: 'claude',
  fromLabel: 'Personal',
  toLabel: 'Work',
  callerPaneId: 'pa',
  callerName: 'builder​',
  workspacePath: '/Users/me/project',
  reason: 'quota ran out‮ on the active account',
  reasonTruncated: false,
  confirmBy: Date.now() + 45_000,
}

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

function render(over: Partial<AgentAccountSwitchConfirmRequest> = {}): VueWrapper {
  wrapper = mount(AgentAccountSwitchConfirmDialog, {
    props: { request: { ...request, ...over } },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  return wrapper
}

describe('AgentAccountSwitchConfirmDialog', () => {
  it('starts on Cancel', async () => {
    render()
    await flushPromises()
    await nextTick()
    expect(document.activeElement?.classList.contains('switch-confirm-cancel')).toBe(true)
  })

  it('names the vendor, both accounts, the calling pane and its workspace', () => {
    const text = render().text()
    expect(text).toContain('claude')
    expect(text).toContain('Personal')
    expect(text).toContain('Work')
    expect(text).toContain('builder\\u{200b}')
    expect(text).toContain('/Users/me/project')
  })

  it('says a yes switches even if the agent stops waiting, and may restart its own pane', () => {
    expect(render().text()).toContain(i18n.global.t('settings.accounts.cli.agent-switch-confirm-late'))
  })

  it("labels the reason as the agent's and reveals invisible characters", () => {
    const dialog = render()
    expect(dialog.text()).toContain(i18n.global.t('settings.accounts.cli.agent-switch-confirm-reason'))
    expect(dialog.get('[data-testid="switch-confirm-reason"]').text())
      .toBe('quota ran out\\u{202e} on the active account')
  })

  it('says when the backend cut the reason, and only then', () => {
    const note = i18n.global.t('settings.accounts.cli.agent-switch-confirm-reason-truncated')
    expect(render().text()).not.toContain(note)
    wrapper!.unmount()
    expect(render({ reasonTruncated: true }).get('[data-testid="switch-confirm-truncated"]').text()).toBe(note)
  })

  it('answers yes only from the confirm button', async () => {
    const dialog = render()
    await dialog.get('.switch-confirm-cancel').trigger('click')
    await dialog.get('.switch-confirm-ok').trigger('click')
    expect(dialog.emitted('answer')).toEqual([[false], [true]])
  })

  it('takes Escape as no', async () => {
    const dialog = render()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(dialog.emitted('answer')).toEqual([[false]])
  })

  // Plan mcp-pane-cli-usage_213031 P4: a switch of one pane (cli_account_switch
  // pane_id) names that pane and says the live login and other panes stay.
  it('names the pane and drops the CLI-wide wording for a single-pane switch', () => {
    const text = (render({ paneName: 'worker\u200b' } as Partial<AgentAccountSwitchConfirmRequest>)).text()
    expect(text).toContain(i18n.global.t('settings.accounts.cli.agent-switch-confirm-pane-body'))
    expect(text).toContain('worker\\u{200b}')
    expect(text).not.toContain(i18n.global.t('settings.accounts.cli.agent-switch-confirm-late'))
  })

  it('shows no pane row for a CLI-wide switch', () => {
    const dialog = render()
    expect(dialog.find('[data-testid="switch-confirm-pane"]').exists()).toBe(false)
    expect(dialog.find('[data-testid="switch-confirm-pane-body"]').exists()).toBe(false)
  })
})
