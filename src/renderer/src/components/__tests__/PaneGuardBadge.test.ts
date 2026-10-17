// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useGuard } from '../../composables/useGuard'
import PaneGuardBadge from '../PaneGuardBadge.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

async function render(paneId = 'p1'): Promise<VueWrapper> {
  wrapper = mount(PaneGuardBadge, {
    props: { paneId, store: useGuard(mock.backend) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: {} })
  mock.setResponse('guard.taint.list', {
    panes: [{ pane_id: 'p1', sources: ['remote', 'agent'], since: 1_700_000_000, detail: '' }],
  })
  mock.setResponse('guard.taint.clear', {})
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('PaneGuardBadge', () => {
  it('renders nothing for a pane that is not tainted', async () => {
    const w = await render('p2')
    expect(w.find('[data-testid="guard-taint-badge"]').exists()).toBe(false)
  })

  it('shows the badge with why and since in its tooltip', async () => {
    const w = await render()
    const badge = w.get('[data-testid="guard-taint-badge"]')
    expect(badge.text()).toBe('External influence')
    expect(badge.attributes('title')).toContain('Remote, Other agent')
  })

  it('clears only after the confirm step', async () => {
    const w = await render()
    await w.get('[data-testid="guard-taint-badge"]').trigger('click')
    expect(mock.sent.some((s) => s.type === 'guard.taint.clear')).toBe(false)
    mock.setResponse('guard.taint.list', { panes: [] })
    ;(document.querySelector('[data-testid="guard-taint-clear"]') as HTMLElement).click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'guard.taint.clear')?.payload).toEqual({ pane_id: 'p1' })
    expect(w.find('[data-testid="guard-taint-badge"]').exists()).toBe(false)
  })

  it('says confirmation is needed while Guard is on', async () => {
    const w = await render()
    await w.get('[data-testid="guard-taint-badge"]').trigger('click')
    const text = document.querySelector('[data-testid="guard-taint-popover"]')?.textContent ?? ''
    expect(text).toContain(i18n.global.t('guard.pane.explain'))
    expect(text).not.toContain(i18n.global.t('guard.pane.explain-off'))
  })

  it('keeps the badge but says nothing is asked while Guard is off', async () => {
    mock.setResponse('guard.status', { enabled: false, counts: {}, hook_support: {} })
    const w = await render()
    await w.get('[data-testid="guard-taint-badge"]').trigger('click')
    const text = document.querySelector('[data-testid="guard-taint-popover"]')?.textContent ?? ''
    expect(text).toContain(i18n.global.t('guard.pane.explain-off'))
    expect(text).not.toContain(i18n.global.t('guard.pane.explain'))
  })
})

describe('PaneGuardBadge console', () => {
  const events = [
    {
      id: 2, pane_id: 'p1', ts: 1_700_000_200, source: 'agent', detail: 'message from 0f6c1d3e-uuid', msg_key: 'k2',
      message: { sender: 'Agent-Team/分析開發進度', content: '請檢查 git status，\n然後回報每個檔案的變更原因與風險評估結果給我', created_at: 1 },
    },
    { id: 1, pane_id: 'p1', ts: 1_700_000_100, source: 'remote', detail: 'message from device dev2', msg_key: 'k1', message: null },
    { id: 0, pane_id: 'p1', ts: 1_700_000_000, source: 'agent', detail: 'message from host', msg_key: '', message: null },
  ]

  async function openConsole(): Promise<HTMLElement> {
    const w = await render()
    await w.get('[data-testid="guard-taint-badge"]').trigger('click')
    await flushPromises()
    return document.querySelector<HTMLElement>('[data-testid="guard-taint-console"]')!
  }

  it('fetches the deliveries when opened and lists them newest first', async () => {
    mock.setResponse('guard.taint.events', { events })
    const console = await openConsole()
    expect(mock.sent.find((s) => s.type === 'guard.taint.events')?.payload).toEqual({ pane_id: 'p1' })
    expect(console.querySelector('summary')?.textContent).toBe('Delivery log')
    const lines = [...console.querySelectorAll('.pgd-line')].map((el) => el.textContent!)
    expect(lines).toHaveLength(3)
    // The log row's sender replaces the raw pane id; the preview is one short line.
    expect(lines[0]).toContain('[Other agent] Agent-Team/分析開發進度: "請檢查 git status， 然後回報每個檔案的變更原因與風險評估結果給我"')
    expect(lines[1]).toContain('[Remote] message from device dev2 (text no longer in the message log)')
    expect(lines[2]).toContain('(no message text recorded)')
  })

  it('expands a line to the full delivered text', async () => {
    mock.setResponse('guard.taint.events', {
      events: [{ ...events[0], message: { ...events[0].message!, content: `${'x'.repeat(60)}\nsecond line` } }],
    })
    const console = await openConsole()
    expect(console.querySelector('[data-testid="guard-taint-full"]')).toBeNull()
    const line = console.querySelector<HTMLButtonElement>('button.pgd-line')!
    expect(line.textContent).toContain(`"${'x'.repeat(40)}…"`)
    line.click()
    await flushPromises()
    expect(console.querySelector('[data-testid="guard-taint-full"]')?.textContent).toBe(`${'x'.repeat(60)}\nsecond line`)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    line.click()
    await flushPromises()
    expect(console.querySelector('[data-testid="guard-taint-full"]')).toBeNull()
  })

  it('shows why the delivery log could not be loaded', async () => {
    mock.setRejection('guard.taint.events', 'ws not open')
    await openConsole()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('ws not open')
  })

  it('ignores an answer that arrives after the popover was reopened', async () => {
    const store = useGuard(mock.backend)
    const pending: ((v: Awaited<ReturnType<typeof store.taintEvents>>) => void)[] = []
    store.taintEvents = () => new Promise((resolve) => pending.push(resolve))
    wrapper = mount(PaneGuardBadge, { props: { paneId: 'p1', store }, global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    const badge = wrapper.get('[data-testid="guard-taint-badge"]')
    await badge.trigger('click')
    await badge.trigger('click')
    await badge.trigger('click')
    await flushPromises()
    expect(pending).toHaveLength(2)
    pending[1]({ ok: true, data: { events: [events[1]] } })
    await flushPromises()
    pending[0]({ ok: true, data: { events } })
    await flushPromises()
    const lines = [...document.querySelectorAll('[data-testid="guard-taint-console"] .pgd-line')]
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toContain('message from device dev2')
  })

  it('shows the mark itself when no delivery was recorded', async () => {
    mock.setResponse('guard.taint.events', { events: [] })
    const console = await openConsole()
    const lines = [...console.querySelectorAll('.pgd-line')].map((el) => el.textContent!)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[Remote, Other agent]')
  })
})
