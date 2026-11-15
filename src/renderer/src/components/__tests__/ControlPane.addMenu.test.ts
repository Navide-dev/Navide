// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

// The ＋ on the workspace heading opens a menu of CLIs. Its ✓ is the default
// for a one-click spawn, and the Manual spawn dialog opens on that default —
// but the dialog's own dropdown is a separate store, so reaching for another
// CLI in there does not silently move what ＋ will open next time.

const specs = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'codex', label: 'Codex' },
  { agentKey: 'terminal', label: 'Terminal' } // last, as App.vue orders it
]

// The list only renders once there is at least one pane — with none, the
// section shows its empty state and the heading never appears.
const localPanes = [
  {
    id: 'p1', agentLabel: 'Claude', status: 'running', command: 'claude',
    origin: 'manual', isMinimized: false, isCommander: false
  }
]

const workspaceRow = {
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop/Agent-Team',
  isCurrent: true,
  collapsed: false,
  count: 1, paneIds: [],
  lineage: [],
  // The sidebar renders through the group sections; a row without them shows
  // no panes. One ungrouped section is what an untouched workspace looks like.
  groups: [{ id: '', name: '', rows: [] }],
  remote: []
}

/** A backend whose onboarding.status reports the given CLIs as missing. */
function backendWithMissing(missing: string[]): Record<string, unknown> {
  return {
    send: vi.fn().mockResolvedValue({
      payload: {
        deps: missing.map((id) => ({ id, group: 'agent_cli', status: 'missing' }))
      }
    })
  }
}

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: backendWithMissing([]),
      agentSpecs: specs,
      roles: [{ key: 'reviewer', label: 'Reviewer' }],
      stages: [],
      panes: localPanes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false,
        version: '',
        defaultModel: '',
        models: [],
        benchmarkResults: []
      },
      autoAnswerEnabled: false,
      // canSpawn needs a workspace; the ＋ is disabled without one.
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [workspaceRow],
      ...extra
    } as never,
    global: { mocks: { $t: (key: string) => key } }
  })
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ws-add').trigger('click')
}

describe('ControlPane – the ＋ menu', () => {
  let wrapper: VueWrapper
  afterEach(() => wrapper?.unmount())

  it('lists every manual-spawn CLI, with the current one ticked', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    const opts = wrapper.findAll('.ws-add-scroll .ws-add-opt')
    expect(opts.map((o) => o.text())).toEqual(['✓Claude Code', 'Codex'])
    expect(opts[0].classes()).toContain('on')
  })

  it('splits the roster into a CLI block and an Agents block, each under its heading', async () => {
    // Order inside each block is the order of agentSpecs, i.e. Settings → CLI
    // Agents; Devin stays a CLI.
    wrapper = mountWith({
      agentSpecs: [
        { agentKey: 'hermes', label: 'Hermes Agent', kind: 'agent' },
        { agentKey: 'claude', label: 'Claude Code' },
        { agentKey: 'devin', label: 'Devin CLI' },
        { agentKey: 'openclaw', label: 'OpenClaw', kind: 'agent' },
        { agentKey: 'terminal', label: 'Terminal' }
      ]
    })
    await openMenu(wrapper)
    const rows = wrapper.findAll('.ws-add-scroll > *').map((el) =>
      el.classes().includes('ws-add-sec') ? `# ${el.text()}` : `${el.attributes('data-section')}: ${el.text()}`
    )
    expect(rows).toEqual([
      '# label.add-menu-cli',
      'cli: Claude Code',
      'cli: Devin CLI',
      '# label.add-menu-agents',
      // Agents are named before they open: each vendor offers "new agent"
      // (plan agent-0-2-40_78e071, figure 3); there are no identities yet.
      'agents: agentPane.addMenu.new',
      'agents: agentPane.addMenu.new'
    ])
  })

  const agentSpecs = [
    { agentKey: 'claude', label: 'Claude Code' },
    { agentKey: 'hermes', label: 'Hermes Agent', kind: 'agent' },
    { agentKey: 'terminal', label: 'Terminal' }
  ]
  const identity = (over: Record<string, unknown>) => ({
    identity: {
      id: 'id-1', name: 'Secretary', color: 'teal', agentKey: 'hermes',
      workspacePath: '/Users/me/Desktop/Agent-Team', paneId: null, sessionId: null, createdAt: 1, ...over
    },
    open: false,
    status: ''
  })

  it('lists agent identities of the menu workspace and opens the one clicked', async () => {
    wrapper = mountWith({
      agentSpecs,
      agentIdentities: [identity({}), identity({ id: 'id-2', name: 'Elsewhere', workspacePath: '/other' })]
    })
    await openMenu(wrapper)
    const rows = wrapper.findAll('[data-testid="add-menu-agent-identity"]')
    expect(rows.map((r) => r.text())).toEqual(['SSecretaryagentPane.addMenu.closed'])
    await rows[0].trigger('click')
    expect(wrapper.emitted('agent-open')?.[0]).toEqual(['id-1'])
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('asks a new agent for its name and spawns it under that name', async () => {
    wrapper = mountWith({ agentSpecs })
    await openMenu(wrapper)
    const newRow = wrapper.findAll('.ws-add-opt[data-section="agents"]').at(-1)!
    await newRow.trigger('click')
    expect(wrapper.emitted('spawn')).toBeUndefined()
    const form = wrapper.find('[data-testid="add-menu-new-agent-form"]')
    expect(form.exists()).toBe(true)
    await form.find('input').setValue('  Secretary ')
    await form.trigger('submit')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'hermes', customName: 'Secretary' })
  })

  it('does not spawn a new agent without a name', async () => {
    wrapper = mountWith({ agentSpecs })
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-opt[data-section="agents"]').at(-1)!.trigger('click')
    await wrapper.find('[data-testid="add-menu-new-agent-form"]').trigger('submit')
    expect(wrapper.emitted('spawn')).toBeUndefined()
  })

  it('files exactly OpenClaw and Hermes Agent under Agents in the real roster', () => {
    const agents = CLI_AGENT_SPECS.filter((s) => s.kind === 'agent').map((s) => s.agentKey)
    expect(agents.sort()).toEqual(['hermes', 'openclaw'])
    expect(CLI_AGENT_SPECS.find((s) => s.agentKey === 'devin')?.kind ?? 'cli').toBe('cli')
  })

  it('drops the Agents block, heading included, when none of its agents is enabled', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.findAll('.ws-add-sec').map((h) => h.text())).toEqual(['label.add-menu-cli'])
  })

  it('caps the menu at the room on its side of the button', async () => {
    // The scroller shrinks into the menu's max-height instead of a fixed 45vh,
    // which cut the last entry off in a 900px window that had room for it.
    wrapper = mountWith()
    const add = wrapper.find('.ws-add')
    add.element.getBoundingClientRect = () =>
      ({ top: 100, bottom: 120, left: 0, right: 20, width: 20, height: 20, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    await add.trigger('click')
    const style = (wrapper.find('.ws-add-menu').element as HTMLElement).style
    expect(style.maxHeight).toBe(`${window.innerHeight - 120 - 24}px`)
  })

  it('keeps the widened menu inside the window when the button sits near the left edge', async () => {
    // The menu hangs leftwards from the button and is wider than the narrowest
    // sidebar; right-aligned there, its left edge would leave the window.
    wrapper = mountWith()
    const add = wrapper.find('.ws-add')
    add.element.getBoundingClientRect = () =>
      ({ top: 100, bottom: 120, left: 170, right: 190, width: 20, height: 20, x: 170, y: 100, toJSON: () => ({}) }) as DOMRect
    await add.trigger('click')
    const style = (wrapper.find('.ws-add-menu').element as HTMLElement).style
    expect(style.right).toBe(`${window.innerWidth - 320 - 8}px`)
  })

  it('stays right-aligned with the button when there is room on its left', async () => {
    wrapper = mountWith()
    const add = wrapper.find('.ws-add')
    const right = 600
    add.element.getBoundingClientRect = () =>
      ({ top: 100, bottom: 120, left: right - 20, right, width: 20, height: 20, x: right - 20, y: 100, toJSON: () => ({}) }) as DOMRect
    await add.trigger('click')
    const style = (wrapper.find('.ws-add-menu').element as HTMLElement).style
    expect(style.right).toBe(`${window.innerWidth - right}px`)
  })

  it('opens with an icon rather than a text glyph', async () => {
    // It used to be the full-width character ＋. A glyph takes its weight from
    // the typeface, so it could not match the stroke icons beside it at any
    // font-size — the mismatch was structural, not a matter of picking a
    // better character. Asserting the button carries no text keeps a future
    // "just use a character" from quietly regressing that.
    wrapper = mountWith()
    const add = wrapper.find('.ws-add')
    expect(add.text()).toBe('')
    expect(add.html()).toContain('add-pane-icon')
  })

  it('keeps the plain shell out of the scrolling list', async () => {
    // The list is a capped scroller (see the fit tests at the bottom of this
    // file). A shell added to it would be the last entry with every CLI
    // enabled, i.e. the first one below the fold — where it reads as missing
    // rather than as needing a scroll. Rendered is not the same as visible,
    // and a test that only asked "is it in the DOM" passed while the thing was
    // unreachable. Deliberately not restating the cap in px here: this comment
    // said "200px" long after the cap had moved.
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-scroll .ws-add-term').exists()).toBe(false)
    expect(wrapper.find('.ws-add-term').exists()).toBe(true)
  })

  it('points cloud agents at the Navide Marketplace, below the CLI list', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-scroll .ws-add-hint').exists()).toBe(false)
    expect(wrapper.find('.ws-add-hint').text()).toBe('label.cloud-agents-plugin-hint')
  })

  it('says a heading can be dragged out, only when it can be', async () => {
    // Nothing about the row shows it is draggable, and with one workspace it
    // silently is not — which reads as broken rather than deliberate.
    wrapper = mountWith()
    const lone = wrapper.find('.ws-head--current')
    expect(lone.attributes('draggable')).toBe('false')
    expect(lone.attributes('title')).toBe('')

    wrapper.unmount()
    const second = { ...workspaceRow, path: '/Users/me/Desktop/other', label: 'other', groups: [{ id: '', name: '', rows: [] }] }
    wrapper = mountWith({ workspaces: [workspaceRow, second] })
    const rows = wrapper.findAll('.ws-head--current')
    expect(rows[0].attributes('draggable')).toBe('true')
    // Row 0 is the workspace on screen, so it has no switch hint to offer —
    // a title there can only be the drag one. Asserted as "not empty" rather
    // than by its text, which is translated.
    expect(rows[0].attributes('title')).not.toBe('')
  })

  it('starts a plain shell without the picked role', async () => {
    // The role is injected into a CLI's prompt. A shell would print it, so this
    // cannot go through spawnAs, which sends whatever the role select holds.
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-role').setValue('reviewer')
    await wrapper.find('.ws-add-term').trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      agentKey: 'terminal',
      roleKey: '',
    })
  })

  it('leaves the picked agent alone when a shell is started', async () => {
    // Unlike a CLI pick, which writes back to the card. A shell is not an agent
    // the card can be set to, and overwriting the pick would lose it.
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-term').trigger('click')
    await openMenu(wrapper)
    const opts = wrapper.findAll('.ws-add-scroll .ws-add-opt')
    expect(opts[0].classes()).toContain('on')
  })

  it('starts the shell in the workspace whose heading was clicked', async () => {
    // The ＋ belongs to one row, and a window can hold several workspaces.
    const second = { ...workspaceRow, path: '/Users/me/Desktop/other', label: 'other', groups: [{ id: '', name: '', rows: [] }] }
    wrapper = mountWith({ workspaces: [workspaceRow, second] })
    await wrapper.findAll('.ws-add')[1].trigger('click')
    await wrapper.find('.ws-add-term').trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      agentKey: 'terminal',
      workspacePath: '/Users/me/Desktop/other',
    })
  })

  it('closes the menu after starting a shell', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-term').trigger('click')
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('opens the CLI that was clicked, not the one the card had', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
  })

  it('leaves the menu default alone when a menu pick opens another CLI', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
    // The ✓ still marks claude, and the dialog still opens on claude.
    await openMenu(wrapper)
    const checks = wrapper.findAll('.ws-add-scroll .ws-add-opt .ws-add-ck')
    expect(checks[0].text()).toBe('✓')
    expect(checks[1].text()).toBe('')
    await wrapper.find('.ws-add-card').trigger('click')
    expect((wrapper.find('.spawn-card-body select').element as HTMLSelectElement).value).toBe('claude')
  })

  it('leaves the menu default alone when the dialog picks another CLI', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    await wrapper.find('.spawn-card-body select').setValue('codex')
    // The ✓ still marks claude, and ＋ still opens claude.
    await openMenu(wrapper)
    const checks = wrapper.findAll('.ws-add-scroll .ws-add-opt .ws-add-ck')
    expect(checks[0].text()).toBe('✓')
    expect(checks[1].text()).toBe('')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'claude' })
  })

  it('spawns the dialog\'s own pick from its Open Agent button', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    await wrapper.find('.spawn-card-body select').setValue('codex')
    await wrapper.find('.spawn-actions .primary').trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
  })

  it('reopens the dialog on the menu default, not on its last pick', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    await wrapper.find('.spawn-card-body select').setValue('codex')
    await wrapper.find('.spawn-modal-close').trigger('click')
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    expect((wrapper.find('.spawn-card-body select').element as HTMLSelectElement).value).toBe('claude')
  })

  it('carries the role the menu has selected', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-role').setValue('reviewer')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({ roleKey: 'reviewer' })
  })

  it('offers the guided install for a CLI that is not there', async () => {
    // Spawning it would only produce a pane that dies with 127.
    wrapper = mountWith({ backend: backendWithMissing(['codex']) })
    await new Promise((r) => setTimeout(r, 0)) // let the status fetch settle
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[1].trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.emitted('install-cli')?.[0]?.[0]).toMatchObject({ agentKey: 'codex' })
  })

  it('spawns into the workspace whose heading opened it', async () => {
    // Two local workspaces: the ＋ on the second must not start a pane in the
    // first, which is what a single window-wide workspacePath would do.
    wrapper = mountWith({
      workspaces: [
        { ...workspaceRow, lineage: [] },
        {
          path: '/Users/me/Desktop/Other', label: 'Other', displayPath: '~/Desktop',
          isCurrent: true, collapsed: false, count: 0, paneIds: [], lineage: [],
          groups: [{ id: '', name: '', rows: [] }], remote: []
        }
      ]
    })
    const adds = wrapper.findAll('.ws-add')
    expect(adds).toHaveLength(2)
    await adds[1].trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      workspacePath: '/Users/me/Desktop/Other'
    })
  })

  it("the card's own button still means this window's workspace", async () => {
    // The override is per-request; it must not leak into the next spawn.
    wrapper = mountWith({
      workspaces: [
        { ...workspaceRow, lineage: [] },
        {
          path: '/Users/me/Desktop/Other', label: 'Other', displayPath: '~/Desktop',
          isCurrent: true, collapsed: false, count: 0, paneIds: [], lineage: [],
          groups: [{ id: '', name: '', rows: [] }], remote: []
        }
      ]
    })
    const adds = wrapper.findAll('.ws-add')
    await adds[1].trigger('click')
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    // Now spawn from the dialog instead.
    await adds[0].trigger('click')
    await wrapper.find('.ws-add-card').trigger('click')
    await wrapper.find('.spawn-card-body .primary').trigger('click')
    expect(wrapper.emitted('spawn')?.[1]?.[0]).toMatchObject({
      workspacePath: '/Users/me/Desktop/Agent-Team'
    })
  })

  it('closes on Escape', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes when you click away, but not when you click inside it', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-menu').trigger('click')
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes when the list scrolls out from under it', async () => {
    // The menu is positioned at a point measured from the button; scrolling
    // the pane list would leave it hanging over whatever took that place.
    wrapper = mountWith()
    await openMenu(wrapper)
    document.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('stays open while its own list scrolls', async () => {
    // A short window caps the list, so reaching the Agents block takes a
    // scroll inside the menu; that must not count as the page moving.
    wrapper = mountWith()
    await openMenu(wrapper)
    wrapper.find('.ws-add-scroll').element.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(true)
    document.body.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('closes after a spawn', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.findAll('.ws-add-scroll .ws-add-opt')[0].trigger('click')
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('the last row opens the full card instead of spawning', async () => {
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    expect(wrapper.emitted('spawn')).toBeUndefined()
    expect(wrapper.find('.spawn-card-body').exists()).toBe(true)
  })

  it('does not open while there is nothing to spawn into', async () => {
    wrapper = mountWith({ backendStatus: 'disconnected' })
    await openMenu(wrapper)
    expect(wrapper.find('.ws-add-menu').exists()).toBe(false)
  })

  it('leaves every spawn-card control intact inside the dialog', async () => {
    // Manual spawn became a dialog; it must not have lost a control on the way.
    wrapper = mountWith()
    await openMenu(wrapper)
    await wrapper.find('.ws-add-card').trigger('click')
    const body = wrapper.find('.spawn-card-body')
    expect(body.findAll('select')).toHaveLength(2)      // CLI + role
    expect(body.find('.terminal-btn').exists()).toBe(true)
    expect(body.find('.resume-btn').exists()).toBe(true)
    expect(body.find('.resume-input').exists()).toBe(true)
  })

  it('the dialog is not in the sidebar until something opens it', () => {
    // The old card sat in the list all day whether or not it was wanted.
    wrapper = mountWith()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
    expect(wrapper.find('.spawn-card').exists()).toBe(false)
  })

  it('does not open itself on a spawn-mode workspace', async () => {
    // As a card, spawn mode opened it expanded. As a dialog that same default
    // puts it over the app at startup, unasked.
    wrapper = mountWith({ mode: 'spawn' })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
    // Nor when the mode changes under it.
    await wrapper.setProps({ mode: 'pipeline' } as never)
    await wrapper.setProps({ mode: 'spawn' } as never)
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
  })

  it('closes on Escape, the close button, and a click on the backdrop', async () => {
    wrapper = mountWith()

    const open = async (): Promise<void> => {
      await openMenu(wrapper)
      await wrapper.find('.ws-add-card').trigger('click')
      expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(true)
    }

    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)

    await open()
    await wrapper.find('.spawn-modal-close').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)

    await open()
    // .self — clicking the card inside it must NOT close the dialog.
    await wrapper.find('.spawn-card--modal').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(true)
    await wrapper.find('.spawn-modal-backdrop').trigger('click')
    expect(wrapper.find('.spawn-modal-backdrop').exists()).toBe(false)
  })
})

// ── the roster has to FIT, not merely render ────────────────────────────────
//
// This file already says it above: rendered is not the same as visible. The ＋
// menu's CLI list is a capped scroller, and when the roster outgrew that cap
// the entries below the fold read as vendors Navide did not support. That has
// now happened twice — once at eleven (handled by moving Terminal out of the
// list) and again at fourteen, where cursor/aider/muse/droid were all hidden.
//
// No mounted test can catch it: jsdom and happy-dom have no layout, so all
// fourteen buttons are "in the DOM" either way. These read the source instead,
// which is the only place the fact lives.
const COMPONENT_SRC = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/ControlPane.vue'),
  'utf-8'
)

/** Height of one `.ws-add-opt`: 12px text (--font-xs) plus 3px padding either
 *  side. Rounded up on purpose — overestimating a row makes the required cap
 *  larger, which fails safe; underestimating would let a too-short cap pass. */
const ROW_PX = 24

/** How many roster rows the cap must show before the list needs scrolling: the
 *  twenty CLIs main had. A fixed number; a longer roster scrolls. */
const ROWS_ALWAYS_SHOWN = 20

/** A `.ws-add-sec` heading (CLI, Agents): ~15px text plus 9px padding, and the
 *  second one adds a divider with 9px more space above it — 24 + 31, rounded up
 *  to 28 each. */
const HEADING_PX = 28

/** Everything in the menu that is not the scroller: its own padding, the role
 *  picker, two dividers, the cloud-agents hint (up to five lines, ~72px), and
 *  the Terminal + Manual-spawn buttons. */
const FURNITURE_PX = 152

function scrollerCapPx(): number {
  const m = COMPONENT_SRC.match(/\.ws-add-scroll\s*\{[\s\S]*?max-height:\s*min\((\d+)px/)
  if (!m) throw new Error('.ws-add-scroll has no `max-height: min(<n>px, …)` cap')
  return Number(m[1])
}

function flipThresholdPx(): number {
  const m = COMPONENT_SRC.match(/const ADD_MENU_MAX_H = (\d+)/)
  if (!m) throw new Error('ADD_MENU_MAX_H not found')
  return Number(m[1])
}

describe('ControlPane – the ＋ menu fits its roster', () => {
  it('the scroller cap is a fixed budget that scrolls, not a count of the roster', () => {
    // The cap does not grow with the CLI list (a new CLI edits nothing here):
    // it is a usable height, the roster scrolls past it, and the affordance
    // test below holds that scrolling to be visible.
    expect(scrollerCapPx()).toBeGreaterThanOrEqual(ROWS_ALWAYS_SHOWN * ROW_PX + 2 * HEADING_PX)
    const block = COMPONENT_SRC.match(/\.ws-add-scroll\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/overflow-y:\s*auto/)
  })

  it('the flip threshold tracks the scroller cap', () => {
    // ADD_MENU_MAX_H decides whether the menu opens downwards or flips up. It
    // is a hand-kept mirror of the CSS cap, so raising one without the other
    // lets the menu open downwards into a gap it no longer fits in — which is
    // exactly the drift that left it at 300 while the menu grew.
    expect(flipThresholdPx()).toBeGreaterThanOrEqual(scrollerCapPx() + FURNITURE_PX)
  })

  it('the scroller shows that it scrolls', () => {
    // A capped list with no affordance is what made a truncated roster read as
    // a complete one. The fades are `local` (they move with the content, so
    // each shows only while something is hidden that way) over `scroll`
    // shadows pinned to the box.
    const block = COMPONENT_SRC.match(/\.ws-add-scroll\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toContain('no-repeat local')
    expect(block).toContain('no-repeat scroll')
  })
})
