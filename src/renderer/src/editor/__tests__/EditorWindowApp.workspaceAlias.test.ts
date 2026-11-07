// @vitest-environment happy-dom
// The mini-IDE window's workspace name: the alias the user gave the workspace
// (resolved by the Host and handed over in `?workspace_display_name=`) wins
// over the folder name, in the titlebar and in the Explorer header it owns.
// Keeps its own harness rather than widening the preview-routing one.
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

// ExplorerPane declares the prop under test so it can be read back off the
// stub; every other child pane is irrelevant here.
vi.mock('../../components/ExplorerPane.vue', () => stub('ExplorerPane', ['workspacePath', 'workspaceDisplayName']))
vi.mock('../../components/SearchPane.vue', () => stub('SearchPane'))
vi.mock('../../components/ProblemsPane.vue', () => stub('ProblemsPane'))
vi.mock('../../components/NotificationHost.vue', () => stub('NotificationHost'))
vi.mock('../EditorPane.vue', () => stub('EditorPane'))
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

vi.mock('@navide/plugin-shell', async (importOriginal) => {
  const { defineComponent: makeComponent, h: hVue } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/plugin-shell')>()
  return {
    ...actual,
    AiCliDock: makeComponent({
      name: 'AiCliDock',
      props: { widthKey: String, origin: String, paneId: String, workspacePath: String, buildContext: Function },
      render: () => hVue('div', { class: 'stub-AiCliDock' }),
    }),
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
  initSettingsBackend: vi.fn(),
  settingsGet: vi.fn((_key: string, def: unknown) => def),
  settingsSet: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {}),
}))

async function mountApp(search: string): Promise<VueWrapper> {
  window.history.replaceState({}, '', search)
  const wrapper = mount(EditorWindowApp, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const WS = '%2FUsers%2Fdev%2Fprojects%2Fagent-team'

describe('EditorWindowApp – workspace display name', () => {
  it('titles the window with the alias the Host resolved, padding trimmed', async () => {
    const wrapper = await mountApp(`/?workspace_path=${WS}&workspace_display_name=%20%20Navide%20%20`)
    expect(wrapper.get('.ide-titlebar-name').text()).toBe('Navide')
    wrapper.unmount()
  })

  it('hands the same name down to the Explorer header it owns', async () => {
    const wrapper = await mountApp(`/?workspace_path=${WS}&workspace_display_name=Navide`)
    const explorer = wrapper.findComponent({ name: 'ExplorerPane' })
    expect(explorer.props('workspaceDisplayName')).toBe('Navide')
    // The path stays the identity, alias or no alias.
    expect(explorer.props('workspacePath')).toBe('/Users/dev/projects/agent-team')
    wrapper.unmount()
  })

  it('falls back to the folder name when the alias is absent or blank', async () => {
    for (const search of [
      `/?workspace_path=${WS}`,
      `/?workspace_path=${WS}&workspace_display_name=`,
      `/?workspace_path=${WS}&workspace_display_name=%20%20`,
    ]) {
      const wrapper = await mountApp(search)
      expect(wrapper.get('.ide-titlebar-name').text(), search).toBe('agent-team')
      expect(
        wrapper.findComponent({ name: 'ExplorerPane' }).props('workspaceDisplayName'),
        search,
      ).toBe('agent-team')
      wrapper.unmount()
    }
  })
})
