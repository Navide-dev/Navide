// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the file-drop branch of onTerminalDrop: dropped paths are
// stabilized (macOS moves screenshots out of its temp dir moments after the
// drag, so main copies them somewhere we own) and then pasted shell-escaped.
// The branch had no test before the stabilize step made it async, so these
// also pin the pre-existing behaviour: the exited/error guard, the CLI-pane
// branch taking precedence, and the fallback when the bridge is unavailable.

const mockPasteText = vi.fn()
const mockPasteFromClipboard = vi.fn()
const mockDisplayStatus = { value: 'idle' }

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: mockPasteText,
      pasteFromClipboard: mockPasteFromClipboard,
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockDisplayStatus,
      sessionId: ref('pty-1'),
      isAltBuffer: ref(false)
    })
  }
})

const mockGetPathForFile = vi.fn<(f: File) => string>()
const mockStabilize = vi.fn<(paths: string[]) => Promise<{ ok: boolean; paths: string[] }>>()

/** A drop event carrying native files, the shape extractDropPaths reads. */
function fileDropEvent(files: File[], types: string[] = ['Files']): Event {
  const items = files.map((file) => ({ kind: 'file', type: '', getAsFile: () => file }))
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: {
      types,
      items: { length: items.length, ...Object.fromEntries(items.map((it, i) => [i, it])),
        [Symbol.iterator]: function* () { yield* items } },
      files: { length: files.length, ...Object.fromEntries(files.map((f, i) => [i, f])),
        [Symbol.iterator]: function* () { yield* files } },
      getData: () => ''
    }
  })
  return ev
}

function mountPane(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: [],
    },
    global: { mocks: { $t: (key: string) => key } }
  })
}

/** Lets the async drop handler run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('TerminalPane – dropping files onto the terminal', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    mockPasteText.mockReset()
    mockPasteFromClipboard.mockReset()
    mockGetPathForFile.mockReset()
    mockStabilize.mockReset()
    mockDisplayStatus.value = 'idle'
    vi.stubGlobal('window', {
      ...window,
      agentTeam: {
        getPathForFile: mockGetPathForFile,
        stabilizeDroppedPaths: mockStabilize
      }
    })
    wrapper = mountPane()
  })

  afterEach(() => {
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  async function dropFiles(paths: string[], types?: string[]): Promise<void> {
    const files = paths.map((p) => new File([''], p.split('/').pop() ?? 'f'))
    files.forEach((f, i) => mockGetPathForFile.mockReturnValueOnce(paths[i]))
    wrapper.find('.xterm-host').element.dispatchEvent(fileDropEvent(files, types))
    await settle()
  }

  it('pastes the stabilized path, not the temp path macOS is about to reclaim', async () => {
    mockStabilize.mockResolvedValue({
      ok: true,
      paths: ['/userData/dropped-files/Screenshot 2026-08-07.png']
    })
    await dropFiles(['/var/folders/T/TemporaryItems/NSIRD_x/Screenshot 2026-08-07.png'])

    expect(mockStabilize).toHaveBeenCalledWith([
      '/var/folders/T/TemporaryItems/NSIRD_x/Screenshot 2026-08-07.png'
    ])
    expect(mockPasteFromClipboard).toHaveBeenCalledWith('/userData/dropped-files/Screenshot\\ 2026-08-07.png')
  })

  it('escapes metacharacters Terminal.app-style and space-joins multiple paths', async () => {
    mockStabilize.mockResolvedValue({ ok: true, paths: ['/a/one.ts', "/b/it's a (test).ts"] })
    await dropFiles(['/a/one.ts', "/b/it's a (test).ts"])

    // Unquoted: a quoted path is not recognised as an image by CLI agents.
    expect(mockPasteFromClipboard).toHaveBeenCalledWith("/a/one.ts /b/it\\'s\\ a\\ \\(test\\).ts")
  })

  it('still pastes the raw path when the stabilize bridge is unavailable', async () => {
    vi.stubGlobal('window', { ...window, agentTeam: { getPathForFile: mockGetPathForFile } })
    await dropFiles(['/Users/test/notes.md'])

    expect(mockPasteFromClipboard).toHaveBeenCalledWith('/Users/test/notes.md')
  })

  it('still pastes the raw path when stabilizing fails', async () => {
    mockStabilize.mockRejectedValue(new Error('ipc down'))
    await dropFiles(['/Users/test/notes.md'])

    expect(mockPasteFromClipboard).toHaveBeenCalledWith('/Users/test/notes.md')
  })

  it('ignores the drop entirely once the pane has exited', async () => {
    mockDisplayStatus.value = 'exited'
    await dropFiles(['/Users/test/notes.md'])

    expect(mockStabilize).not.toHaveBeenCalled()
    expect(mockPasteFromClipboard).not.toHaveBeenCalled()
  })

  it('does not touch the file path when the drag is a CLI pane instead', async () => {
    await dropFiles(['/Users/test/notes.md'], ['application/x-pane-id'])

    expect(mockStabilize).not.toHaveBeenCalled()
    expect(mockPasteFromClipboard).not.toHaveBeenCalled()
  })

  it('does nothing when the drop carries no resolvable path', async () => {
    mockGetPathForFile.mockReturnValue('')
    wrapper.find('.xterm-host').element.dispatchEvent(fileDropEvent([new File([''], 'x')]))
    await settle()

    expect(mockStabilize).not.toHaveBeenCalled()
    expect(mockPasteFromClipboard).not.toHaveBeenCalled()
  })
})
