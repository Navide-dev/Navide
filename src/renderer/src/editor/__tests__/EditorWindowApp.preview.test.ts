// @vitest-environment happy-dom
// Routing tests for the editor window's file-preview integration: media/PDF/
// binary files auto-open in FilePreviewPane, markdown gets a Preview/Raw
// toggle (PlanFileView pipeline), .plan.md and text files are unaffected.
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import EditorWindowApp from '../../EditorWindowApp.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

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

// Heavy child panes are replaced with named stubs — this test only exercises
// the host's routing (which pane the v-if chain mounts).
vi.mock('../../components/ExplorerPane.vue', () => stub('ExplorerPane'))
vi.mock('../../components/SearchPane.vue', () => stub('SearchPane'))
vi.mock('../../components/ProblemsPane.vue', () => stub('ProblemsPane'))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))
vi.mock('@navide/plugin-ui/editor', () => ({ EditorPane: stub('EditorPane').default }))
vi.mock('../PlanFileView.vue', () => stub('PlanFileView'))
vi.mock('../DiffPane.vue', () => stub('DiffPane'))
vi.mock('../FilePreviewPane.vue', () => stub('FilePreviewPane'))

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

vi.mock('@navide/plugin-ui/shared', () => ({
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((_key: string, def: unknown) => def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
}))

vi.mock('@navide/plugin-shell', async (importOriginal) => {
  const { defineComponent: makeComponent, h: hVue, ref: refVue } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/plugin-shell')>()
  const aiDockStub = makeComponent({
    name: 'AiCliDock',
    props: {
      widthKey: String,
      origin: String,
      paneId: String,
      workspacePath: String,
      buildContext: Function,
    },
    setup() {
      const open = refVue(false)
      return () => hVue('div', [
        hVue('button', { class: 'ai-dock-rail-btn', onClick: () => { open.value = !open.value } }),
        open.value ? hVue('div', { class: 'ai-cli-empty' }, 'No workspace available') : null,
      ])
    },
  })
  return {
    ...actual,
    AiCliDock: aiDockStub,
  }
})

vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
  useTheme: () => ({ theme: ref('dark'), setTheme: vi.fn(), loadTheme: vi.fn() }),
  BUILTIN_THEMES: [],
}))

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  initKeybindingsPort: vi.fn(),
  useKeybindings: vi.fn(),
  registerCommand: vi.fn(),
  setContext: vi.fn(),
  executeCommand: vi.fn(),
}))

async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(EditorWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

async function open(wrapper: VueWrapper, filepath: string): Promise<void> {
  wrapper.findComponent({ name: 'ExplorerPane' }).vm.$emit('open-file', { filepath })
  await flushPromises()
}

function previewToggle(wrapper: VueWrapper) {
  return wrapper.find('.ide-tab-act--preview-toggle')
}

describe('EditorWindowApp – preview routing', () => {
  it('auto-opens media files in FilePreviewPane instead of EditorPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'assets/photo.png')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
    expect(previewToggle(wrapper).text()).toBe('Raw')
  })

  it('auto-opens known-binary files in FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'bundle/archive.zip')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
  })

  it('switches a media file back to the raw editor via the toggle', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'clip.mp4')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
    expect(previewToggle(wrapper).text()).toBe('Preview')
  })

  it('opens plain markdown raw with a Preview toggle that mounts PlanFileView', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'docs/notes.md')
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
    const toggle = previewToggle(wrapper)
    expect(toggle.text()).toBe('Preview')

    await toggle.trigger('click')
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)

    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
  })

  it('opens .html raw with a Preview toggle that mounts FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'site/index.html')
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    const toggle = previewToggle(wrapper)
    expect(toggle.text()).toBe('Preview')

    await toggle.trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(false)

    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
  })

  it('auto-opens font files in FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'fonts/custom.ttf')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
    expect(previewToggle(wrapper).text()).toBe('Raw')
  })

  it('auto-opens new media formats (.mkv) in FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'movies/clip.mkv')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
  })

  it('auto-opens Jupyter notebooks (.ipynb) in FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'nb/analysis.ipynb')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
    expect(previewToggle(wrapper).text()).toBe('Raw')
  })

  it('auto-opens Office documents (.docx/.xlsx) in FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'docs/report.docx')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)

    await open(wrapper, 'docs/data.xlsx')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)
  })

  it('opens .csv raw with a Preview toggle that mounts FilePreviewPane', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'data/table.csv')
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    const toggle = previewToggle(wrapper)
    expect(toggle.text()).toBe('Preview')

    await toggle.trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(false)

    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
  })

  it('keeps .plan.md routing to PlanFileView with no preview toggle', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'plans/feature.plan.md')
    expect(wrapper.findComponent({ name: 'PlanFileView' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(previewToggle(wrapper).exists()).toBe(false)
    expect(wrapper.find('.ide-tab-act--plan-toggle').text()).toBe('Raw')
  })

  it('previews .agent-team plan HTML as plain HTML without the review toolbar', async () => {
    const wrapper = await mountApp()
    await open(wrapper, '.agent-team/plans/feature_a1b2c3.html')
    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
  })

  it('keeps plain and infrastructure HTML previews toolbar-free', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'site/index.html')
    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)

    await open(wrapper, '.agent-team/plans/_template.html')
    await previewToggle(wrapper).trigger('click')
    expect(wrapper.findComponent({ name: 'PlanReviewToolbar' }).exists()).toBe(false)
  })

  it('opens text files in EditorPane with no preview toggle', async () => {
    const wrapper = await mountApp()
    await open(wrapper, 'src/main.ts')
    expect(wrapper.findComponent({ name: 'EditorPane' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FilePreviewPane' }).exists()).toBe(false)
    expect(previewToggle(wrapper).exists()).toBe(false)
  })

  it('hosts the shared AI CLI dock with the editor width key and context builder', async () => {
    const wrapper = await mountApp()
    // The shared shell (AiCliDock) owns the rail/resize/terminal lifecycle.
    // Here: the editor wires its (carried-over) width key, a per-workspace
    // pane id, the mini-ide origin tag and its context builder.
    const dock = wrapper.findComponent({ name: 'AiCliDock' })
    expect(dock.exists()).toBe(true)
    expect(dock.props('widthKey')).toBe('ide-ai-panel-width')
    expect(dock.props('origin')).toBe('mini-ide')
    expect(String(dock.props('paneId'))).toMatch(/^[0-9a-f]{8}-editor-ai-terminal$/)
    expect(typeof dock.props('buildContext')).toBe('function')

    // No workspace in this harness (no ?workspace_path=) — the terminal must
    // not mount, and toggling the rail shows the panel with its empty state.
    expect(wrapper.findComponent({ name: 'AiCliTerminal' }).exists()).toBe(false)
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ai-cli-empty').text()).toBe('No workspace available')
  })
})
