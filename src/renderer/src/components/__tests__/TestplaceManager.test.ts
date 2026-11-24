// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import TestplaceManager from '../TestplaceManager.vue'

// A public test code as the Registry returns it once, built so no scanner reads it as a secret.
const CODE = ['tpc', 'abcdefghijklmnop'].join('_')

describe('TestplaceManager', () => {
  let wrapper: VueWrapper | undefined
  let testplaceManage: ReturnType<typeof vi.fn>
  let codes: Array<Record<string, unknown>>

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    codes = [{ id: 3, state: 'open', testers: 4, max_testers: 50, review_reason: null }]
    testplaceManage = vi.fn(async (_id: string, request: { action: string }) => {
      if (request.action === 'versions') {
        return {
          ok: true, status: 200,
          body: {
            versions: [
              { version: '0.3.0', target: 'darwin-arm64', yanked: false, channel: 'testplace', expires_at: '2026-12-01T00:00:00Z', promotion_status: null },
              { version: '0.3.0', target: 'linux-x64', yanked: false, channel: 'testplace', expires_at: '2026-12-01T00:00:00Z', promotion_status: null },
              { version: '0.2.0', target: 'universal', yanked: false, channel: 'testplace', expires_at: null, promotion_status: 'rejected', promotion_reason: 'name too close' },
            ],
          },
        }
      }
      if (request.action === 'codes') return { ok: true, status: 200, body: { codes } }
      if (request.action === 'code-create') return { ok: true, status: 201, body: { id: 4, state: 'open', max_testers: 200, code: CODE } }
      return { ok: true, status: 200, body: {} }
    })
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { plugins: { testplaceManage } }
  })
  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  async function loaded(): Promise<VueWrapper> {
    const w = mount(TestplaceManager, { global: { plugins: [i18n] } })
    await w.get('#tp-manage-id').setValue('acme.demo')
    await w.get('[data-testid="testplace-manage-load"]').trigger('click')
    await flushPromises()
    return w
  }

  it('lists the test builds and codes of a Navide plugin, with the review reason', async () => {
    wrapper = await loaded()
    expect(testplaceManage).toHaveBeenCalledWith('acme.demo', { action: 'versions' })
    expect(testplaceManage).toHaveBeenCalledWith('acme.demo', { action: 'codes' })
    const builds = wrapper.get('[data-testid="testplace-manage-builds"]').text()
    expect(builds).toContain('darwin-arm64')
    expect(builds).toContain('Review: Rejected')
    expect(builds).toContain('name too close')
    expect(wrapper.get('[data-testid="testplace-manage-codes"]').text()).toContain('4 of 50 testers')
    // One button per version not yet sent to review, whatever its targets.
    expect(wrapper.findAll('[data-testid="testplace-manage-promote"]').map((b) => b.text())).toEqual(['Send 0.3.0 to review'])
  })

  it('sends a build to review only after the user confirms', async () => {
    wrapper = await loaded()
    await wrapper.get('[data-testid="testplace-manage-promote"]').trigger('click')
    await flushPromises()
    expect(testplaceManage).not.toHaveBeenCalledWith('acme.demo', expect.objectContaining({ action: 'promote' }))
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(testplaceManage).toHaveBeenCalledWith('acme.demo', { action: 'promote', version: '0.3.0' })
  })

  it('creates a code for any number of testers and shows it once', async () => {
    wrapper = await loaded()
    await wrapper.get('#tp-manage-max').setValue(200)
    await wrapper.get('[data-testid="testplace-manage-create"]').trigger('click')
    await flushPromises()
    expect(testplaceManage).toHaveBeenCalledWith('acme.demo', { action: 'code-create', maxTesters: 200 })
    expect(wrapper.get('[data-testid="testplace-manage-created"]').text()).toContain(CODE)
  })

  it('revokes a code after the user confirms, and does nothing on cancel', async () => {
    wrapper = await loaded()
    await wrapper.get('[data-testid="testplace-manage-revoke"]').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(false)
    await flushPromises()
    expect(testplaceManage).not.toHaveBeenCalledWith('acme.demo', expect.objectContaining({ action: 'code-revoke' }))
    await wrapper.get('[data-testid="testplace-manage-revoke"]').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()
    expect(testplaceManage).toHaveBeenCalledWith('acme.demo', { action: 'code-revoke', codeId: '3' })
  })

  it('says why the Registry refused', async () => {
    testplaceManage.mockResolvedValue({ ok: false, status: 401, code: 'NOT_SIGNED_IN', message: 'sign in' })
    wrapper = await loaded()
    expect(wrapper.get('.dev-error').text()).toBe('Not signed in to Navide Cloud, or the sign-in expired.')
    expect(wrapper.find('[data-testid="testplace-manage-builds"]').exists()).toBe(false)
  })
})
