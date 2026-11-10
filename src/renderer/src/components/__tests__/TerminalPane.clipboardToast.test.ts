// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// A copy or paste that comes to nothing writes a diagnostic line, which serves
// a later bug report. The pane also has to tell the person who just pressed
// ⌘V — "I pasted and nothing appeared" is the report of someone who was given
// no feedback at all. useTerminal reports the failure; the pane owns i18n and
// the toast, so this is where the decisions live: which are errors, and how
// often the same one may be repeated.

const captured = vi.hoisted(() => ({
  onClipboardFailure: undefined as ((reason: string, chars: number) => void) | undefined
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: (
      _paneId: string,
      _backend: unknown,
      opts?: { onClipboardFailure?: (reason: string, chars: number) => void }
    ) => {
      captured.onClipboardFailure = opts?.onClipboardFailure
      return {
        mount: vi.fn(),
        stopIneffective: { value: false },
        pasteText: vi.fn(),
        updateXtermTheme: vi.fn(),
        setDisableStdin: vi.fn(),
        getSelection: () => '',
        displayStatus: ref('idle'),
        sessionId: { value: '' },
        isAltBuffer: ref(false)
      }
    }
  }
})

const toasts = vi.hoisted(() => [] as Array<{ message: string, type?: string }>)

vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({
    toast: (message: string, opts?: { type?: string }) => { toasts.push({ message, type: opts?.type }) }
  }),
  // Echo the key and its params so assertions can see both without pinning
  // wording, which belongs to the locale files rather than to this behaviour.
  i18n: {
    global: {
      t: (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}`,
      // The status pill resolves a user-renamed label per locale, so the stub
      // needs the locale ref too — without it the header throws while mounting
      // and every clipboard assertion below fails for an unrelated reason.
      locale: { value: 'en-US' }
    }
  },
}))

function mountPane(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
    },
    global: { mocks: { $t: (key: string) => key } }
  })
}

describe('TerminalPane — clipboard failure toasts', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    toasts.length = 0
    captured.onClipboardFailure = undefined
    wrapper = mountPane()
  })

  afterEach(() => {
    vi.useRealTimers()
    wrapper?.unmount()
  })

  it('hands the failure to useTerminal as a callback', () => {
    expect(captured.onClipboardFailure).toBeTypeOf('function')
  })

  it('names the pane, since the toast is global and several may be open', () => {
    captured.onClipboardFailure!('preparing', 22)
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toContain('pane.terminal.clipboard-preparing')
    expect(toasts[0].message).toContain('Claude')
    expect(toasts[0].message).toContain('22')
  })

  // "Try again in a moment" is not the same news as "this pane is dead" or
  // "the copy you think you made did not happen".
  it('rates a retryable failure as info and a lost one as an error', () => {
    captured.onClipboardFailure!('preparing', 5)
    captured.onClipboardFailure!('no-session', 5)
    captured.onClipboardFailure!('copy-failed', 0)
    expect(toasts.map((t) => t.type)).toEqual(['info', 'error', 'error'])
  })

  // useNotify has no dedupe, and these repeat easily — holding ⌘V while a pane
  // starts reports on every press — so identical toasts would stack to its cap.
  it('shows one toast per reason however often it repeats', () => {
    captured.onClipboardFailure!('preparing', 10)
    captured.onClipboardFailure!('preparing', 10)
    captured.onClipboardFailure!('preparing', 10)
    expect(toasts).toHaveLength(1)
  })

  it('still reports a different reason straight away', () => {
    captured.onClipboardFailure!('preparing', 10)
    captured.onClipboardFailure!('empty', 0)
    expect(toasts.map((t) => t.type)).toEqual(['info', 'info'])
    expect(toasts[1].message).toContain('clipboard-empty')
  })

  // Suppression is a rate limit, not a mute: a failure that recurs later is
  // news again.
  it('reports the same reason again once the window has passed', () => {
    vi.useFakeTimers()
    captured.onClipboardFailure!('preparing', 10)
    vi.advanceTimersByTime(3100)
    captured.onClipboardFailure!('preparing', 10)
    expect(toasts).toHaveLength(2)
  })
})
