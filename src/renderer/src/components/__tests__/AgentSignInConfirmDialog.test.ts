// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import AgentSignInConfirmDialog from '../AgentSignInConfirmDialog.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { AgentSignInConfirmRequest } from '../../lib/agentSignIn'

// LOW-3 (review #433): the user's yes before an agent's sign-in starts. It
// starts on Cancel, says who asked, for which account and where the sign-in
// pane opens, and shows the agent's reason as the agent's, invisible
// characters revealed.
const request: AgentSignInConfirmRequest = {
  agentKey: 'codex',
  profileId: 'p-parked',
  mode: 'isolated',
  accountLabel: 'Work',
  callerPaneId: 'pa',
  callerName: 'builder​',
  workspacePath: '/Users/me/project',
  reason: 'quota ran out‮ on the active account',
  reasonTruncated: false,
  confirmBy: Date.now() + 45_000,
}

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

function render(over: Partial<AgentSignInConfirmRequest> = {}): VueWrapper {
  wrapper = mount(AgentSignInConfirmDialog, {
    props: { request: { ...request, ...over } },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  return wrapper
}

describe('AgentSignInConfirmDialog', () => {
  it('starts on Cancel', async () => {
    render()
    await flushPromises()
    await nextTick()
    expect(document.activeElement?.classList.contains('signin-confirm-cancel')).toBe(true)
  })

  it('names the vendor, the account, the calling pane and the workspace the pane opens in', () => {
    const text = render().text()
    expect(text).toContain('codex')
    expect(text).toContain('Work')
    expect(text).toContain('builder\\u{200b}')
    expect(text).toContain('/Users/me/project')
  })

  it("labels the reason as the agent's and reveals invisible characters", () => {
    const dialog = render()
    expect(dialog.text()).toContain(i18n.global.t('settings.accounts.cli.agent-login-confirm-reason'))
    expect(dialog.get('[data-testid="signin-confirm-reason"]').text())
      .toBe('quota ran out\\u{202e} on the active account')
  })

  it('says when the backend cut the reason, and only then (review #438 LOW-2)', () => {
    const note = i18n.global.t('settings.accounts.cli.agent-login-confirm-reason-truncated')
    expect(render().text()).not.toContain(note)
    wrapper!.unmount()
    expect(render({ reasonTruncated: true }).get('[data-testid="signin-confirm-truncated"]').text()).toBe(note)
  })

  it('answers yes only from the confirm button', async () => {
    const dialog = render()
    await dialog.get('.signin-confirm-cancel').trigger('click')
    await dialog.get('.signin-confirm-ok').trigger('click')
    expect(dialog.emitted('answer')).toEqual([[false], [true]])
  })

  it('takes Escape as no', async () => {
    const dialog = render()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(dialog.emitted('answer')).toEqual([[false]])
  })
})
