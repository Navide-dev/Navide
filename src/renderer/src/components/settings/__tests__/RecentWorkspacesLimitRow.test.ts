// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import RecentWorkspacesLimitRow from '../RecentWorkspacesLimitRow.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'

describe('RecentWorkspacesLimitRow', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function mountRow(limit: number | null) {
    const mock = createMockBackend('connected')
    mock.setResponse('workspace.list_recent', { recent: [], path: '', limit, trimmed: 0 })
    mock.setResponse('workspace.set_recent_limit', { recent: [], limit: null, trimmed: 0 })
    wrapper = mount(RecentWorkspacesLimitRow, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    return mock
  }

  const setCalls = (mock: ReturnType<typeof createMockBackend>) =>
    mock.sent.filter((s) => s.type === 'workspace.set_recent_limit').map((s) => s.payload)

  it('shows the stored limit', async () => {
    await mountRow(1000)
    expect((wrapper!.find('input[type="number"]').element as HTMLInputElement).value).toBe('1000')
  })

  it('turns the limit off', async () => {
    const mock = await mountRow(1000)
    await wrapper!.find('[role="switch"]').trigger('click')
    await flushPromises()
    expect(setCalls(mock)).toEqual([{ limit: null }])
  })

  it('saves a new bound and ignores nonsense', async () => {
    const mock = await mountRow(1000)
    const input = wrapper!.find('input[type="number"]')
    // setValue fires the change event itself.
    await input.setValue('250')
    await input.setValue('0')
    await flushPromises()
    expect(setCalls(mock)).toEqual([{ limit: 250 }])
  })

  it('has no number field while the limit is off', async () => {
    await mountRow(null)
    expect(wrapper!.find('input[type="number"]').exists()).toBe(false)
  })
})
