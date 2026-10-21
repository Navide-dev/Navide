// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// A parent row's status dot is painted with the loudest status among the pane
// itself and the panes it spawned. The sidebar row has no width for another
// chip, so the family rides on the dot that is already there — and a folded
// subtree can no longer hide a child that is still running or parked on a
// permission prompt. The expanded row's text pill keeps saying what THIS pane
// is doing.

function makeProps(panes: Record<string, unknown>[], collapsed: string[] = []): Record<string, unknown> {
  return {
    backendStatus: 'connected',
    backendUrl: '',
    agentSpecs: [],
    roles: [],
    stages: [],
    panes,
    lineage: lineageOf(panes, new Set(collapsed)),
    pipeline: { state: 'idle' },
    yoloEnabled: false,
    analyzerModel: '',
    analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
    autoAnswerEnabled: false,
    existingProject: null
  }
}

/** The rows the sidebar would be handed: parents before children, a collapsed
 *  parent's children left out — the shape that used to hide the signal. */
function lineageOf(panes: Record<string, unknown>[], collapsed: Set<string>) {
  const rows: Record<string, unknown>[] = []
  const walk = (parent: string, depth: number): void => {
    for (const p of panes) {
      if ((p.spawnedBy ?? '') !== parent) continue
      const id = p.id as string
      const hasChildren = panes.some((c) => c.spawnedBy === id)
      rows.push({ id, depth, hasChildren, collapsed: collapsed.has(id), ancestors: [], descendantCount: 0 })
      if (!collapsed.has(id)) walk(id, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

const basePane = { agentLabel: 'Claude', status: 'idle', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false }

describe('ControlPane – subtree status on the parent row dot', () => {
  let wrapper: VueWrapper

  function mount(panes: Record<string, unknown>[], collapsed: string[] = []): void {
    sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: makeProps(panes, collapsed),
      global: { mocks: { $t: (key: string) => key } }
    })
  }

  afterEach(() => {
    wrapper.unmount()
    sessionStorage.clear()
  })

  const dotOf = (i: number) => wrapper.findAll('.agent-item')[i].find('.status-dot')

  it('paints an idle parent with its running children, and says so on hover', () => {
    mount([
      { ...basePane, id: 'parent', status: 'idle' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'idle' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c3', spawnedBy: 'parent', status: 'running' }
    ])
    expect(dotOf(0).attributes('data-state')).toBe('running')
    // Own status first, then the family — real i18n on the script side.
    expect(dotOf(0).attributes('title')).toBe('idle · 2 spawned panes running under this one')
    // No extra chip on the row: the dot is the whole signal.
    expect(wrapper.find('.subtree-tag').exists()).toBe(false)
  })

  it('lets a blocked child outrank a running parent', () => {
    mount([
      { ...basePane, id: 'parent', status: 'running' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'awaiting' }
    ])
    expect(dotOf(0).attributes('data-state')).toBe('awaiting')
  })

  it('keeps the parent own status when it is already the loudest', () => {
    mount([
      { ...basePane, id: 'parent', status: 'awaiting' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'running' }
    ])
    expect(dotOf(0).attributes('data-state')).toBe('awaiting')
    expect(dotOf(0).attributes('title')).toBe('awaiting · 1 spawned pane running under this one')
  })

  it('leaves the dot alone when every descendant is idle, or when a pane has none', () => {
    mount([
      { ...basePane, id: 'parent', status: 'idle' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'idle' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'exited' },
      { ...basePane, id: 'lone', status: 'running' }
    ])
    expect(dotOf(0).attributes('data-state')).toBe('idle')
    expect(dotOf(0).attributes('title')).toBe('idle')
    expect(dotOf(3).attributes('data-state')).toBe('running')
    expect(dotOf(3).attributes('title')).toBe('running')
  })

  it('counts grandchildren, and keeps painting a collapsed parent', () => {
    mount(
      [
        { ...basePane, id: 'parent', status: 'idle' },
        { ...basePane, id: 'child', spawnedBy: 'parent', status: 'idle' },
        { ...basePane, id: 'grandchild', spawnedBy: 'child', status: 'running' }
      ],
      ['parent']
    )
    // Only the collapsed parent is drawn — the running grandchild is off screen.
    expect(wrapper.findAll('.agent-item')).toHaveLength(1)
    expect(dotOf(0).attributes('data-state')).toBe('running')
  })

  it('does not repaint the children themselves', () => {
    mount([
      { ...basePane, id: 'parent', status: 'idle' },
      { ...basePane, id: 'c1', spawnedBy: 'parent', status: 'running' },
      { ...basePane, id: 'c2', spawnedBy: 'parent', status: 'idle' }
    ])
    expect(dotOf(1).attributes('data-state')).toBe('running')
    expect(dotOf(2).attributes('data-state')).toBe('idle')
  })
})
