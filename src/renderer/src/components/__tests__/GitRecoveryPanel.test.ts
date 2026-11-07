// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import GitRecoveryPanel from '../GitRecoveryPanel.vue'

let originalAgentTeam: typeof window.agentTeam

beforeEach(() => {
  originalAgentTeam = window.agentTeam
  i18n.global.locale.value = 'en-US'
})

afterEach(() => {
  window.agentTeam = originalAgentTeam
})

function withRestore(restoreFactoryPackage: ReturnType<typeof vi.fn>): void {
  window.agentTeam = { plugins: { restoreFactoryPackage } } as unknown as typeof window.agentTeam
}

describe('GitRecoveryPanel', () => {
  it('explains the failure with the Host reason', () => {
    withRestore(vi.fn())
    const wrapper = mount(GitRecoveryPanel, {
      props: { reason: 'activation timed out' },
      global: { plugins: [i18n] },
    })

    expect(wrapper.text()).toContain('Built-in Git could not start')
    expect(wrapper.find('[data-git-recovery-reason]').text()).toBe('Reason: activation timed out')
  })

  it('omits the reason line when the Host gave none', () => {
    withRestore(vi.fn())
    const wrapper = mount(GitRecoveryPanel, { global: { plugins: [i18n] } })

    expect(wrapper.find('[data-git-recovery-reason]').exists()).toBe(false)
  })

  it('reinstalls the bundled Git package through the factory restore', async () => {
    const restoreFactoryPackage = vi.fn().mockResolvedValue({ ok: true })
    withRestore(restoreFactoryPackage)
    const wrapper = mount(GitRecoveryPanel, { global: { plugins: [i18n] } })

    await wrapper.find('[data-git-recovery-reinstall]').trigger('click')
    await flushPromises()

    expect(restoreFactoryPackage).toHaveBeenCalledWith('navide.git')
    expect(wrapper.find('[data-git-recovery-error]').exists()).toBe(false)
  })

  it('shows why a reinstall failed and allows another attempt', async () => {
    const restoreFactoryPackage = vi.fn().mockRejectedValue(new Error('factory package is opted out'))
    withRestore(restoreFactoryPackage)
    const wrapper = mount(GitRecoveryPanel, { global: { plugins: [i18n] } })

    await wrapper.find('[data-git-recovery-reinstall]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-git-recovery-error]').text()).toContain('factory package is opted out')
    expect(wrapper.find('[data-git-recovery-reinstall]').attributes('disabled')).toBeUndefined()
  })
})
