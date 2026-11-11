// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import type { DisplayStatus } from '@navide/terminal'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { i18n } from '@navide/plugin-ui/foundation'
import { paneStatusLabelKey } from '../../lib/paneStatusLabel'

// The pane-header status pill — the badge the user actually reads. Every value
// displayStatus can report has to reach it with its own data-status hook,
// because that attribute is the ONLY thing the per-status CSS selects on: a
// status with no rule renders as the neutral default, which is how 'awaiting'
// and 'idle' once looked identical. useTerminal is mocked out (no xterm, no
// backend) the same way TerminalPane.loginBadge.test.ts does it.

const mockTerminal = vi.hoisted(() => ({
  displayStatus: null as unknown as Ref<string>,
  awaitingKind: null as unknown as Ref<string | null>,
}))

// The badge resolves its text and its colour through the user-customization
// layer now. Mocked rather than driven through settings: what belongs here is
// that the pill honours an override at all — useStatusBadgePrefs.test.ts owns
// how one is stored.
const mockPrefs = vi.hoisted(() => ({
  label: '' as string,
  style: undefined as Record<string, string> | undefined,
}))

vi.mock('../../composables/useStatusBadgePrefs', () => ({
  statusBadgeLabelOverride: () => mockPrefs.label,
  statusBadgeStyle: () => mockPrefs.style,
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  mockTerminal.awaitingKind = ref(null)
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      awaitingKind: mockTerminal.awaitingKind,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function tMock(key: string): string {
  return key
}

function mountPane(status: DisplayStatus, kind: 'permission' | 'question' | null = null): VueWrapper {
  mockTerminal.displayStatus.value = status
  mockTerminal.awaitingKind.value = kind
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
    },
    global: { mocks: { $t: tMock } }
  })
}

// Listed by hand, then checked against the union below.
const ALL_DISPLAY_STATUSES = [
  'idle',
  'starting',
  'running',
  'exited',
  'error',
  'stopped',
  'awaiting',
] as const satisfies readonly DisplayStatus[]

// Compile-time exhaustiveness: a new displayStatus value that is not listed
// above makes `Missing` that literal instead of never, and `true` stops being
// assignable — the build fails naming exactly what was forgotten.
type MissingDisplayStatus = Exclude<DisplayStatus, (typeof ALL_DISPLAY_STATUSES)[number]>
const _allDisplayStatusesCovered: MissingDisplayStatus extends never
  ? true
  : MissingDisplayStatus = true

describe('TerminalPane — status pill', () => {
  // Optional: the exhaustiveness check below is a type assertion and mounts
  // nothing, so the teardown has to tolerate a test that never made a wrapper.
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    mockTerminal.displayStatus.value = 'idle'
    mockPrefs.label = ''
    mockPrefs.style = undefined
  })

  it('covers every value displayStatus can report', () => {
    expect(_allDisplayStatusesCovered).toBe(true)
  })

  it.each(ALL_DISPLAY_STATUSES)('carries data-status="%s" for the CSS to select on', (status) => {
    wrapper = mountPane(status)
    expect(wrapper!.get('.status').attributes('data-status')).toBe(status)
  })

  it.each(ALL_DISPLAY_STATUSES)('prints the shared label for %s', (status) => {
    // The pill, the sidebar pill and the agent-overview row all resolve their
    // text through paneStatusLabel. It used to print the raw status word with
    // 'awaiting' and 'stopped' as hand-made exceptions, which is how one pane
    // read "RUNNING" here and "執行中" in the overview at the same moment.
    // Asserted against i18n rather than against the resolver, so a resolver
    // that returned the key would still fail here.
    wrapper = mountPane(status)
    expect(wrapper!.get('.status').text()).toBe(i18n.global.t(paneStatusLabelKey(status)))
  })

  it.each(ALL_DISPLAY_STATUSES)('prints the user label for %s when there is one', (status) => {
    // Renaming a status has to reach the badge the user actually reads; a
    // surface still resolving the raw key looks correct until someone renames.
    mockPrefs.label = 'my-word'
    wrapper = mountPane(status)
    expect(wrapper!.get('.status').text()).toBe('my-word')
  })

  it('carries no inline colour while a status is at its default', () => {
    // The [data-status] rule is the default look; emitting variables for every
    // status would make the palette responsible for reproducing all of them.
    wrapper = mountPane('idle')
    expect(wrapper!.get('.status').attributes('style') ?? '').toBe('')
  })

  it('carries both badge variables once a status is recoloured', () => {
    mockPrefs.style = { '--status-badge-bg': 'var(--x-bg)', '--status-badge-fg': 'var(--x-fg)' }
    wrapper = mountPane('idle')
    const style = wrapper!.get('.status').attributes('style') ?? ''
    expect(style).toContain('--status-badge-bg: var(--x-bg)')
    expect(style).toContain('--status-badge-fg: var(--x-fg)')
  })

  it('prints the same label whichever kind of wait it is', () => {
    // The merge, asserted: a permission prompt and a question are one badge.
    // What separates them is the tooltip below, not the word on the pill.
    wrapper = mountPane('awaiting', 'permission')
    const permission = wrapper!.get('.status').text()
    wrapper!.unmount()
    wrapper = mountPane('awaiting', 'question')
    expect(wrapper!.get('.status').text()).toBe(permission)
  })

  it('explains which kind of wait it is on hover', () => {
    // One badge, two reasons. The distinction is not worth a second pill but is
    // worth a sentence: sharing awaiting's copy would send the user looking for
    // a permission prompt that is not there.
    wrapper = mountPane('awaiting', 'question')
    const key = wrapper!.get('.status').attributes('title')
    expect(key).toBe('pane.terminal.question-status-tooltip')

    wrapper!.unmount()
    wrapper = mountPane('awaiting', 'permission')
    expect(wrapper!.get('.status').attributes('title')).toBe(
      'pane.terminal.awaiting-status-tooltip'
    )
  })

  it('leaves the self-evident statuses without a tooltip', () => {
    wrapper = mountPane('running')
    expect(wrapper!.get('.status').attributes('title') ?? '').toBe('')
  })
})
