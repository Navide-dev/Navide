// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import MultiRepoGit from '../MultiRepoGit.vue'

// Stub useRepoDiscovery so we can control the repositories list.
const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number; error?: string } }[]>([])

vi.mock('../../composables/useRepoDiscovery', () => ({
  useRepoDiscovery: () => ({ repositories: mockRepositories, refresh: vi.fn(), adopt: vi.fn() }),
}))

// Stub vue-i18n.
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (k: string) => k }),
}))

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0) {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

/** Backend stub: project.peek returns the given project snapshot (null = no
 *  project.json yet); everything else acks with { ok: true }. */
function makeBackend(project: { ui_git_tab_repo?: string } | null = null) {
  const send = vi.fn(async (type: string) => {
    if (type === 'project.peek') return { ok: true, payload: { project } }
    return { ok: true, payload: { ok: true } }
  })
  return { backend: { send } as never, send }
}

const stubBackend = makeBackend().backend
const stubSurfacePorts = {} as never

beforeEach(() => {
  mockRepositories.value = []
  try { localStorage.clear() } catch { /* ignore */ }
})

describe('MultiRepoGit – single-repo passthrough', () => {
  it('renders a single GitPane stub and no tab bar when 0 repos discovered', () => {
    mockRepositories.value = []
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
    // Shallow stub renders as <git-pane-stub> (or similar).
    expect(wrapper.findComponent({ name: 'GitPane' }).exists() ||
           wrapper.find('[class]').exists() ||
           wrapper.html().includes('git-pane')).toBeTruthy()
  })

  it('renders no tab bar when only 1 repo discovered', () => {
    mockRepositories.value = [makeRepo('.', '/ws', 'main')]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
  })
})

describe('MultiRepoGit – multi-repo tab bar', () => {
  it('renders tab bar with 2 tabs when 2 repos discovered', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 2),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)
    expect(wrapper.findAll('.repo-tab')).toHaveLength(2)
  })

  it('first tab is active by default', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    const tabs = wrapper.findAll('.repo-tab')
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
  })

  it('shows dirty count badge on tab when dirtyCount > 0', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main', 5),
      makeRepo('sub', '/ws/sub', 'dev', 0),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    const firstTab = wrapper.findAll('.repo-tab')[0]
    expect(firstTab.find('.repo-tab-badge').exists()).toBe(true)
    expect(firstTab.find('.repo-tab-badge').text()).toBe('5')

    const secondTab = wrapper.findAll('.repo-tab')[1]
    expect(secondTab.find('.repo-tab-badge').exists()).toBe(false)
  })

  it('marks a tab whose status read failed', () => {
    mockRepositories.value = [
      { ...makeRepo('.', '/ws', ''), badge: { branch: '', dirtyCount: 0, error: 'git timed out' } },
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    const badge = wrapper.find('.repo-tab-badge-error')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toBe('git timed out')
  })

  it('clicking a tab switches active state', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    const tabs = wrapper.findAll('.repo-tab')
    await tabs[1].trigger('click')
    expect(tabs[1].classes()).toContain('active')
    expect(tabs[0].classes()).not.toContain('active')
  })

  it('uses label.git-repo-root for rel_path "."', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('pkg', '/ws/pkg', 'dev'),
    ]
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: stubBackend, surfacePorts: stubSurfacePorts },
    })
    const firstTabName = wrapper.findAll('.repo-tab-name')[0].text()
    // Our stub t() returns the key itself.
    expect(firstTabName).toBe('label.git-repo-root')
  })
})

describe('MultiRepoGit – persisted repo tab (project.json ui_git_tab_repo)', () => {
  const TWO_REPOS = [
    makeRepo('.', '/ws', 'main'),
    makeRepo('sub', '/ws/sub', 'dev'),
  ]

  it('restores the backend-saved repo tab', async () => {
    mockRepositories.value = TWO_REPOS
    const { backend } = makeBackend({ ui_git_tab_repo: '/ws/sub' })
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend, surfacePorts: stubSurfacePorts },
    })
    await flushPromises()
    const tabs = wrapper.findAll('.repo-tab')
    expect(tabs[1].classes()).toContain('active')
  })

  it('clicking a tab persists the selection via project.set_ui_state', async () => {
    mockRepositories.value = TWO_REPOS
    const { backend, send } = makeBackend()
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend, surfacePorts: stubSurfacePorts },
    })
    await flushPromises()
    await wrapper.findAll('.repo-tab')[1].trigger('click')
    expect(send).toHaveBeenCalledWith('project.set_ui_state', {
      workspace_path: '/ws',
      git_tab_repo: '/ws/sub',
    })
  })

  it('migrates the legacy localStorage key once (ack-gated delete)', async () => {
    localStorage.setItem('agentTeam.gitTabRepo./ws', '/ws/sub')
    mockRepositories.value = TWO_REPOS
    const { backend, send } = makeBackend()
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend, surfacePorts: stubSurfacePorts },
    })
    await flushPromises()
    // Legacy value restored and pushed to the backend, local copy deleted after ack.
    expect(wrapper.findAll('.repo-tab')[1].classes()).toContain('active')
    expect(send).toHaveBeenCalledWith('project.set_ui_state', {
      workspace_path: '/ws',
      git_tab_repo: '/ws/sub',
    })
    expect(localStorage.getItem('agentTeam.gitTabRepo./ws')).toBeNull()
  })

  it('clears the stale legacy copy when the backend already owns a value', async () => {
    localStorage.setItem('agentTeam.gitTabRepo./ws', '/ws/stale')
    mockRepositories.value = TWO_REPOS
    const { backend, send } = makeBackend({ ui_git_tab_repo: '/ws/sub' })
    shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend, surfacePorts: stubSurfacePorts },
    })
    await flushPromises()
    expect(localStorage.getItem('agentTeam.gitTabRepo./ws')).toBeNull()
    expect(send).not.toHaveBeenCalledWith('project.set_ui_state', expect.anything())
  })

  it('a late restore does not override a user click', async () => {
    mockRepositories.value = TWO_REPOS
    let resolvePeek: (v: unknown) => void = () => {}
    const send = vi.fn((type: string) => {
      if (type === 'project.peek') return new Promise((r) => { resolvePeek = r })
      return Promise.resolve({ ok: true, payload: { ok: true } })
    })
    const wrapper = shallowMount(MultiRepoGit, {
      props: { workspacePath: '/ws', backend: { send } as never, surfacePorts: stubSurfacePorts },
    })
    // User picks the root tab while the restore is still in flight.
    await wrapper.findAll('.repo-tab')[0].trigger('click')
    resolvePeek({ ok: true, payload: { project: { ui_git_tab_repo: '/ws/sub' } } })
    await flushPromises()
    expect(wrapper.findAll('.repo-tab')[0].classes()).toContain('active')
  })
})
