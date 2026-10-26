// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { guardKey, useGuard } from '../../composables/useGuard'
import PaneGuardIcon from '../PaneGuardIcon.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

async function title(store = useGuard(mock.backend)): Promise<string | undefined> {
  wrapper ??= mount(PaneGuardIcon, {
    props: { paneId: 'p1' },
    global: { plugins: [i18n], provide: { [guardKey as symbol]: store } },
  })
  await flushPromises()
  return wrapper.get('[data-testid="guard-sidebar-icon"]').attributes('title')
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  mock.setResponse('guard.taint.list', {
    panes: [{ pane_id: 'p1', sources: ['remote'], since: 1_700_000_000, detail: '' }],
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('PaneGuardIcon', () => {
  it('is titled with the badge name alone while Guard is on', async () => {
    mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: {} })
    expect(await title()).toBe('External influence')
  })

  it('says nothing is asked while Guard is off', async () => {
    mock.setResponse('guard.status', { enabled: false, counts: {}, hook_support: {} })
    expect(await title()).toBe(`External influence — ${i18n.global.t('guard.pane.explain-off')}`)
  })

  it('follows the switch on, off and on again, keeping the mark', async () => {
    mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: {} })
    mock.setResponse('guard.set_enabled', {})
    const store = useGuard(mock.backend)
    expect(await title(store)).toBe('External influence')
    mock.setResponse('guard.status', { enabled: false, counts: {}, hook_support: {} })
    await store.setEnabled(false)
    expect(await title(store)).toBe(`External influence — ${i18n.global.t('guard.pane.explain-off')}`)
    mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: {} })
    await store.setEnabled(true)
    expect(await title(store)).toBe('External influence')
    expect(store.taintFor('p1')).not.toBeNull()
  })
})
