// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

import MultiRepoGit from '../MultiRepoGit.vue'

type Repo = {
  rel_path: string
  abs_path: string
  branch: string
  badge: { branch: string; dirtyCount: number }
}

const mockRepositories = ref<Repo[]>([])
const credentialPort = { getCredential: vi.fn() }

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

// Keep the legacy composition test at the MultiRepoGit → GitPane seam. The
// credential prompt itself belongs to the legacy GitPane tests; this suite
// proves that rollback still supplies its credential adapter.
const gitPaneStub = {
  name: 'GitPane',
  props: ['workspacePath', 'credentials'],
  emits: ['changes-count'],
  template: '<div class="gitpane-stub" :data-ws="workspacePath"></div>',
}

vi.mock('../GitPane.vue', () => ({
  default: gitPaneStub,
}))

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0): Repo {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

function makeBackend() {
  const send = vi.fn(async (type: string) => {
    if (type === 'project.peek') return { ok: true, payload: { project: null } }
    return { ok: true, payload: { ok: true } }
  })
  return { send } as never
}

const surfacePorts = {
  gitTransport: {
    status: { value: 'connected' },
    send: vi.fn(),
    on: vi.fn(() => () => {}),
  },
  credentials: credentialPort,
} as never

const mountedWrappers: Array<{ unmount: () => void }> = []

function mountLegacy() {
  const wrapper = mount(MultiRepoGit, {
    props: {
      workspacePath: '/ws',
      backend: makeBackend(),
      surfacePorts,
      repositorySource: mockRepositories,
    },
    global: { stubs: { GitPane: gitPaneStub } },
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

function panes(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents({ name: 'GitPane' })
}

beforeEach(() => {
  mockRepositories.value = []
  credentialPort.getCredential.mockReset()
  try { localStorage.clear() } catch { /* ignore */ }
})

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
})

describe('legacy MultiRepoGit rollback composition', () => {
  it('preserves the credential prompt port in single-repo mode', async () => {
    mockRepositories.value = [makeRepo('.', '/ws')]
    const wrapper = mountLegacy()
    await flushPromises()

    expect(panes(wrapper)).toHaveLength(1)
    expect((panes(wrapper)[0].props('credentials') as typeof credentialPort).getCredential)
      .toBe(credentialPort.getCredential)
  })

  it('keeps tab switching, dirty badges, and credential forwarding in multi-repo mode', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 5),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = mountLegacy()
    await flushPromises()

    const tabs = wrapper.findAll('.repo-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].find('.repo-tab-badge').text()).toBe('5')
    const rootPane = panes(wrapper).find((pane) => pane.props('workspacePath') === '/ws')
    expect(rootPane).toBeDefined()
    expect((rootPane!.props('credentials') as typeof credentialPort).getCredential)
      .toBe(credentialPort.getCredential)

    await tabs[1].trigger('click')
    await flushPromises()

    expect(tabs[1].classes()).toContain('active')
    const subPane = panes(wrapper).find((pane) => pane.props('workspacePath') === '/ws/sub')
    expect(subPane).toBeDefined()
    expect((subPane!.props('credentials') as typeof credentialPort).getCredential)
      .toBe(credentialPort.getCredential)
  })

  it('forwards the aggregate changes count from legacy repo panes', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws'),
      makeRepo('sub', '/ws/sub'),
    ]
    const wrapper = mountLegacy()
    await flushPromises()

    const rootPane = panes(wrapper).find((pane) => pane.props('workspacePath') === '/ws')
    expect(rootPane).toBeDefined()
    rootPane!.vm.$emit('changes-count', 3)
    await nextTick()

    const events = wrapper.emitted('changes-count') as unknown[][] | undefined
    expect(events?.at(-1)?.[0]).toBe(3)
  })
})
