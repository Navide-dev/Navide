// @vitest-environment happy-dom
// Files opened from outside the editor window's workspace carry their own
// workspace root (`wsPath` = the file's parent directory). These tests pin the
// consequences: tab identity is (workspace, relPath), each pane reads/writes
// against its own tab's root, and an explorer rename in the window's workspace
// can never repoint a tab that belongs to another root.
//
// The window here runs on a REAL workspace ('/ws'), because the interesting
// half of `normWs()` is the folding branch — a wsPath equal to the window's
// own workspace must collapse to `undefined`, or the same file opens twice.
// Tabs are driven through the four production entry points that can actually
// carry a root (`onOpenEditorFile` IPC, the nav bridge's open target, the ⌘O
// picker command, and the entry query); ExplorerPane's `open-file` emit is
// typed `{ filepath, name }` and can never deliver one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import EditorWindowApp from '../../EditorWindowApp.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

const WS = '/ws'

function stub(name: string, props: string[] = []) {
  return {
    __esModule: true,
    default: defineComponent({
      name,
      props,
      inheritAttrs: false,
      render: () => h('div', { class: `stub-${name}` }),
    }),
  }
}

vi.mock('../../components/ExplorerPane.vue', () => stub('ExplorerPane'))
vi.mock('../../components/SearchPane.vue', () => stub('SearchPane'))
vi.mock('../../components/ProblemsPane.vue', () => stub('ProblemsPane'))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))
vi.mock('../PlanFileView.vue', () => stub('PlanFileView', ['workspacePath', 'relPath']))
vi.mock('../DiffPane.vue', () => stub('DiffPane'))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane', ['workspacePath', 'relPath']))

// EditorPane records which root its save() ran against — `workbench.action.
// saveAll` reaches panes through the host's ref map, and a save that used the
// window workspace instead of the tab's own root writes to the wrong file.
const localeWire = vi.hoisted(() => ({ language: '', settingsChanged: null as null | ((keys: string[]) => void), languageChanged: null as null | ((locale: string) => void) }))
const saveCalls = vi.hoisted(() => [] as Array<{ workspacePath: string; relPath: string }>)

vi.mock('@navide/plugin-ui/editor', () => ({
  EditorPane: defineComponent({
    name: 'EditorPane',
    props: {
      workspacePath: { type: String, default: '' },
      relPath: { type: String, default: '' },
      name: { type: String, default: '' },
    },
    inheritAttrs: false,
    methods: {
      save(): void {
        saveCalls.push({ workspacePath: this.workspacePath, relPath: this.relPath })
      },
    },
    render: () => h('div', { class: 'stub-EditorPane' }),
  }),
}))

vi.mock('../../composables/useBackend', () => ({
  useBackend: () => ({
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref('http://127.0.0.1:1'),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async () => ({ payload: { ok: true } })),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  }),
}))

vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: stub('AiCliDock').default,
}))

vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
  useTheme: () => ({ theme: ref('dark'), setTheme: vi.fn(), loadTheme: vi.fn() }),
  BUILTIN_THEMES: [],
}))

// Commands are captured rather than swallowed: ⌘O and ⌘⌥S are registered here,
// and invoking the registered handler is the only way to exercise the real
// command bodies without a keybinding runtime.
const commands = vi.hoisted(() => new Map<string, () => unknown>())

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((key: string, def: unknown) => key === 'agent-team:language' ? localeWire.language : def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn((callback: (keys: string[]) => void) => { localeWire.settingsChanged = callback; return () => { localeWire.settingsChanged = null } }),
  initKeybindingsPort: vi.fn(),
  useKeybindings: vi.fn(),
  registerCommand: vi.fn((id: string, fn: () => unknown) => { commands.set(id, fn) }),
  setContext: vi.fn(),
  executeCommand: vi.fn(),
}))

// The two host-pushed open channels, captured at onMounted.
const bridge = {
  onOpenEditorFile: undefined as ((p: Record<string, string>) => void) | undefined,
  onOpenTarget: undefined as ((p: Record<string, string>) => void) | undefined,
}

let pickFileResult: { ok: boolean; path?: string } = { ok: false }
// `fs:realpath` stand-in: paths absent from the map resolve to themselves,
// which is the no-symlink case every pre-existing test relies on.
let realpaths: Record<string, string> = {}

beforeEach(() => {
  localeWire.language = ''
  localeWire.settingsChanged = null
  localeWire.languageChanged = null
  i18n.global.locale.value = 'en-US'
  saveCalls.length = 0
  commands.clear()
  bridge.onOpenEditorFile = undefined
  bridge.onOpenTarget = undefined
  pickFileResult = { ok: false }
  realpaths = {}
  Object.assign(window, {
    agentTeam: {
      onSwitchEditorSidebar: vi.fn(),
      onLanguageChanged: (callback: (locale: string) => void) => { localeWire.languageChanged = callback },
      onOpenEditorFile: (cb: (p: Record<string, string>) => void) => { bridge.onOpenEditorFile = cb },
      onOpenEditorDiff: vi.fn(),
      pickFile: vi.fn(async () => pickFileResult),
      realpath: vi.fn(async (p: string) => realpaths[p] ?? p),
      openEditorWindow: vi.fn(async () => undefined),
    },
    nav: {
      onOpenTarget: (cb: (p: Record<string, string>) => void) => {
        bridge.onOpenTarget = cb
        return () => {}
      },
    },
  })
})

/** Mount the window on `/ws` (plus any extra entry-query params). */
async function mountApp(extraQuery = ''): Promise<VueWrapper> {
  window.history.replaceState({}, '', `/?window=editor&workspace_path=${WS}${extraQuery}`)
  const wrapper = mount(EditorWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

/** Open a file through the `editor:openFile` IPC channel — the production path
 *  used by every host-side "open this file in the mini-IDE" request. */
async function openViaIpc(filepath: string, fileWs?: string, extra: Record<string, string> = {}): Promise<void> {
  bridge.onOpenEditorFile?.({ filepath, ...(fileWs ? { file_ws: fileWs } : {}), ...extra })
  await flushPromises()
}

function panes(wrapper: VueWrapper) {
  return wrapper.findAllComponents({ name: 'EditorPane' })
}

describe('EditorWindowApp – files outside the workspace', () => {
  it('follows Japanese query, Host settings, native events and reused plugin targets', async () => {
    const wrapper = await mountApp('&locale=ja-JP')
    expect(i18n.global.locale.value).toBe('ja-JP')
    localeWire.language = 'en-US'
    localeWire.settingsChanged?.(['agent-team:language'])
    expect(i18n.global.locale.value).toBe('en-US')
    localeWire.languageChanged?.('ja-JP')
    expect(i18n.global.locale.value).toBe('ja-JP')
    bridge.onOpenTarget?.({ locale: 'en-US', filepath: 'a.ts' })
    await flushPromises()
    expect(i18n.global.locale.value).toBe('en-US')
    bridge.onOpenTarget?.({ locale: 'ja-JP', filepath: 'b.ts' })
    await flushPromises()
    expect(i18n.global.locale.value).toBe('ja-JP')
    expect(wrapper.findAll('.ide-tab')).toHaveLength(2)
    await wrapper.get('.ide-tab').trigger('contextmenu')
    expect(document.body.textContent).toContain('他を閉じる')
    localeWire.languageChanged?.('en-US')
    await wrapper.vm.$nextTick()
    expect(document.body.textContent).toContain('Close Others')
    wrapper.unmount()
    expect(localeWire.settingsChanged).toBeNull()
  })

  it('opens same-named files from two roots as two independent tabs', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', '/ext/dir')

    const tabs = wrapper.findAll('.ide-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.find('.ide-tab-name').text())).toEqual(['notes.txt', 'notes.txt'])
    expect(panes(wrapper)).toHaveLength(2)
  })

  it('reuses the tab when the same external file is opened again', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt', '/ext/dir')
    await openViaIpc('notes.txt', '/ext/dir')
    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
  })

  it('gives each pane its own tab workspace, so saves target the right root', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', '/ext/dir')

    const [inside, outside] = panes(wrapper)
    expect(inside.props('workspacePath')).toBe(WS)
    expect(inside.props('relPath')).toBe('notes.txt')
    // The external pane reads and writes through its own parent directory —
    // the backend's root check passes and the file resolves to /ext/dir/notes.txt.
    expect(outside.props('workspacePath')).toBe('/ext/dir')
    expect(outside.props('relPath')).toBe('notes.txt')
  })

  it('shows the absolute path in the tab tooltip for an external file only', async () => {
    const wrapper = await mountApp()
    await openViaIpc('docs/notes.txt')
    await openViaIpc('notes.txt', '/ext/dir')

    const tabs = wrapper.findAll('.ide-tab')
    expect(tabs[0].attributes('title')).toBe('docs/notes.txt')
    expect(tabs[1].attributes('title')).toBe('/ext/dir/notes.txt')
  })

  it('does not repoint an external tab when the explorer renames a same-named file', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', '/ext/dir')

    wrapper
      .findComponent({ name: 'ExplorerPane' })
      .vm.$emit('entry-renamed', { oldRel: 'notes.txt', newRel: 'renamed.txt' })
    await flushPromises()

    const [inside, outside] = panes(wrapper)
    expect(inside.props('relPath')).toBe('renamed.txt')
    // Rewriting this one would silently redirect its next save into the
    // workspace copy of the file.
    expect(outside.props('relPath')).toBe('notes.txt')
    expect(outside.props('workspacePath')).toBe('/ext/dir')
  })

  it('keeps per-tab view mode independent for same-named files', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.md')
    await openViaIpc('notes.md', '/ext/dir')

    // The external tab is active; toggling preview must not flip the other one.
    await wrapper.find('.ide-tab-act--preview-toggle').trigger('click')
    const preview = wrapper.findAllComponents({ name: 'PlanFileView' })
    expect(preview).toHaveLength(1)
    expect(preview[0].props('workspacePath')).toBe('/ext/dir')
    expect(panes(wrapper)).toHaveLength(1)
  })
})

// normWs() folds a root that IS the window's workspace back to `undefined`.
// Without it, a host that helpfully stamps `file_ws` on every open (it knows
// the file's directory, not whether it is "external") would key the same file
// under two different tab keys and open it twice.
describe('EditorWindowApp – normWs folding', () => {
  it('folds a file_ws equal to the window workspace into the plain workspace tab', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt', WS)
    await openViaIpc('notes.txt')

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe(WS)
    // Folded, so it is an in-workspace tab: relative tooltip, no absolute path.
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('notes.txt')
  })

  it('folds a trailing-slash form of the window workspace too', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', `${WS}/`)

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    expect(panes(wrapper)).toHaveLength(1)
  })

  it("keeps '/' as a root of its own instead of folding it into the workspace", async () => {
    // Regression: `'/'.replace(/\/+$/, '')` is '' — a falsy root that used to
    // fold, so /notes.txt opened as <workspace>/notes.txt (wrong file, or none).
    const wrapper = await mountApp()
    await openViaIpc('notes.txt', '/')

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/')
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('/notes.txt')
  })

  it("keeps a '/'-rooted file distinct from the same name in the workspace", async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', '/')

    expect(wrapper.findAll('.ide-tab')).toHaveLength(2)
    expect(panes(wrapper).map((p) => p.props('workspacePath'))).toEqual([WS, '/'])
  })
})

// The four production entry points that can carry a root. ExplorerPane's
// `open-file` emit is not one of them (its payload has no wsPath at all).
describe('EditorWindowApp – real open entry points carry file_ws', () => {
  it('onOpenEditorFile (IPC) opens an out-of-workspace file against file_ws', async () => {
    const wrapper = await mountApp()
    expect(bridge.onOpenEditorFile).toBeTypeOf('function')
    await openViaIpc('notes.txt', '/ext/dir', { name: 'notes.txt', line: '7' })

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/ext/dir')
    expect(pane.props('relPath')).toBe('notes.txt')
  })

  it('applyOpenTarget (nav bridge) opens an out-of-workspace file against file_ws', async () => {
    const wrapper = await mountApp()
    expect(bridge.onOpenTarget).toBeTypeOf('function')
    bridge.onOpenTarget?.({ filepath: 'notes.txt', file_ws: '/ext/dir' })
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/ext/dir')
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('/ext/dir/notes.txt')
  })

  it('applyOpenTarget folds a file_ws that equals the window workspace', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    bridge.onOpenTarget?.({ filepath: 'notes.txt', file_ws: WS })
    await flushPromises()

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
  })

  it('⌘O keeps an in-workspace pick relative to the window workspace', async () => {
    const wrapper = await mountApp()
    pickFileResult = { ok: true, path: `${WS}/docs/notes.txt` }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe(WS)
    expect(pane.props('relPath')).toBe('docs/notes.txt')
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('docs/notes.txt')
  })

  it('⌘O gives an out-of-workspace pick its own parent directory as root', async () => {
    const wrapper = await mountApp()
    pickFileResult = { ok: true, path: '/ext/dir/notes.txt' }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/ext/dir')
    expect(pane.props('relPath')).toBe('notes.txt')
  })

  it("⌘O gives a filesystem-root pick '/' as its root", async () => {
    const wrapper = await mountApp()
    pickFileResult = { ok: true, path: '/notes.txt' }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/')
    expect(pane.props('relPath')).toBe('notes.txt')
  })

  it('⌘O opens nothing when the picker is cancelled', async () => {
    const wrapper = await mountApp()
    pickFileResult = { ok: false }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    expect(panes(wrapper)).toHaveLength(0)
  })

  it('the entry query opens the initial file against its file_ws', async () => {
    // Cold start: Electron appends ?workspace_path=…&filepath=…&file_ws=… when
    // the window is created for an out-of-workspace file.
    const wrapper = await mountApp('&filepath=notes.txt&file_ws=/ext/dir&name=notes.txt')

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/ext/dir')
    expect(pane.props('relPath')).toBe('notes.txt')
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('/ext/dir/notes.txt')
  })

  it('the entry query without file_ws stays on the window workspace', async () => {
    const wrapper = await mountApp('&filepath=docs/notes.txt')

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe(WS)
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('docs/notes.txt')
  })

  it('an entry-query file_ws equal to the workspace does not open a second tab', async () => {
    const wrapper = await mountApp(`&filepath=notes.txt&file_ws=${WS}`)
    await openViaIpc('notes.txt')

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
  })
})

// A workspace reached through a symlink (/tmp/wt/proj vs /private/tmp/wt/proj —
// routine for git worktrees on macOS) has two spellings. The OS file picker
// always answers with the canonical one, so a literal-string prefix test files
// a ⌘O pick as "external": the same physical file gets a second tab with its
// own buffer and its own mtime baseline, and whichever is saved second silently
// overwrites the other's edits without tripping the conflict guard.
describe('EditorWindowApp – symlinked workspace aliases', () => {
  const REAL_WS = '/private/ws'

  /** Mount on `/ws`, which the filesystem resolves to `/private/ws`. */
  async function mountSymlinked(extraQuery = ''): Promise<VueWrapper> {
    realpaths = { [WS]: REAL_WS }
    return mountApp(extraQuery)
  }

  it('⌘O on the canonical path reuses the tab already open for that file', async () => {
    const wrapper = await mountSymlinked()
    await openViaIpc('src/a.ts')

    pickFileResult = { ok: true, path: `${REAL_WS}/src/a.ts` }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe(WS)
    expect(pane.props('relPath')).toBe('src/a.ts')
  })

  it('⌘O on the canonical path opens an in-workspace tab, not an external one', async () => {
    const wrapper = await mountSymlinked()
    pickFileResult = { ok: true, path: `${REAL_WS}/src/a.ts` }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe(WS)
    expect(pane.props('relPath')).toBe('src/a.ts')
    // Relative tooltip = the tab is inside the workspace; an external tab would
    // show /private/ws/src/a.ts and leak the canonical path into the UI.
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('src/a.ts')
  })

  it('still gives a genuinely external ⌘O pick its own root', async () => {
    const wrapper = await mountSymlinked()
    pickFileResult = { ok: true, path: '/ext/dir/notes.txt' }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/ext/dir')
    expect(pane.props('relPath')).toBe('notes.txt')
  })

  it('does not swallow a sibling directory that merely shares the canonical prefix', async () => {
    const wrapper = await mountSymlinked()
    pickFileResult = { ok: true, path: '/private/ws-other/notes.txt' }
    await commands.get('workbench.action.openFile')!()
    await flushPromises()

    const [pane] = panes(wrapper)
    expect(pane.props('workspacePath')).toBe('/private/ws-other')
    expect(pane.props('relPath')).toBe('notes.txt')
  })

  it('folds a canonical file_ws into the window workspace tab', async () => {
    const wrapper = await mountSymlinked()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', REAL_WS)

    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    expect(panes(wrapper)[0].props('workspacePath')).toBe(WS)
  })

  it("still keeps '/' as a root of its own under a symlinked workspace", async () => {
    const wrapper = await mountSymlinked()
    await openViaIpc('notes.txt', '/')

    expect(panes(wrapper)[0].props('workspacePath')).toBe('/')
    expect(wrapper.findAll('.ide-tab')[0].attributes('title')).toBe('/notes.txt')
  })
})

describe('EditorWindowApp – saveAll', () => {
  it('saves each dirty tab through its own root', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt')
    await openViaIpc('notes.txt', '/ext/dir')

    // Both panes report unsaved changes (EditorPane's `dirty` emit).
    for (const p of panes(wrapper)) p.vm.$emit('dirty', true)
    await flushPromises()

    await commands.get('workbench.action.saveAll')!()
    await flushPromises()

    // The external tab must save against /ext/dir — saving it through the
    // window workspace would silently overwrite /ws/notes.txt instead.
    expect(saveCalls).toContainEqual({ workspacePath: '/ext/dir', relPath: 'notes.txt' })
    expect(saveCalls).toContainEqual({ workspacePath: WS, relPath: 'notes.txt' })
    expect(saveCalls).toHaveLength(2)
  })

  it('does not save a clean external tab', async () => {
    const wrapper = await mountApp()
    await openViaIpc('notes.txt', '/ext/dir')
    panes(wrapper)[0].vm.$emit('dirty', false)
    await flushPromises()

    await commands.get('workbench.action.saveAll')!()
    await flushPromises()

    expect(saveCalls).toHaveLength(0)
  })
})
