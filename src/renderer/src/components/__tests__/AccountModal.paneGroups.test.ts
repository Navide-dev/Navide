// @vitest-environment happy-dom
// What the pane roster actually renders, by mounting it.
//
// The rest of this modal's network coverage is source-scan. The redesign this
// covers is about what a person sees before they scroll — sections instead of
// one flat list, the never-opened panes folded away, the workspace said once
// per run instead of once per row — and none of those are facts about source
// text. They are facts about output, so this file renders them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { _resetForTest } from '../../composables/usePairingState'

let wrapper: VueWrapper | undefined
const original = i18n.global.locale.value

interface PaneSeed {
  title: string
  workspace: string
  status: string
  agentKey?: string
  startedAt?: string
  hostOnline?: boolean
}

function pane(seed: PaneSeed, index: number): Record<string, unknown> {
  return {
    sessionId: `s${index}`,
    paneId: `p${index}`,
    agentKey: seed.agentKey ?? 'claude',
    title: seed.title,
    workspace: seed.workspace,
    workspacePath: `/tmp/${seed.workspace}`,
    status: seed.status,
    hostOnline: seed.hostOnline ?? true,
    startedAt: seed.startedAt ?? '',
  }
}

/** The backend sorts by (workspace, title) before it ever reaches the view, and
 *  the section split relies on that — so the fixture arrives sorted too. */
function sorted(seeds: PaneSeed[]): PaneSeed[] {
  return [...seeds].sort((a, b) =>
    a.workspace === b.workspace ? a.title.localeCompare(b.title) : a.workspace.localeCompare(b.workspace),
  )
}

async function mountModal(
  seeds: PaneSeed[],
  /** `online: null` sends a device row without the field at all. */
  extraDevice?: { name: string; seeds: PaneSeed[]; online?: boolean | null },
) {
  ;(window as unknown as Record<string, unknown>).agentTeam = { trustConfirm: vi.fn() }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  const devices: unknown[] = [
    {
      deviceId: 'me',
      deviceName: 'This one',
      isLocal: true,
      online: true,
      paneCount: seeds.length,
      panes: sorted(seeds).map(pane),
    },
  ]
  if (extraDevice) {
    const row: Record<string, unknown> = {
      deviceId: 'other',
      deviceName: extraDevice.name,
      isLocal: false,
      online: extraDevice.online ?? true,
      paneCount: extraDevice.seeds.length,
      panes: sorted(extraDevice.seeds).map(pane),
      trustState: 'trusted',
    }
    if (extraDevice.online === null) delete row.online
    devices.push(row)
  }
  mock.setResponse('p2p.network.snapshot', { state: 'connected', deviceId: 'me', devices })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

const t = (key: string) => i18n.global.t(key)

/** Section headers, as "<name> <count>" — the two things a folded section still
 *  has to answer. */
function sections(): string[] {
  return (wrapper?.findAll('.grp-head') ?? []).map((head) =>
    `${head.find('.grp-name').text()} ${head.find('.grp-count').text()}`,
  )
}

function paneTitles(): string[] {
  return (wrapper?.findAll('.pane .pane-name') ?? []).map((node) => node.text())
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  try {
    localStorage.clear()
  } catch {
    /* happy-dom always has one; this is belt and braces */
  }
})

afterEach(() => {
  _resetForTest()
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = original
  delete (window as unknown as Record<string, unknown>).agentTeam
})

describe('the pane roster', () => {
  const MIXED: PaneSeed[] = [
    { title: 'Reclaim button', workspace: 'Agent-Team', status: 'running' },
    { title: 'Release notes', workspace: 'Agent-Team', status: 'waiting' },
    { title: 'Plan tidy-up', workspace: 'Agent-Team', status: 'not-opened' },
    { title: 'Site copy', workspace: 'Navide-Server', status: 'waiting' },
    { title: 'Old branch', workspace: 'Navide-Server', status: 'not-opened' },
  ]

  it('files panes into sections and counts them', async () => {
    await mountModal(MIXED)
    expect(sections()).toEqual([
      `${t('settings.p2p.network.group-running')} 1`,
      `${t('settings.p2p.network.group-idle')} 2`,
      `${t('settings.p2p.network.group-not-opened')} 2`,
    ])
  })

  it('starts with the never-opened panes folded away', async () => {
    await mountModal(MIXED)
    // The whole benefit of the redesign at the real scale: 63 of 74 panes were
    // in this state, and shown they were 85% of the list.
    expect(paneTitles()).toEqual(['Reclaim button', 'Release notes', 'Site copy'])
    const notOpened = wrapper!.findAll('.grp-head').at(2)!
    expect(notOpened.attributes('aria-expanded')).toBe('false')
    await notOpened.trigger('click')
    expect(paneTitles()).toContain('Plan tidy-up')
    expect(paneTitles()).toContain('Old branch')
  })

  it('remembers a fold across a remount', async () => {
    await mountModal(MIXED)
    await wrapper!.findAll('.grp-head')[0].trigger('click')
    expect(paneTitles()).not.toContain('Reclaim button')
    wrapper!.unmount()
    _resetForTest()
    await mountModal(MIXED)
    expect(paneTitles()).not.toContain('Reclaim button')
  })

  it('survives a localStorage that refuses to answer', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await mountModal(MIXED)
    // Defaults only, but a roster all the same — a private window must not turn
    // this list into an empty box.
    expect(paneTitles()).toEqual(['Reclaim button', 'Release notes', 'Site copy'])
    spy.mockRestore()
  })

  it('rules off the workspace only where a section spans more than one', async () => {
    await mountModal(MIXED)
    const rules = wrapper!.findAll('.pane-wsrule').map((node) => node.text())
    // "Idle" holds both workspaces and is ruled; "Running" holds one and is not.
    expect(rules).toEqual(['Agent-Team', 'Navide-Server'])
  })

  it('files every word the wire can carry, and loses none of them', async () => {
    // The wire vocabulary, as AccountModal.network.test.ts pins it. A pane that
    // fell through the grouping would simply vanish from the list — a failure
    // that looks exactly like "that machine is not running anything".
    const WIRE = [
      'running', 'idle', 'starting', 'awaiting', 'exited', 'error', 'stopped',
      'disconnected', 'not-opened', 'waiting',
    ]
    await mountModal(WIRE.map((status, i) => ({ title: `p${i}-${status}`, workspace: 'W', status })))
    // Every section expanded, so nothing is hidden behind a fold.
    for (const head of wrapper!.findAll('.grp-head')) {
      if (head.attributes('aria-expanded') === 'false') await head.trigger('click')
    }
    expect(paneTitles()).toHaveLength(WIRE.length)
    expect(sections()).toEqual([
      `${t('settings.p2p.network.group-running')} 1`,
      `${t('settings.p2p.network.group-idle')} 7`,
      `${t('settings.p2p.network.group-not-opened')} 2`,
    ])
  })

  it('keeps a pane from a newer build visible instead of dropping it', async () => {
    // A machine on a build this one has never seen can report a word with no
    // label and no section of its own. It belongs with the quiet ones, and it
    // has to still be on the list.
    await mountModal([
      { title: 'From the future', workspace: 'W', status: 'hyperdrive' },
      { title: 'Ordinary', workspace: 'W', status: 'running' },
    ])
    expect(paneTitles()).toContain('From the future')
    await wrapper!.find('.pane-search-input').setValue('future')
    // Unlabelled, the raw word is shown rather than a dotted i18n key.
    expect(wrapper!.find('.panes.flat .pane-pill').text()).toBe('hyperdrive')
  })

  it('gives a pane with no workspace no caption, and still lists it', async () => {
    // The server can send an empty workspace. A rule built from it would be a
    // blank line with a hairline through it, which reads as a rendering fault.
    await mountModal([
      { title: 'Homeless', workspace: '', status: 'running' },
      { title: 'Housed', workspace: 'Agent-Team', status: 'running' },
    ])
    expect(paneTitles()).toEqual(['Homeless', 'Housed'])
    expect(wrapper!.findAll('.pane-wsrule').map((node) => node.text())).toEqual(['Agent-Team'])
  })

  it('draws no empty section', async () => {
    await mountModal([{ title: 'Only one', workspace: 'Agent-Team', status: 'running' }])
    expect(sections()).toEqual([`${t('settings.p2p.network.group-running')} 1`])
  })

  it('says nothing twice on a pane row', async () => {
    await mountModal(MIXED)
    const row = wrapper!.find('.pane')
    // The section says the status and the rule says the workspace; a row that
    // repeated either is the clutter this replaced.
    expect(row.find('.pane-pill').exists()).toBe(false)
    expect(row.find('.pane-ws').exists()).toBe(false)
    // Full name on hover comes from v-truncate, only when the name is cut off.
    expect(row.find('.pane-name').text()).toBe('Reclaim button')
    expect(row.find('.pane-name').attributes('data-truncate')).toBe('')
    expect(row.find('.pane-name').attributes('title')).toBeUndefined()
  })

  it('dates a pane from its start time, and says nothing when it has none', async () => {
    await mountModal([
      { title: 'Dated', workspace: 'W', status: 'running', startedAt: new Date(Date.now() - 8 * 60_000).toISOString() },
      { title: 'Undated', workspace: 'W', status: 'running' },
    ])
    const times = wrapper!.findAll('.pane-time').map((node) => node.text())
    expect(times[0]).toMatch(/8/)
    // A roster that did not report a start time must not invent one.
    expect(times[1]).toBe('')
  })

  it('counts every machine on the tiles, and narrows to one state on click', async () => {
    await mountModal(MIXED, {
      name: 'Laptop',
      seeds: [{ title: 'Remote job', workspace: 'Agent-Team', status: 'running' }],
    })
    const tiles = wrapper!.findAll('.pane-tile .tile-n').map((node) => node.text())
    expect(tiles).toEqual(['2', '2', '2'])

    await wrapper!.findAll('.pane-tile')[0].trigger('click')
    expect(sections()).toEqual([`${t('settings.p2p.network.group-running')} 1`])
    await wrapper!.findAll('.pane-tile')[0].trigger('click')
    expect(sections().length).toBe(3)
  })

  it('never counts a pane nobody can reach as running or idle', async () => {
    // The real roster: another machine's restored placeholders arrive as
    // "disconnected" (only this machine can say "not opened"), and a machine
    // that has gone away keeps its last rows (next test). Filed under Idle they
    // were 45 of the 69 on the tile — panes a message sent now would never reach.
    await mountModal(MIXED, {
      name: 'Laptop',
      seeds: [
        { title: 'Placeholder there', workspace: 'W', status: 'disconnected' },
        { title: 'Live there', workspace: 'W', status: 'idle' },
      ],
    })
    const tiles = wrapper!.findAll('.pane-tile .tile-n').map((node) => node.text())
    expect(tiles).toEqual(['1', '3', '3'])
  })

  it('takes reachability from the device, not from the stale per-pane flag', async () => {
    // The per-pane flag is a directory snapshot; presence moves the device's
    // `online` without refreshing it. A machine that just went away still has
    // rows saying hostOnline, and one that just came back has rows saying not.
    await mountModal(MIXED, {
      name: 'Laptop',
      online: false,
      seeds: [
        { title: 'Was busy', workspace: 'W', status: 'running', hostOnline: true },
        { title: 'Was idle', workspace: 'W', status: 'idle', hostOnline: true },
      ],
    })
    expect(wrapper!.findAll('.pane-tile .tile-n').map((node) => node.text())).toEqual(['1', '2', '4'])
    wrapper?.unmount()

    await mountModal(MIXED, {
      name: 'Laptop',
      online: true,
      seeds: [
        { title: 'Back busy', workspace: 'W', status: 'running', hostOnline: false },
        { title: 'Back idle', workspace: 'W', status: 'idle', hostOnline: false },
      ],
    })
    expect(wrapper!.findAll('.pane-tile .tile-n').map((node) => node.text())).toEqual(['2', '3', '2'])
  })

  it('falls back to the per-pane flag when a device row does not say', async () => {
    await mountModal(MIXED, {
      name: 'Laptop',
      online: null,
      seeds: [
        { title: 'Live', workspace: 'W', status: 'running', hostOnline: true },
        { title: 'Gone', workspace: 'W', status: 'idle', hostOnline: false },
      ],
    })
    expect(wrapper!.findAll('.pane-tile .tile-n').map((node) => node.text())).toEqual(['2', '2', '3'])
  })

  it('starts another machine folded, because this one is what was asked for', async () => {
    await mountModal(MIXED, {
      name: 'Laptop',
      seeds: [{ title: 'Remote job', workspace: 'Agent-Team', status: 'running' }],
    })
    expect(paneTitles()).not.toContain('Remote job')
    const remote = wrapper!.findAll('.dev-fold').at(1)!
    await remote.trigger('click')
    expect(paneTitles()).toContain('Remote job')
  })

  it('flattens on search and gives the state back to the row', async () => {
    await mountModal(MIXED)
    await wrapper!.find('.pane-search-input').setValue('plan')
    expect(sections()).toEqual([])
    const hits = wrapper!.findAll('.panes.flat .pane')
    expect(hits).toHaveLength(1)
    // Out of its section the row has nothing else saying what state it is in.
    expect(hits[0].find('.pane-pill').text()).toBe(i18n.global.t('paneStatus.waiting'))
    expect(hits[0].find('.pane-ws').text()).toContain('Agent-Team')
  })

  it('searches the workspace, the agent and the machine, not just the title', async () => {
    await mountModal(MIXED, {
      name: 'Laptop',
      seeds: [{ title: 'Remote job', workspace: 'Elsewhere', status: 'running', agentKey: 'codex' }],
    })
    await wrapper!.find('.pane-search-input').setValue('navide-server')
    expect(wrapper!.findAll('.panes.flat .pane')).toHaveLength(2)

    await wrapper!.find('.pane-search-input').setValue('codex')
    expect(wrapper!.findAll('.panes.flat .pane')).toHaveLength(1)

    // A folded machine still answers a search: the fold is about what is worth
    // showing by default, not about what exists.
    await wrapper!.find('.pane-search-input').setValue('laptop')
    expect(wrapper!.findAll('.panes.flat .pane')).toHaveLength(1)
  })

  it('says so when nothing matches, rather than showing an empty box', async () => {
    await mountModal(MIXED)
    await wrapper!.find('.pane-search-input').setValue('zzzz')
    expect(wrapper!.findAll('.panes.flat .pane')).toHaveLength(0)
    expect(wrapper!.text()).toContain(t('settings.p2p.network.no-match'))
  })

  it('finds a never-opened pane even though its section is folded', async () => {
    await mountModal(MIXED)
    await wrapper!.find('.pane-search-input').setValue('old branch')
    expect(wrapper!.findAll('.panes.flat .pane')).toHaveLength(1)
  })
})
