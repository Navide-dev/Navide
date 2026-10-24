// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'

// Every workspace heading offers ↻ (rebuild this project's CLIs) and the
// history button. Both emitted no payload and App answered them from
// currentWorkspace, so whichever heading you clicked, they acted on the
// workspace on screen — and ↻'s enabled state came from there too. These pin
// each heading to its own workspace.
//
// The two moved into the heading's ⋯ overflow when the fold button took a
// place on the row; the binding they are pinned to is the menu's own
// wsMoreMenuPath now, so the same substitution would still be invisible
// without these.

const A = '/Users/me/Desktop/alpha'
const B = '/Users/me/Desktop/beta'

const wsRow = (path: string, label: string) => ({
  path,
  label,
  displayPath: '~/Desktop',
  isCurrent: true,
  collapsed: false,
  count: 1, paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
})

const panes = [
  { id: 'a1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: A },
  { id: 'b1', agentLabel: 'Claude', status: 'running', command: 'claude', origin: 'manual', isMinimized: false, isCommander: false, workspacePath: B },
]

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: [{ agentKey: 'claude', label: 'Claude Code' }],
      roles: [],
      stages: [],
      panes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false,
      workspace: A,
      existingProject: null,
      workspaces: [wsRow(A, 'alpha'), wsRow(B, 'beta')],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** Open the nth heading's ⋯ menu and return its [rebuild, history] items.
 *
 *  One menu exists at a time and its contents follow the heading that opened
 *  it, so every assertion below still reads "this heading's buttons". */
const actsOf = async (wrapper: VueWrapper, n: number) => {
  await wrapper.findAll('.ws-head')[n].find('.ws-more').trigger('click')
  const opts = wrapper.findAll('.ws-more-opt')
  // By label, not by index: the menu has since taken in the actions that used
  // to need a right-click, and a position would be renumbered by the next one.
  const byLabel = (key: string) => {
    const hit = opts.find((o) => o.text() === key)
    if (!hit) throw new Error(`no ⋯ item "${key}"; menu reads: ${opts.map((o) => o.text()).join(' | ')}`)
    return hit
  }
  // Getters, not values: `detach` is absent from a window holding one
  // workspace, and looking every row up eagerly would throw there before the
  // test that asserts its absence could run.
  return {
    all: opts,
    get rebuild() { return byLabel('action.rebuild-all-cli-panes-label') },
    get history() { return byLabel('label.history') },
    get reveal() { return byLabel('action.open-in-finder') },
    get copyPath() { return byLabel('action.copy-path') },
    get rename() { return byLabel('action.rename-workspace') },
    get detach() { return byLabel('action.detach-workspace') },
    get close() { return byLabel('action.close-workspace') },
    get closeWithPanes() { return byLabel('action.close-workspace-and-panes') },
  }
}

describe('ControlPane – the buttons on a workspace heading', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('rebuilds the workspace whose heading was clicked, not the one on screen', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 } })
    await (await actsOf(wrapper, 1)).rebuild.trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[B]])
  })

  it('opens the history of the workspace whose heading was clicked', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 } })
    await (await actsOf(wrapper, 1)).history.trigger('click')
    expect(wrapper.emitted('open-history')).toEqual([[B]])
  })

  it('names the viewed workspace too, rather than leaving it to a fallback', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1 } })
    await (await actsOf(wrapper, 0)).rebuild.trigger('click')
    await (await actsOf(wrapper, 0)).history.trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[A]])
    expect(wrapper.emitted('open-history')).toEqual([[A]])
  })

  it('enables ↻ per workspace, so an empty project does not offer it', async () => {
    // One window-wide flag meant a project with nothing to rebuild showed the
    // button live, and one with panes to rebuild showed it dead.
    wrapper = mountWith({ rebuildableByWorkspace: { [B]: 2 } })
    expect((await actsOf(wrapper, 0)).rebuild.attributes('disabled')).toBeDefined()
    expect((await actsOf(wrapper, 1)).rebuild.attributes('disabled')).toBeUndefined()
  })

  it('treats a heading path with a trailing slash as the same workspace', async () => {
    wrapper = mountWith({
      workspaces: [wsRow(`${A}/`, 'alpha')],
      rebuildableByWorkspace: { [A]: 1 },
    })
    expect((await actsOf(wrapper, 0)).rebuild.attributes('disabled')).toBeUndefined()
  })

  it('disables ↻ everywhere while a rebuild batch is running', async () => {
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 }, rebuildingAll: true })
    expect((await actsOf(wrapper, 0)).rebuild.attributes('disabled')).toBeDefined()
    expect((await actsOf(wrapper, 1)).rebuild.attributes('disabled')).toBeDefined()
  })

  it('opens one heading\'s overflow at a time, so ⋯ never acts on the last row', async () => {
    // The menu is a single element whose contents follow wsMoreMenuPath. If
    // opening a second heading left the first bound, ↻ would rebuild whichever
    // project was opened first — the exact substitution this file exists for.
    wrapper = mountWith({ rebuildableByWorkspace: { [A]: 1, [B]: 1 } })
    await actsOf(wrapper, 0)
    await (await actsOf(wrapper, 1)).rebuild.trigger('click')
    expect(wrapper.emitted('rebuild-all')).toEqual([[B]])
  })
  // The rows folded in from the right-click menu. Same substitution risk as
  // ↻ and history: the menu is one element whose contents follow
  // wsMoreMenuPath, so an action reading anything else would act on the wrong
  // project while looking correct.
  it('reveals the folder of the heading that was clicked', async () => {
    wrapper = mountWith()
    await (await actsOf(wrapper, 1)).reveal.trigger('click')
    expect(wrapper.emitted('reveal-workspace-folder')).toEqual([[B]])
  })

  it('copies the path of the heading that was clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom leaves navigator.clipboard undefined; the action optional-chains
    // through it, so without this the assertion would pass on a no-op.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    wrapper = mountWith()
    await (await actsOf(wrapper, 1)).copyPath.trigger('click')
    expect(writeText).toHaveBeenCalledWith(B)
  })

  it('renames in place rather than switching to that workspace first', async () => {
    // Double-clicking the name would switch to the project before opening the
    // editor, which restores a whole project's panes — far more than rename
    // asked for. The menu route opens the box where the row already is.
    wrapper = mountWith()
    await (await actsOf(wrapper, 1)).rename.trigger('click')
    // On THAT row — an editor opened over the workspace on screen instead
    // would look just as correct from a document-wide `find`.
    const heads = wrapper.findAll('.ws-head')
    expect(heads[1].find('.ws-rename-input').exists()).toBe(true)
    expect(heads[0].find('.ws-rename-input').exists()).toBe(false)
    expect(wrapper.emitted('switch-workspace')).toBeUndefined()
  })

  it('detaches the heading that was clicked, at the pointer', async () => {
    wrapper = mountWith()
    const menu = await actsOf(wrapper, 1)
    await menu.detach.trigger('click', { screenX: 640, screenY: 480 })
    expect(wrapper.emitted('detach-workspace')).toEqual([[B, 640, 480]])
  })

  it('closes the heading that was clicked, keeping or ending its panes', async () => {
    wrapper = mountWith()
    await (await actsOf(wrapper, 1)).close.trigger('click')
    expect(wrapper.emitted('close-workspace-keep-panes')).toEqual([[B]])
    expect(wrapper.emitted('close-workspace')).toBeUndefined()

    await (await actsOf(wrapper, 0)).closeWithPanes.trigger('click')
    expect(wrapper.emitted('close-workspace')).toEqual([[A]])
  })

  it('hides detach when the window would be left with nothing', async () => {
    // Pulling out the only workspace empties this window to fill a new one.
    wrapper = mountWith({ workspaces: [wsRow(A, 'alpha')] })
    await wrapper.findAll('.ws-head')[0].find('.ws-more').trigger('click')
    const labels = wrapper.findAll('.ws-more-opt').map((o) => o.text())
    expect(labels).not.toContain('action.detach-workspace')
    // The rest of the menu still stands — this is one row hidden, not a
    // collapsed menu.
    expect(labels).toContain('action.open-in-finder')
  })

})

// "Reclaim This Project's CLIs" — the batch the pane menu's Reclaim does one at
// a time. It is on both of a heading's menus, and both must answer for the
// heading they hang off: a window can hold several projects, and reclaiming
// the wrong one's CLIs is the same class of bug the two tests above pin down
// for ↻ and history.
describe('ControlPane – reclaim a whole workspace', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  /** Right-click the nth heading and read its menu rows by label. */
  const ctxOf = async (w: VueWrapper, n: number) => {
    await w.findAll('.ws-head')[n].trigger('contextmenu')
    const opts = w.findAll('.ws-ctx-opt')
    const byLabel = (key: string) => {
      const hit = opts.find((o) => o.text() === key)
      if (!hit) throw new Error(`no row "${key}"; menu reads: ${opts.map((o) => o.text()).join(' | ')}`)
      return hit
    }
    return {
      all: opts,
      get reclaim() { return byLabel('action.reclaim-workspace-count') },
      get reclaimEmpty() { return byLabel('action.reclaim-workspace') },
    }
  }
  const moreReclaim = async (w: VueWrapper, n: number) => {
    const acts = await actsOf(w, n)
    const hit = acts.all.find((o) => o.text().startsWith('action.reclaim-workspace'))
    if (!hit) throw new Error(`no ⋯ reclaim row; menu reads: ${acts.all.map((o) => o.text()).join(' | ')}`)
    return hit
  }

  it('reclaims the workspace whose heading was clicked, from the ⋯ menu', async () => {
    wrapper = mountWith({ reclaimableByWorkspace: { [A]: 1, [B]: 2 } })
    await (await moreReclaim(wrapper, 1)).trigger('click')
    expect(wrapper.emitted('reclaim-workspace-panes')).toEqual([[B]])
  })

  it('reclaims the workspace whose heading was right-clicked', async () => {
    wrapper = mountWith({ reclaimableByWorkspace: { [A]: 1, [B]: 2 } })
    await (await ctxOf(wrapper, 1)).reclaim.trigger('click')
    expect(wrapper.emitted('reclaim-workspace-panes')).toEqual([[B]])
  })

  // Both sides in one mount: B has panes to reclaim and A has none, so a row
  // that ignored its own workspace would fail whichever way it was wired.
  it('enables the row per workspace, in both menus', async () => {
    wrapper = mountWith({ reclaimableByWorkspace: { [B]: 2 } })
    expect((await moreReclaim(wrapper, 0)).attributes('disabled')).toBeDefined()
    expect((await moreReclaim(wrapper, 1)).attributes('disabled')).toBeUndefined()
    expect((await ctxOf(wrapper, 0)).reclaimEmpty.attributes('disabled')).toBeDefined()
    expect((await ctxOf(wrapper, 1)).reclaim.attributes('disabled')).toBeUndefined()
  })

  // The count is the only thing that tells you what the row is about to take.
  it('labels the row with that workspace\'s own count', async () => {
    wrapper = mountWith({ reclaimableByWorkspace: { [B]: 2 } })
    expect((await ctxOf(wrapper, 1)).all.map((o) => o.text()))
      .toContain('action.reclaim-workspace-count')
    expect((await ctxOf(wrapper, 0)).all.map((o) => o.text()))
      .toContain('action.reclaim-workspace')
  })

  // A workspace absent from the map is "nothing to reclaim", not a crash — App
  // only publishes keys for workspaces that have some.
  it('treats a missing entry as zero', async () => {
    wrapper = mountWith({})
    expect((await moreReclaim(wrapper, 0)).attributes('disabled')).toBeDefined()
    expect((await ctxOf(wrapper, 0)).reclaimEmpty.attributes('disabled')).toBeDefined()
  })
})
