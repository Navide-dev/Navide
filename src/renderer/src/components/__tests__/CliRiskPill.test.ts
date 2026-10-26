// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import CliRiskPill from '../CliRiskPill.vue'
import type { CliRiskPaneState } from '../../lib/cliRisk'
import { diskSignal, networkSignal, riskState } from '../../composables/__tests__/fixtures/cliRisk'

let wrapper: VueWrapper
const act = vi.fn()

function render(state?: CliRiskPaneState, extra: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(CliRiskPill, {
    props: { paneId: 'pane-a', state, act, ...extra },
    attachTo: document.body,
  })
  return wrapper
}

async function open(): Promise<HTMLElement> {
  await wrapper.get('.cli-risk-inline').trigger('click')
  await flushPromises()
  return document.querySelector<HTMLElement>('.cli-risk-pop')!
}

function actionButton(pop: HTMLElement, text: string): HTMLButtonElement {
  return [...pop.querySelectorAll('button')].find((button) => button.textContent === text)!
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  act.mockReset().mockResolvedValue({ ok: true, payload: { cliRisks: {} }, error: null })
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('CliRiskPill', () => {
  it.each([undefined, 'successful', 'unsupported', 'unknown'] as const)('adds no UI without findings (%s)', (status) => {
    const state = status ? { signals: [], network: { status }, disk: { status } } : undefined
    render(state)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
  })

  it('renders one yellow numeric endpoint pill and exact network evidence', async () => {
    const signal = networkSignal()
    render(riskState([signal]))
    expect(wrapper.findAll('.cli-risk-inline')).toHaveLength(1)
    expect(wrapper.get('.cli-risk-inline').classes()).toContain('yellow')
    expect(wrapper.get('.cli-risk-inline').text()).toBe('▲ 198.51.100.25:443')
    const pop = await open()
    expect(pop.textContent).toContain('Address outside expected set')
    expect(pop.textContent).toContain('2 in last sample')
    expect(pop.textContent).toContain(signal.firstObservedAt)
    expect(pop.textContent).toContain(signal.lastObservedAt)
    expect(pop.textContent).toContain(signal.expectedSetObservedAt)
    expect(pop.textContent).toContain("Observed in this pane's process tree")
    expect(pop.textContent).toContain('across all ports, for codex')
    expect(pop.textContent).toContain('not connection duration')
  })

  it('never lights the pill for a shared-CDN record but lists it in the dialog', async () => {
    const cdn = networkSignal({ id: 'cdn', ip: '162.159.130.53', sharedCdn: 'Cloudflare' })
    render(riskState([cdn]))
    expect(wrapper.find('.cli-risk-inline').exists()).toBe(false)
    wrapper.unmount()
    render(riskState([networkSignal(), cdn]))
    expect(wrapper.get('.cli-risk-inline').text()).toBe('▲ 198.51.100.25:443')
    const pop = await open()
    expect(pop.querySelector('[data-signal-id="cdn"]')?.textContent).toContain('Cloudflare (shared CDN; the site cannot be identified)')
  })

  it('brackets an IPv6 address for the endpoint without resolving a hostname', async () => {
    render(riskState([networkSignal({ ip: '2001:db8::25' })]))
    expect(wrapper.get('.cli-risk-inline').text()).toBe('▲ [2001:db8::25]:443')
    expect((await open()).textContent).toContain('exact IP 2001:db8::25')
  })

  it.each(['yellow', 'red'] as const)('renders %s disk evidence and vendor-wide scope', async (severity) => {
    const signal = diskSignal({ severity })
    render(riskState([signal]))
    expect(wrapper.get('.cli-risk-inline').classes()).toContain(severity)
    const pop = await open()
    expect(pop.textContent).toContain(severity === 'red' ? 'Observed again after absence' : 'Newly observed opaque file')
    expect(pop.textContent).toContain(signal.path)
    expect(pop.textContent).toContain('313 MiB')
    expect(pop.textContent).toContain(signal.firstObservedAt)
    expect(pop.textContent).toContain(signal.lastObservedAt)
    expect(pop.textContent).toContain(signal.absentObservedAt)
    expect(pop.textContent).toContain('Applies to all codex panes')
    expect(actionButton(pop, 'Reveal in Folder')).toBeTruthy()
    expect(actionButton(pop, 'Allow This IP for codex')).toBeUndefined()
    if (severity === 'red') expect(pop.textContent).toContain('do not identify who changed it')
  })

  it('uses backend order for the single pill and all findings without severity sorting', async () => {
    const signals = [networkSignal(), diskSignal()]
    render(riskState(signals))
    expect(wrapper.get('.cli-risk-inline').classes()).toContain('yellow')
    const pop = await open()
    expect([...pop.querySelectorAll('[data-signal-id]')].map((node) => node.getAttribute('data-signal-id'))).toEqual(signals.map((signal) => signal.id))
  })

  it('shows stale status and last-success evidence only in the popover', async () => {
    const state = riskState([networkSignal({ stale: true })])
    state.network.status = 'unknown'
    render(state, { available: false })
    expect(wrapper.get('.cli-risk-inline').text()).toBe('▲ 198.51.100.25:443')
    const pop = await open()
    expect(pop.textContent).toContain('Historical finding')
    expect(pop.textContent).toContain('Unknown')
    expect(pop.textContent).toContain('Last successful sample')
    expect(pop.textContent).toContain(state.network.lastSuccessAt)
    expect(pop.textContent).toContain('Backend unavailable')
  })

  it.each([['Ignore This IP', 'ignore'], ['Allow This IP for codex', 'allow']] as const)('forwards %s by signal identity only', async (button, action) => {
    const signal = networkSignal()
    render(riskState([signal]))
    actionButton(await open(), button).click()
    await flushPromises()
    expect(act).toHaveBeenCalledExactlyOnceWith('pane-a', signal.id, action)
  })

  it('reveals the exact backend path through the native action and does not send a risk mutation', async () => {
    const revealPath = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('agentTeam', { revealPath })
    const signal = diskSignal()
    render(riskState([signal]))
    actionButton(await open(), 'Reveal in Folder').click()
    await flushPromises()
    expect(revealPath).toHaveBeenCalledExactlyOnceWith(signal.path)
    expect(act).not.toHaveBeenCalled()
  })

  it('surfaces native reveal errors', async () => {
    vi.stubGlobal('agentTeam', { revealPath: vi.fn().mockResolvedValue({ ok: false, error: 'Path unavailable' }) })
    render(riskState([diskSignal()]))
    actionButton(await open(), 'Reveal in Folder').click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Path unavailable')
  })

  it('disables repeated mutations while pending and retains the finding on rejection', async () => {
    let finish!: (value: unknown) => void
    act.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(riskState())
    const pop = await open()
    actionButton(pop, 'Ignore This IP').click()
    await nextTick()
    expect(actionButton(pop, 'Allow This IP for codex').disabled).toBe(true)
    actionButton(pop, 'Allow This IP for codex').click()
    expect(act).toHaveBeenCalledTimes(1)
    finish({ ok: false, payload: null, error: { code: 'FORBIDDEN', message: 'Pane is not owned locally' } })
    await flushPromises()
    expect(pop.querySelector('[role="alert"]')?.textContent).toBe('Pane is not owned locally')
    expect(wrapper.find('.cli-risk-inline').exists()).toBe(true)
    expect(actionButton(pop, 'Allow This IP for codex').disabled).toBe(false)
  })

  it('renders backend strings as text and reports transport errors', async () => {
    act.mockRejectedValue(new Error('Backend disconnected'))
    render(riskState([diskSignal({ path: '<img src=x onerror=alert(1)>' })]))
    const pop = await open()
    expect(pop.querySelector('img')).toBeNull()
    expect(pop.textContent).toContain('<img src=x onerror=alert(1)>')
    actionButton(pop, 'Ignore').click()
    await flushPromises()
    expect(pop.querySelector('[role="alert"]')?.textContent).toBe('Backend disconnected')
  })

  it('offers a compact triangle with a full accessible label', () => {
    render(riskState(), { compact: true })
    expect(wrapper.get('.cli-risk-inline').classes()).toContain('compact')
    expect(wrapper.get('.cli-risk-inline').attributes('aria-label')).toContain('198.51.100.25:443')
    expect(wrapper.get('.cli-risk-inline').attributes('title')).toContain('Address outside expected set')
  })

  it('focuses the dialog, cycles action focus, and restores the trigger on Escape', async () => {
    render(riskState())
    const pop = await open()
    expect(document.activeElement).toBe(pop)
    expect(wrapper.get('.cli-risk-inline').attributes('aria-expanded')).toBe('true')
    const buttons = [...pop.querySelectorAll('button')]
    buttons[buttons.length - 1].focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('.cli-risk-inline').element)
  })

  it('dismisses on outside pointer, window blur, or removal of all findings', async () => {
    render(riskState())
    await open()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
    await open()
    window.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
    await open()
    await wrapper.setProps({ state: riskState([]) })
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
    expect(wrapper.find('button').exists()).toBe(false)
  })

  describe('Analyze with CLI', () => {
    const spawn = vi.fn()
    beforeEach(() => { spawn.mockReset().mockResolvedValue({ ok: true, result: 'pane-new' }) })

    it('hides the analyze buttons without a spawner or workspace path', async () => {
      render(riskState([networkSignal()]), { spawn })
      expect((await open()).querySelector('.cli-risk-analyze, .cli-risk-analyze-all')).toBeNull()
      wrapper.unmount()
      render(riskState([networkSignal()]), { workspacePath: '/work/project', agentKey: 'codex' })
      expect((await open()).querySelector('.cli-risk-analyze, .cli-risk-analyze-all')).toBeNull()
    })

    it('spawns the same vendor with all findings from the header button', async () => {
      const signals = [networkSignal(), diskSignal()]
      render(riskState(signals), { spawn, workspacePath: '/work/project', agentKey: 'claude' })
      const pop = await open()
      expect(pop.querySelectorAll('.cli-risk-analyze')).toHaveLength(2)
      actionButton(pop, 'Analyze All with CLI').click()
      await flushPromises()
      expect(spawn).toHaveBeenCalledTimes(1)
      const request = spawn.mock.calls[0][0]
      expect(request.agent).toBe('claude')
      expect(request.name).toMatch(/^risk-[0-9a-f]{6}$/)
      expect(request.task).toContain('pane id: pane-a')
      expect(request.task).toContain('workspace path: /work/project')
      expect(request.task).toContain(`Finding 1 (id: ${signals[0].id})`)
      expect(request.task).toContain(`Finding 2 (id: ${signals[1].id})`)
      expect(request.task).toContain('Respond in English (UI locale: en-US).')
      expect(act).not.toHaveBeenCalled()
      expect(document.querySelector('.cli-risk-pop')).not.toBeNull()
    })

    it('analyzes one finding and falls back to the signal vendor', async () => {
      const signals = [networkSignal(), diskSignal()]
      render(riskState(signals), { spawn, workspacePath: '/work/project' })
      const pop = await open()
      ;(pop.querySelector(`[data-signal-id="${signals[1].id}"] .cli-risk-analyze`) as HTMLButtonElement).click()
      await flushPromises()
      const request = spawn.mock.calls[0][0]
      expect(request.agent).toBe('codex')
      expect(request.task).toContain(`Finding 1 (id: ${signals[1].id})`)
      expect(request.task).not.toContain(signals[0].id)
    })

    it('reopens the dialog to show a failure that lands after it was closed', async () => {
      let finish!: (value: unknown) => void
      spawn.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      render(riskState(), { spawn, workspacePath: '/work/project', agentKey: 'codex' })
      actionButton(await open(), 'Analyze All with CLI').click()
      await nextTick()
      document.querySelector<HTMLElement>('.cli-risk-pop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(document.querySelector('.cli-risk-pop')).toBeNull()
      finish({ ok: false, error: 'ui.pane.create failed to inject task into pane "p9"' })
      await flushPromises()
      expect(document.querySelector('.cli-risk-pop [role="alert"]')?.textContent)
        .toBe('The analysis pane opened, but its task could not be typed in. Paste the task into that pane, or close it and try again.')
    })

    it('disables analysis while the spawn is in flight and surfaces a failure', async () => {
      let finish!: (value: unknown) => void
      spawn.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      render(riskState(), { spawn, workspacePath: '/work/project', agentKey: 'codex' })
      const pop = await open()
      actionButton(pop, 'Analyze All with CLI').click()
      await nextTick()
      expect(actionButton(pop, 'Analyze All with CLI').disabled).toBe(true)
      expect(actionButton(pop, 'Analyze with CLI').disabled).toBe(true)
      expect(actionButton(pop, 'Ignore This IP').disabled).toBe(false)
      actionButton(pop, 'Analyze with CLI').click()
      expect(spawn).toHaveBeenCalledTimes(1)
      finish({ ok: false })
      await flushPromises()
      expect(pop.querySelector('[role="alert"]')?.textContent).toBe('Could not start the analysis CLI pane. Try again.')
      expect(actionButton(pop, 'Analyze All with CLI').disabled).toBe(false)
    })

    it('reports the spawner error inside a localized sentence', async () => {
      spawn.mockResolvedValue({ ok: false, error: 'ui.pane.create requires an agent and an open workspace' })
      render(riskState(), { spawn, workspacePath: '/work/project', agentKey: 'codex' })
      const pop = await open()
      actionButton(pop, 'Analyze with CLI').click()
      await flushPromises()
      expect(pop.querySelector('[role="alert"]')?.textContent)
        .toBe('Could not start the analysis CLI pane (ui.pane.create requires an agent and an open workspace). Try again.')
    })
  })
})

describe('CliRiskPill console', () => {
  const loopback = () => networkSignal({
    id: 'loop', ip: '127.0.0.1', port: 56654, connections: 1,
    lastObservedAt: '2026-09-21T01:30:00Z',
    local: [{ pid: 4312, name: 'claude', command: 'claude --resume' }],
    listener: { status: 'resolved', pid: 8812, name: 'node', command: 'node /repo/node_modules/.bin/vite', observedAt: '2026-09-21T01:30:00Z' },
    history: [
      { at: '2026-09-21T01:20:00Z', connections: 3, local: [{ pid: 4312, name: 'claude' }], listener: { status: 'unknown' } },
      { at: '2026-09-21T01:30:00Z', connections: 1, local: [{ pid: 4312, name: 'claude' }], listener: { status: 'resolved', pid: 8812, name: 'node' } },
    ],
  })

  it('shows who opened a loopback endpoint and who listens on it', async () => {
    render(riskState([loopback()]))
    const pop = await open()
    const details = pop.querySelector('[data-signal-id="loop"]')!.textContent!
    expect(details).toContain('Opened by')
    expect(details).toContain('claude(4312) claude --resume')
    expect(details).toContain('Listening process')
    expect(details).toContain('node(8812) node /repo/node_modules/.bin/vite')
  })

  it('says when the listening process was last resolved', async () => {
    render(riskState([loopback()]))
    const pop = await open()
    const at = pop.querySelector('[data-signal-id="loop"] [data-testid="cli-risk-listener-at"]')!
    expect(at.getAttribute('datetime')).toBe('2026-09-21T01:30:00Z')
    expect(at.textContent).toBe(` · ${new Date('2026-09-21T01:30:00Z').toLocaleTimeString('en-US', { hour12: false })}`)
  })

  it('lists one line per observation, newest first, with unknown never shown as none', async () => {
    render(riskState([loopback(), diskSignal()]))
    const pop = await open()
    const console = pop.querySelector('[data-testid="cli-risk-console"]')!
    expect(console.querySelector('summary')?.textContent).toBe('Observation log')
    const lines = [...console.querySelectorAll('li')].map((li) => li.textContent!)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('claude(4312) → 127.0.0.1:56654  ← node (pid 8812, node /repo/node_modules/.bin/vite)  1 conn.')
    expect(lines[1]).toContain('claude(4312) → 127.0.0.1:56654  ← listener unknown  3 conn.')
    expect(lines[2]).toContain('/vendor-data/pending/archive.enc')
    expect(console.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-21T01:30:00Z')
  })

  it('falls back to the current observation for a signal without history', async () => {
    render(riskState([networkSignal()]))
    const pop = await open()
    const line = pop.querySelector('[data-testid="cli-risk-console"] li')!.textContent!
    expect(line).toContain('Unknown → 198.51.100.25:443')
    expect(line).not.toContain('←')
    expect(line).toContain('2 conn.')
  })
})
