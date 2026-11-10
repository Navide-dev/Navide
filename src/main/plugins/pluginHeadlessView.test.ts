import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrontendPluginManager, HEADLESS_VIEW_IDLE_MS } from './frontendPluginManager'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

// Headless views (0.2.40): only a view whose manifest declares
// `headless: true` is ever mounted hidden, through the same open a user's
// would be (openContribution, bounds hidden), on a window of the workspace;
// it is unmounted after HEADLESS_VIEW_IDLE_MS without a call, and never once
// the user has it on screen. The view lifecycle itself is stubbed: what is
// under test is the Host's decision, not Electron.

vi.mock('electron', () => ({}))

afterEach(() => {
  vi.useRealTimers()
})

const SPEC = {
  pluginId: 'acme.viewer',
  packageVersion: '1.0.0',
  packageDir: '/pkg',
  thirdParty: { name: 'Viewer', system: [] },
}

interface Internals {
  mountHeadlessView: (spec: unknown, viewId: string, root: string) => Promise<unknown>
  touchHeadlessView: (instanceId: string, busy?: boolean) => void
  contributionInstances: Map<string, { instanceId: string }>
  running: Map<string, unknown>
  headlessViewInstances: Map<string, unknown>
}

function setup(headless: boolean | undefined, options: { host?: boolean } = {}) {
  const mgr = new FrontendPluginManager()
  mgr.registerDescriptor({
    id: 'acme.viewer', packageVersion: '1.0.0', packageDir: '/pkg', requires: [],
    capabilityPolicy: manifestV2CapabilityPolicy({}), devUrl: '', entryFile: '/pkg/index.html',
    views: [{
      id: 'main', contributionKey: 'acme.viewer.main', kind: 'custom', location: 'left', title: 'Viewer',
      entryFile: '/pkg/main.html', ...(headless ? { headless: true as const } : {}),
    }],
  }, { builtin: true })
  const internals = mgr as unknown as Internals
  const hostWindow = { id: 7, isDestroyed: () => false } as never
  const record = { instanceId: 'i-1', visible: false }
  const opened: Array<Record<string, unknown>> = []
  vi.spyOn(mgr, 'openContribution').mockImplementation(async (_win, key, openOptions) => {
    opened.push({ key, ...openOptions })
    internals.contributionInstances.set(`7:${key}`, { instanceId: 'i-1' })
    internals.running.set('i-1', record)
    return { ok: true }
  })
  const destroyed: string[] = []
  vi.spyOn(mgr, 'destroyInstance').mockImplementation((id: string) => {
    destroyed.push(id)
    internals.running.delete(id)
    internals.headlessViewInstances.delete(id)
  })
  ;(mgr as unknown as { waitForPluginReady: () => Promise<void> }).waitForPluginReady = async () => undefined
  ;(mgr as unknown as { viewServingAgentTool: () => unknown }).viewServingAgentTool = () =>
    internals.running.get('i-1')
  if (options.host !== false) {
    mgr.setHeadlessViewHost((root) => root === '/ws' ? { hostWindow, query: (key) => `?view=${key}` } : null)
  }
  return { mgr, internals, opened, destroyed, record }
}

describe('headless views', () => {
  it('never mounts a view that does not declare headless: true (existing plugins are unchanged)', async () => {
    for (const headless of [undefined, false]) {
      const f = setup(headless)
      expect(await f.internals.mountHeadlessView(SPEC, 'main', '/ws')).toBeUndefined()
      expect(f.opened).toEqual([])
    }
  })

  it('mounts an opted-in view hidden, through openContribution, with the query a user open gets', async () => {
    const f = setup(true)
    expect(await f.internals.mountHeadlessView(SPEC, 'main', '/ws')).toBe(f.record)
    expect(f.opened).toEqual([{
      key: 'acme.viewer.main', bounds: 'hidden', initiallyVisible: false, workspacePath: '/ws', query: '?view=acme.viewer.main',
    }])
    expect(f.mgr.headlessViewCount('acme.viewer')).toBe(1)
  })

  it('mounts nothing without a window of the workspace or without a host', async () => {
    const f = setup(true)
    expect(await f.internals.mountHeadlessView(SPEC, 'main', '/elsewhere')).toBeUndefined()
    const g = setup(true, { host: false })
    expect(await g.internals.mountHeadlessView(SPEC, 'main', '/ws')).toBeUndefined()
    expect([...f.opened, ...g.opened]).toEqual([])
  })

  it('mounts nothing for another package version', async () => {
    const f = setup(true)
    expect(await f.internals.mountHeadlessView({ ...SPEC, packageVersion: '2.0.0' }, 'main', '/ws')).toBeUndefined()
    expect(f.opened).toEqual([])
  })

  it('reuses the slot\'s instance rather than opening (and hiding) another', async () => {
    const f = setup(true)
    f.internals.contributionInstances.set('7:acme.viewer.main', { instanceId: 'i-1' })
    f.internals.running.set('i-1', f.record)
    expect(await f.internals.mountHeadlessView(SPEC, 'main', '/ws')).toBe(f.record)
    expect(f.opened).toEqual([])
    expect(f.mgr.headlessViewCount('acme.viewer')).toBe(0)
  })

  it('unmounts after the idle time, counted from the last call, and not while a call runs', async () => {
    vi.useFakeTimers()
    const f = setup(true)
    await f.internals.mountHeadlessView(SPEC, 'main', '/ws')
    vi.advanceTimersByTime(HEADLESS_VIEW_IDLE_MS - 1)
    f.internals.touchHeadlessView('i-1', true)
    vi.advanceTimersByTime(HEADLESS_VIEW_IDLE_MS * 2)
    expect(f.destroyed).toEqual([])
    f.internals.touchHeadlessView('i-1')
    vi.advanceTimersByTime(HEADLESS_VIEW_IDLE_MS)
    expect(f.destroyed).toEqual(['i-1'])
    expect(f.internals.contributionInstances.has('7:acme.viewer.main')).toBe(false)
    expect(f.mgr.headlessViewCount('acme.viewer')).toBe(0)
  })

  it('leaves a view the user has on screen alone when its idle time ends', async () => {
    vi.useFakeTimers()
    const f = setup(true)
    await f.internals.mountHeadlessView(SPEC, 'main', '/ws')
    f.record.visible = true
    vi.advanceTimersByTime(HEADLESS_VIEW_IDLE_MS)
    expect(f.destroyed).toEqual([])
    expect(f.internals.contributionInstances.has('7:acme.viewer.main')).toBe(true)
  })
})
