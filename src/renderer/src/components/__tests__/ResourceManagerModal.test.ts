// @vitest-environment happy-dom
// ResourceManagerModal (the in-window Resource Manager) — it owns no pane state
// and no sampling loop, so every assertion is on the seams it does have: the
// backend roster it merges names from, the host's sweep it renders, and the
// main-process relay its two row actions go through.
//
// The differencing itself is useResourceUsage's and is tested there; here the
// sweep is a stub so each case can pin exact figures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import ResourceManagerModal from '../ResourceManagerModal.vue'

const MB = 1024 * 1024
const GB = 1024 * MB

const wire = vi.hoisted(() => ({
  status: 'connected' as string,
  panes: [] as Array<Record<string, unknown>>,
  diskOk: true,
  calls: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
}))

function fakeBackend() {
  return {
    status: ref(wire.status),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, sent?: Record<string, unknown>) => {
      wire.calls.push({ type, payload: sent })
      const payload =
        type === 'agent_msg.list'
          ? { panes: wire.panes }
          : type === 'storage.usage'
            ? wire.diskOk
              ? {
                  generatedAt: '2026-09-13T00:00:00.000Z',
                  staleDays: 30,
                  totalBytes: 7 * GB,
                  disk: { totalBytes: 500 * GB, freeBytes: 120 * GB },
                  groups: [],
                  errors: [],
                }
              : {}
            : { ok: true }
      return { id: 'r', type, ok: true, payload, error: null, timestamp: '' }
    }),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

/** The host's sampling loop, stubbed to exact figures. */
function fakeUsage(
  bytes: Record<string, number> = {},
  cpu: Record<string, number | null> = {},
  over: Partial<{ available: boolean; cpuAvailable: boolean; measured: boolean; cpuCount: number }> = {}
) {
  const bytesByPaneId = ref(new Map(Object.entries(bytes)))
  const cpuPercentByPaneId = ref(new Map(Object.entries(cpu)))
  const paneIdByKey = ref(new Map<string, string>())
  const refresh = vi.fn(async () => undefined)
  return {
    api: {
      bytesByKey: ref(new Map<string, number>()),
      cpuPercentByKey: ref(new Map<string, number | null>()),
      bytesByPaneId,
      cpuPercentByPaneId,
      paneIdByKey,
      totalBytes: computed(() => 0),
      totalCpuPercent: computed(() => null),
      cpuShare: computed(() => null),
      memoryShare: computed(() => null),
      cpuCount: ref(over.cpuCount ?? 4),
      machineMemoryBytes: ref(4 * GB),
      available: ref(over.available ?? true),
      cpuAvailable: ref(over.cpuAvailable ?? true),
      measured: ref(over.measured ?? true),
      refresh,
      stop: vi.fn(),
    } as unknown as never,
    refresh,
  }
}

/** A row as the host resolves it — pane id plus the key its figures sat under. */
function localRow(over: Record<string, unknown> = {}) {
  return {
    paneId: 'p1',
    measuredKey: 'p1',
    name: 'Scan the code',
    vendor: 'claude',
    foreignWorkspace: 'Agent-Team',
    status: 'idle' as const,
    bytes: 300 * MB,
    cpuPercent: 1,
    reclaimable: false,
    ...over,
  }
}

const paneAction = vi.fn(async () => ({ ok: true }) as { ok?: boolean; error?: string })

beforeEach(() => {
  wire.status = 'connected'
  wire.diskOk = true
  wire.calls = []
  wire.panes = [
    { pane_id: 'p1', name: 'Scan the code', workspace_label: 'Agent-Team', agent_key: 'claude', busy: false, offline: false },
    { pane_id: 'p2', name: 'Deploy notes', workspace_label: 'care-platform', agent_key: 'codex', busy: true, offline: false },
  ]
  paneAction.mockReset()
  paneAction.mockResolvedValue({ ok: true })
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { requestPaneAction: paneAction }
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const DEFAULT_BYTES = { p1: 300 * MB, p2: 600 * MB }
const DEFAULT_CPU = { p1: 1, p2: 100 }

async function mountModal(
  opts: {
    open?: boolean
    bytes?: Record<string, number>
    cpu?: Record<string, number | null>
    usageOver?: Parameters<typeof fakeUsage>[2]
    localRows?: ReturnType<typeof localRow>[]
    autoReclaimMinutes?: string
    workspacePaths?: string[]
    /** Mount the real Teleport into document.body instead of stubbing it. */
    realTeleport?: boolean
  } = {}
): Promise<{ w: VueWrapper; refresh: ReturnType<typeof vi.fn> }> {
  const usage = fakeUsage(opts.bytes ?? DEFAULT_BYTES, opts.cpu ?? DEFAULT_CPU, opts.usageOver)
  const w = mount(ResourceManagerModal, {
    props: {
      open: opts.open ?? true,
      backend: fakeBackend(),
      usage: usage.api,
      localRows: opts.localRows ?? [],
      autoReclaimOn: true,
      autoReclaimMinutes: opts.autoReclaimMinutes ?? '45',
      workspacePaths: opts.workspacePaths,
    },
    // The modal teleports to <body>; stubbing that keeps the tree inside the
    // wrapper, which is what every query here reads from.
    global: { plugins: [i18n], stubs: opts.realTeleport ? {} : { teleport: true } },
    attachTo: opts.realTeleport ? document.body : undefined,
  })
  await flushPromises()
  return { w, refresh: usage.refresh }
}

// `.nv-modal-overlay` only skins the scrim — its own comment says it sets no
// display/position/overflow on purpose, so every modal must position its own.
// Without that the card renders into the document flow with no size and no
// stacking context: the modal opens and nothing appears, which is exactly what
// shipped here once. Mounted tests cannot catch it (they stub the teleport and
// never lay anything out), so this reads the stylesheet.
describe('ResourceManagerModal layout', () => {
  it('positions its own overlay rather than relying on the shared skin', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync('src/renderer/src/components/ResourceManagerModal.vue', 'utf8')
    const overlay = source.slice(source.indexOf('.rm-overlay {'), source.indexOf('.rm-modal {'))
    expect(overlay).toContain('position: fixed')
    expect(overlay).toContain('inset: 0')
    // A stacking level of its own, said however — a literal number is exactly
    // what buried the pairing prompt behind another modal, so this must not be
    // the thing that requires one. See stackingOrder.test.ts.
    expect(overlay).toMatch(/z-index:\s*\S/)
    expect(overlay).toContain('display: flex')
  })

  // Same trap one level in: .nv-modal-shell--wide is a skin, and the repo's
  // other modals (.pm-modal) set their own box. Without a width the table's
  // content decides it, and a ten-row table decides "as wide as the screen".
  it('sets its own width and height rather than letting the table decide', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync('src/renderer/src/components/ResourceManagerModal.vue', 'utf8')
    const modal = source.slice(source.indexOf('.rm-modal {'), source.indexOf('.rm-spacer'))
    expect(modal).toContain('width: min(var(--modal-w-wide)')
    expect(modal).toMatch(/height:\s*min\(/)
  })
})

describe('ResourceManagerModal', () => {
  it('lists every pane in the roster, whichever window owns it', async () => {
    const { w } = await mountModal()
    const names = w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())
    expect(names).toContain('Scan the code')
    expect(names).toContain('Deploy notes')
    expect(w.text()).toContain('care-platform')
    w.unmount()
  })

  it('renders the host sweep onto each row', async () => {
    const { w } = await mountModal()
    const row = w.get('[data-pane="p2"]')
    expect(row.get('[data-part="memory"]').text()).toBe('600 MB')
    expect(row.get('[data-part="cpu"]').text()).toBe('100%')
    w.unmount()
  })

  // The first reading has nothing to difference against; the host reports null.
  it('dashes a pane whose CPU is not knowable yet', async () => {
    const { w } = await mountModal({ cpu: { p1: null, p2: null } })
    expect(w.get('[data-pane="p1"] [data-part="cpu"]').text()).toBe('—')
    w.unmount()
  })

  // 900 MB of 4 GB, and 101% of four cores.
  it('totals the rows and states the machine share', async () => {
    const { w } = await mountModal()
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('900 MB')
    expect(w.get('[data-metric="memory"]').text()).toContain('22%')
    expect(w.get('[data-metric="cpu"] [data-part="value"]').text()).toBe('101%')
    expect(w.get('[data-metric="cpu"]').text()).toContain('25%')
    w.unmount()
  })

  // registerPaneMessaging skips plain terminal panes, so the roster never lists
  // a shell running a build — which is exactly what you open this for.
  it('lists a measured pane the roster does not know about', async () => {
    const { w } = await mountModal({ bytes: { ...DEFAULT_BYTES, 'shell-1': 900 * MB } })
    const row = w.get('[data-pane="shell-1"]')
    expect(row.get('.rm-name').text()).toBe(i18n.global.t('resource.unnamed-pane'))
    expect(row.get('[data-part="memory"]').text()).toBe('900 MB')
    w.unmount()
  })

  it('counts that pane in the machine total', async () => {
    const { w } = await mountModal({ bytes: { ...DEFAULT_BYTES, 'shell-1': 900 * MB } })
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('1.8 GB')
    w.unmount()
  })

  it('filters to running and idle', async () => {
    const { w } = await mountModal()
    await w.get('[data-filter="running"]').trigger('click')
    expect(w.findAll('[data-row="pane"]')).toHaveLength(1)
    expect(w.get('[data-row="pane"] .rm-name').text()).toBe('Deploy notes')
    await w.get('[data-filter="idle"]').trigger('click')
    expect(w.get('[data-row="pane"] .rm-name').text()).toBe('Scan the code')
    w.unmount()
  })

  // A pane blocked on a permission prompt used to be rewritten to 'running' on
  // its way into this table: green dot, counted as busy, hidden among the panes
  // that were actually working. It is the one row you open this list to find.
  it('keeps an awaiting pane as its own state rather than folding it into running', async () => {
    const { w } = await mountModal({
      localRows: [localRow({ paneId: 'p9', measuredKey: 'p9', name: 'Blocked here', status: 'awaiting' })],
    })
    const row = w.findAll('[data-row="pane"]').find((r) => r.text().includes('Blocked here'))
    expect(row?.attributes('data-status')).toBe('awaiting')
    w.unmount()
  })

  // Named so the two orders differ: p2 holds twice the memory, p1 sorts first.
  it('sorts by memory by default and by name on request', async () => {
    wire.panes = [
      { pane_id: 'p1', name: 'Alpha scan', workspace_label: 'ws', agent_key: 'claude', busy: false, offline: false },
      { pane_id: 'p2', name: 'Zeta deploy', workspace_label: 'ws', agent_key: 'codex', busy: false, offline: false },
    ]
    const { w } = await mountModal()
    expect(w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())).toEqual([
      'Zeta deploy',
      'Alpha scan',
    ])
    await w.get('[data-act="sort"]').setValue('name')
    expect(w.findAll('[data-row="pane"] .rm-name').map((n) => n.text())).toEqual([
      'Alpha scan',
      'Zeta deploy',
    ])
    w.unmount()
  })

  // Focusing and reclaiming only exist in the window that owns the pane — and
  // the relay covers this window too, so one path serves both.
  it('relays a jump and closes, because you are going to look at that pane', async () => {
    const { w } = await mountModal()
    await w.get('[data-pane="p1"] .rm-jump').trigger('click')
    await flushPromises()
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'focus' })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('relays a reclaim and re-measures on success, staying open', async () => {
    const { w, refresh } = await mountModal()
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(paneAction).toHaveBeenCalledWith({ paneId: 'p1', action: 'reclaim' })
    expect(refresh).toHaveBeenCalled()
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  // A busy pane refuses; the row says so rather than the click doing nothing.
  it('explains a refused reclaim on the row', async () => {
    paneAction.mockResolvedValue({ error: 'blocked' })
    const { w } = await mountModal()
    await w.get('[data-pane="p2"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p2"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.reclaim-blocked')
    )
    w.unmount()
  })

  it('says the pane is gone when no window claims it', async () => {
    paneAction.mockResolvedValue({ error: 'not-found' })
    const { w } = await mountModal()
    await w.get('[data-pane="p1"] [data-act="reclaim"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pane="p1"] [data-part="notice"]').text()).toBe(
      i18n.global.t('resource.pane-gone')
    )
    w.unmount()
  })

  // Showing an unmeasured pane as 0 reads as "this one is free".
  it('dashes the figures when the platform cannot measure', async () => {
    const { w } = await mountModal({ usageOver: { available: false, cpuAvailable: false } })
    expect(w.get('[data-metric="memory"] [data-part="value"]').text()).toBe('—')
    expect(w.get('[data-pane="p1"] [data-part="cpu"]').text()).toBe('—')
    expect(w.text()).toContain(i18n.global.t('resource.unavailable'))
    w.unmount()
  })

  it('says so when nothing is running', async () => {
    wire.panes = []
    const { w } = await mountModal({ bytes: {}, cpu: {} })
    expect(w.get('[data-row="empty"]').text()).toBe(i18n.global.t('resource.window-empty'))
    w.unmount()
  })

  // Read-only: it is set in Settings › General, and explains what will happen
  // to the idle rows on its own.
  it('reports the auto-reclaim setting it does not own', async () => {
    const { w } = await mountModal()
    expect(w.text()).toContain('45')
    w.unmount()
  })

  // 'never' is a sentinel, not a duration: rendered through the line that ends
  // in "min" it would read "idle never min".
  it('reads the never threshold as off rather than as a number of minutes', async () => {
    const { w } = await mountModal({ autoReclaimMinutes: 'never' })
    expect(w.text()).toContain(i18n.global.t('resource.auto-reclaim-disabled'))
    expect(w.text()).not.toContain('never min')
    expect(w.text()).not.toContain('never 分鐘')
    w.unmount()
  })

  // A closed modal polling the roster is pure cost.
  it('does not touch the backend while closed', async () => {
    const { w } = await mountModal({ open: false })
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(false)
    await w.setProps({ open: true })
    await flushPromises()
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(true)
    w.unmount()
  })

  it('does not poll while the backend is away', async () => {
    wire.status = 'starting'
    const { w } = await mountModal()
    expect(wire.calls.some((c) => c.type === 'agent_msg.list')).toBe(false)
    w.unmount()
  })

  // This is the bug the modal shipped with: a pane rebuilt around a new PTY
  // keeps its terminal session while its pane id moves on, so the sweep still
  // reports it under the id the PTY was created with. Keyed by pane id alone,
  // the same CLI appeared twice — once named at 0 B (the roster's current id),
  // once anonymous holding the real figures (the sweep's stale id).
  it('lists a rebuilt pane once, with its figures', async () => {
    wire.panes = [
      { pane_id: 'new-1', name: 'Scan the code', workspace_label: 'Agent-Team', agent_key: 'claude', busy: false, offline: false },
    ]
    const { w } = await mountModal({
      // The sweep only knows the pane id the PTY was created under.
      bytes: { 'old-1': 300 * MB },
      cpu: { 'old-1': 4 },
      localRows: [localRow({ paneId: 'new-1', measuredKey: 'old-1', bytes: 300 * MB, cpuPercent: 4 })],
    })
    const rows = w.findAll('[data-row="pane"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('.rm-name').text()).toBe('Scan the code')
    expect(rows[0].get('[data-part="memory"]').text()).toBe('300 MB')
    expect(w.text()).not.toContain(i18n.global.t('resource.unnamed-pane'))
    w.unmount()
  })

  // The host knows this window's panes better than the roster does, so its row
  // wins — including the figures it resolved by session id.
  it('prefers the host row over the roster entry for the same pane', async () => {
    const { w } = await mountModal({
      bytes: { p1: 0 },
      localRows: [localRow({ paneId: 'p1', measuredKey: 'p1', name: 'Renamed here', bytes: 512 * MB })],
    })
    const row = w.get('[data-pane="p1"]')
    expect(row.get('.rm-name').text()).toBe('Renamed here')
    expect(row.get('[data-part="memory"]').text()).toBe('512 MB')
    w.unmount()
  })

  // The scan walks several large trees, so it is a button rather than part of
  // the sampling loop — nothing should ask for it on its own.
  //
  // These two mount the real Teleport: the stub re-creates its slot content on
  // every render, which remounts the Storage section and drops its open/closed
  // state — an artifact of the stub, not of the modal.
  it('does not scan the disk until asked', async () => {
    const { w } = await mountModal({ workspacePaths: ['/Users/test/code/demo'], realTeleport: true })
    const q = (sel: string) => document.querySelector<HTMLElement>(sel)
    expect(wire.calls.some((c) => c.type === 'storage.usage')).toBe(false)
    expect(q('[data-part="disk"]')?.textContent?.trim()).toBe(i18n.global.t('resource.disk-unscanned'))
    expect(q('[data-metric="disk"] [data-part="value"]')?.textContent?.trim()).toBe('—')
    // The Storage section below the table is the same report, also unscanned.
    expect(q('[data-part="storage"]')?.dataset.open).toBe('false')

    q('[data-act="scan-disk"]')?.click()
    await flushPromises()
    const scan = wire.calls.find((c) => c.type === 'storage.usage')
    // The host's workspace list rides along, as it did from the Settings page.
    expect(scan?.payload).toEqual({ workspacePaths: ['/Users/test/code/demo'], staleDays: 30 })
    expect(q('[data-part="disk"]')?.textContent).toContain('120 GB')
    expect(q('[data-metric="disk"] [data-part="value"]')?.textContent?.trim()).toBe('7.0 GB')
    // One scan feeds both surfaces: the section opened on the same report,
    // and the card's Scan button yields to the section's Rescan.
    expect(q('[data-part="storage"]')?.dataset.open).toBe('true')
    expect(q('[data-act="scan-disk"]')).toBeNull()
    expect(wire.calls.filter((c) => c.type === 'storage.usage')).toHaveLength(1)
    w.unmount()
  })

  it('scans from the Storage section header too, sharing the one report', async () => {
    const { w } = await mountModal({ realTeleport: true })
    const q = (sel: string) => document.querySelector<HTMLElement>(sel)
    q('[data-act="rescan"]')?.click()
    await flushPromises()
    expect(wire.calls.filter((c) => c.type === 'storage.usage')).toHaveLength(1)
    expect(q('[data-part="disk"]')?.textContent).toContain('120 GB')
    expect(q('[data-part="storage"]')?.dataset.open).toBe('true')
    w.unmount()
  })

  it('says the scan failed rather than showing nothing', async () => {
    wire.diskOk = false
    const { w } = await mountModal()
    await w.get('[data-act="scan-disk"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-part="disk"]').text()).toBe(i18n.global.t('resource.disk-failed'))
    w.unmount()
  })

  it('closes on its own button', async () => {
    const { w } = await mountModal()
    await w.get('[data-act="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('renders no untranslated i18n keys in either locale', async () => {
    for (const locale of ['zh-TW', 'en-US'] as const) {
      i18n.global.locale.value = locale
      const { w } = await mountModal()
      expect(w.text()).not.toMatch(/resource\.[a-z-]+/)
      w.unmount()
    }
    i18n.global.locale.value = 'en-US'
  })

  // Final review part 2 MED-1: the helper's error can carry text from a plugin.
  it('spells out invisible characters in the helper error; ordinary text is unchanged', async () => {
    for (const [lastError, shown] of [['bad​ result‮', 'bad\\u{200b} result\\u{202e}'], ['plain error', 'plain error']]) {
      ;(window as unknown as { agentTeam: Record<string, unknown> }).agentTeam.plugins = {
        backendResourceUsage: vi.fn(async () => ({ backend: { resultHelper: { state: 'unavailable', lastError, since: 1 } } })),
      }
      const { w } = await mountModal()
      const detail = w.get('[data-part="detail"]').text()
      expect(detail).toContain(shown)
      expect(detail).not.toMatch(/[​‮]/)
      w.unmount()
    }
  })
})
