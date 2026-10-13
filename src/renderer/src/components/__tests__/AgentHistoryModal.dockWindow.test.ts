// @vitest-environment happy-dom
// An embedded AI panel (AiCliDock) files its Agent History entry with the
// surface it lives on. Such an entry belongs to a window, not to this window's
// pane pool: its row names that window, and resuming it here would open it as
// a window pane — so its primary action opens the owning window instead (the
// Pipeline Manager, which lives in this window), or, for a window this one
// cannot open onto the panel, is disabled with the reason. Every entry without
// a surface renders exactly as it did before.
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHistoryModal from '../AgentHistoryModal.vue'
import type { SpawnHistoryEntry } from '../../lib/spawnHistory'
import { AI_PANEL_ICON_PATH } from '@navide/plugin-ui'
import { i18n } from '@navide/plugin-ui/foundation'

function entry(overrides: Partial<SpawnHistoryEntry> = {}): SpawnHistoryEntry {
  return {
    paneId: 'aaaa1111-2222',
    agentKey: 'claude',
    agentLabel: 'Claude',
    roleKey: 'dev' as SpawnHistoryEntry['roleKey'],
    roleLabel: 'Dev',
    command: 'claude',
    sessionId: 'sess-1',
    origin: 'manual',
    stageId: 'dev' as SpawnHistoryEntry['stageId'],
    workspacePath: '/ws',
    spawnedAt: '2026-08-08T10:21:34Z',
    ...overrides,
  }
}

async function mountModal(sessionHistory: SpawnHistoryEntry[], extra: Record<string, unknown> = {}) {
  const wrapper = mount(AgentHistoryModal, {
    props: {
      show: false,
      sessionHistory,
      paneCount: 1,
      revivingPaneId: '',
      unavailablePaneIds: new Set<string>(),
      activePaneIds: new Set<string>(),
      previewOpen: false,
      previewTitle: '',
      previewContent: '',
      ...extra,
    },
    global: {
      stubs: { teleport: true },
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key} ${JSON.stringify(params)}` : key,
      },
    },
  })
  await wrapper.setProps({ show: true })
  await flushPromises()
  return wrapper
}

const removed = { removedAt: '2026-08-08T11:00:00Z' }

describe('AgentHistoryModal — entries of an embedded panel', () => {
  it('marks the row with the AI panel icon and names the window only in the detail', async () => {
    const wrapper = await mountModal([entry({ ...removed, surface: 'pm', windowKind: 'main' })])
    // The list carries the mark alone — its full name is the tooltip — so a
    // long window name can never crowd the row's own name off a 320px column.
    const rowMark = wrapper.find('.agent-history-row .ah-window')
    expect(rowMark.exists()).toBe(true)
    expect(rowMark.text()).toBe('')
    expect(rowMark.attributes('title')).toBe('dockWindow.pm')
    expect(rowMark.find('svg path').attributes('d')).toBe(AI_PANEL_ICON_PATH)
    const detail = wrapper.find('.detail-title-row .ah-window')
    expect(detail.text()).toBe('dockWindow.pm')
    expect(detail.find('svg path').attributes('d')).toBe(AI_PANEL_ICON_PATH)
  })

  it('draws every mark from the one icon source — no text glyphs', async () => {
    const wrapper = await mountModal([entry({ ...removed, surface: 'git', windowKind: 'git' })])
    const marks = wrapper.findAll('.ah-window, .ah-open-window')
    expect(marks.length).toBe(3)
    for (const m of marks) {
      expect(m.find('svg path').attributes('d')).toBe(AI_PANEL_ICON_PATH)
      expect(m.text()).not.toMatch(/[\u2190-\u2BFF\u{1F300}-\u{1FAFF}]/u)
    }
  })

  it('opens the Pipeline Manager instead of resuming a pm panel as a window pane', async () => {
    const wrapper = await mountModal([entry({ ...removed, surface: 'pm', windowKind: 'main' })])
    expect(wrapper.text()).not.toContain('action.resume-session')
    const open = wrapper.find('.ah-open-window')
    expect(open.exists()).toBe(true)
    expect(open.attributes('disabled')).toBeUndefined()
    expect(open.text()).toContain('dockWindow.open-in')
    await open.trigger('click')
    const emitted = wrapper.emitted('open-in-window')
    expect(emitted).toHaveLength(1)
    expect((emitted![0][0] as SpawnHistoryEntry).paneId).toBe('aaaa1111-2222')
    expect(wrapper.emitted('resume')).toBeUndefined()
    // Its log and its delete stay exactly where they were.
    expect(wrapper.find('.ah-preview').exists()).toBe(true)
    expect(wrapper.find('.ah-delete').exists()).toBe(true)
  })

  it('does not offer a live pm panel as a pane to jump to either', async () => {
    const wrapper = await mountModal([entry({ surface: 'pm', windowKind: 'main' })])
    expect(wrapper.find('.ah-focus').exists()).toBe(false)
    expect(wrapper.find('.ah-open-window').exists()).toBe(true)
    await wrapper.find('.agent-history-row').trigger('dblclick')
    expect(wrapper.emitted('focus-pane')).toBeUndefined()
  })

  it('cannot open another project\'s Pipeline Manager, and says why', async () => {
    const wrapper = await mountModal(
      [entry({ ...removed, surface: 'pm', windowKind: 'main' })],
      { viewingWorkspace: 'other' },
    )
    const open = wrapper.find('.ah-open-window')
    expect(open.attributes('disabled')).toBeDefined()
    expect(open.attributes('title')).toContain('dockWindow.resumes-in-window')
  })

  it.each(['plans', 'git', 'editor'])(
    'disables resume of a %s panel and explains it resumes inside its window',
    async (surface) => {
      const wrapper = await mountModal([entry({ ...removed, surface, windowKind: surface })])
      expect(wrapper.text()).not.toContain('action.resume-session')
      const open = wrapper.find('.ah-open-window')
      expect(open.attributes('disabled')).toBeDefined()
      expect(open.attributes('title')).toContain('dockWindow.resumes-in-window')
      expect(open.attributes('title')).toContain(`dockWindow.${surface}`)
      expect(wrapper.find('.agent-history-row .ah-window').attributes('title')).toBe(`dockWindow.${surface}`)
      expect(wrapper.find('.detail-title-row .ah-window').text()).toBe(`dockWindow.${surface}`)
    },
  )

  it('renders a window-pane entry exactly as before', async () => {
    for (const e of [entry({ ...removed }), entry(), entry({ ...removed, surface: 'main' })]) {
      const wrapper = await mountModal([e])
      expect(wrapper.find('.ah-window').exists()).toBe(false)
      expect(wrapper.find('.ah-open-window').exists()).toBe(false)
      // `<!--v-if-->` is Vue's invisible placeholder for an untaken branch;
      // everything a user or an accessibility tree can see is compared — except
      // the timestamps, which render in the machine's time zone and locale (CI
      // runs in UTC). They are swapped for tokens computed with the same
      // formatters the modal uses, so the snapshot holds on any machine while
      // still proving each timestamp sits exactly where it did.
      const loc = i18n.global.locale.value
      const stamps: Array<[string | undefined, string]> = [[e.spawnedAt, '{spawnedAt}'], [e.removedAt, '{removedAt}']]
      const dom = (sel: string) => {
        let html = wrapper.find(sel).element.outerHTML.replace(/<!--v-if-->/g, '')
        // Whole timestamps first, then the date-only and time-only forms the
        // row uses: two stamps on the same day share their date part.
        for (const format of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
          for (const [iso, token] of stamps) {
            if (iso) html = html.split(new Date(iso)[format](loc)).join(token)
          }
        }
        return html
      }
      expect(dom('.agent-history-row')).toMatchSnapshot()
      expect(dom('.history-detail')).toMatchSnapshot()
    }
  })
})
