// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import {
  seedSettings,
  settingsGet,
} from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

// Stub useRepoDiscovery so we can control the repositories list.
const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number; error?: string } }[]>([])

import MultiRepoGit from '../MultiRepoGit.vue'

// Stub vue-i18n.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))

// MultiRepoGit only needs the confirmation affordance from the foundation;
// loading the real module would require a full i18n instance.
vi.mock('@navide/plugin-ui/foundation', () => ({
  vTruncate: {},
  useNotify: () => ({ confirm: vi.fn(async () => true), toast: vi.fn(), alert: vi.fn() }),
}))

// MultiRepoGit owns the lazy composition boundary; the repo-tab tests do not
// need to load GitPane's transport, menus, or terminal graph. Keeping that
// boundary mocked also prevents an async child import from outliving a test
// environment when the full suite runs in parallel.
vi.mock('../GitPane.vue', () => ({
  default: {
    name: 'GitPane',
    setup: () => () => null,
  },
}))

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0) {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

/** Composition seam for the read-only project.json compatibility seed. */
function makeLegacyRepoSelection(value: string | null = null) {
  const read = vi.fn(async () => value)
  return { legacyRepoSelection: { readLegacyRepoSelection: read }, read }
}

const stubLegacyRepoSelection = makeLegacyRepoSelection().legacyRepoSelection
const stubSurfacePorts = {
  gitTransport: {
    status: { value: 'connected' },
    send: vi.fn(),
    on: vi.fn(() => () => {}),
  },
} as never

beforeEach(() => {
  mockRepositories.value = []
  __resetSettingsForTest()
  try { localStorage.clear() } catch { /* ignore */ }
})

const mountedWrappers: Array<{ unmount: () => void }> = []

function mountMultiRepo(options: Parameters<typeof shallowMount>[1]) {
  const wrapper = shallowMount(MultiRepoGit, options)
  mountedWrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
})

describe('MultiRepoGit – single-repo passthrough', () => {
  it('renders a single GitPane stub and no tab bar when 0 repos discovered', () => {
    mockRepositories.value = []
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(false)
    // Shallow stub renders as <git-pane-stub> (or similar).
    expect(wrapper.findComponent({ name: 'GitPane' }).exists() ||
           wrapper.find('[class]').exists() ||
           wrapper.html().includes('git-pane')).toBeTruthy()
  })

  it('renders no tab bar when only 1 repo discovered', () => {
    mockRepositories.value = [makeRepo('.', '/ws', 'main')]
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
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
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    expect(wrapper.find('.repo-tab-bar').exists()).toBe(true)
    expect(wrapper.findAll('.repo-tab')).toHaveLength(2)
  })

  it('first tab is active by default', () => {
    mockRepositories.value = [
      makeRepo('.', '/ws', 'main'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
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
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
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
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
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
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
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
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection: stubLegacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    const firstTabName = wrapper.findAll('.repo-tab-name')[0].text()
    // Our stub t() returns the key itself.
    expect(firstTabName).toBe('label.git-repo-root')
  })
})

describe('MultiRepoGit – workspace Plugin Storage selection', () => {
  const TWO_REPOS = [
    makeRepo('.', '/ws', 'main'),
    makeRepo('sub', '/ws/sub', 'dev'),
  ]

  it('restores the workspace-scoped Plugin Storage selection', async () => {
    mockRepositories.value = TWO_REPOS
    seedSettings({ 'agentTeam.gitTabRepo': '/ws/sub' })
    const { legacyRepoSelection, read } = makeLegacyRepoSelection('/ws')
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    await flushPromises()
    const tabs = wrapper.findAll('.repo-tab')
    expect(tabs[1].classes()).toContain('active')
    expect(read).not.toHaveBeenCalled()
  })

  it('clicking a tab persists only the workspace Plugin Storage key', async () => {
    mockRepositories.value = TWO_REPOS
    const { legacyRepoSelection, read } = makeLegacyRepoSelection()
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    await flushPromises()
    await wrapper.findAll('.repo-tab')[1].trigger('click')
    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws/sub')
    expect(read).toHaveBeenCalledWith()
  })

  it('uses the legacy project field as a read-only seed', async () => {
    mockRepositories.value = TWO_REPOS
    const { legacyRepoSelection, read } = makeLegacyRepoSelection('/ws/sub')
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    await flushPromises()
    expect(wrapper.findAll('.repo-tab')[1].classes()).toContain('active')
    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws/sub')
    expect(read).toHaveBeenCalledWith()
  })

  it('uses a legacy localStorage seed without deleting or rewriting it', async () => {
    localStorage.setItem('agentTeam.gitTabRepo./ws', '/ws/sub')
    mockRepositories.value = TWO_REPOS
    const { legacyRepoSelection, read } = makeLegacyRepoSelection()
    mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    await flushPromises()
    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws/sub')
    expect(localStorage.getItem('agentTeam.gitTabRepo./ws')).toBe('/ws/sub')
    expect(read).toHaveBeenCalledWith()
  })

  it('keeps the legacy seed frozen after a later Plugin Storage selection', async () => {
    localStorage.setItem('agentTeam.gitTabRepo./ws', '/ws')
    mockRepositories.value = TWO_REPOS
    const { legacyRepoSelection } = makeLegacyRepoSelection()
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    await flushPromises()
    await wrapper.findAll('.repo-tab')[1].trigger('click')

    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws/sub')
    expect(localStorage.getItem('agentTeam.gitTabRepo./ws')).toBe('/ws')
  })

  it('does not let a late read-only legacy seed override a user click', async () => {
    mockRepositories.value = TWO_REPOS
    let resolveSeed: (v: string | null) => void = () => {}
    const legacyRepoSelection = { readLegacyRepoSelection: vi.fn(() => new Promise<string | null>((r) => { resolveSeed = r })) }
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })
    // User picks the root tab while the restore is still in flight.
    await wrapper.findAll('.repo-tab')[0].trigger('click')
    resolveSeed('/ws/sub')
    await flushPromises()
    expect(wrapper.findAll('.repo-tab')[0].classes()).toContain('active')
    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws')
  })

  it('does not let a legacy seed overwrite a Plugin Storage value arriving during the read', async () => {
    mockRepositories.value = TWO_REPOS
    let resolveSeed: (v: string | null) => void = () => {}
    const legacyRepoSelection = { readLegacyRepoSelection: vi.fn(() => new Promise<string | null>((resolve) => { resolveSeed = resolve })) }
    const wrapper = mountMultiRepo({
      props: { workspacePath: '/ws', legacyRepoSelection, surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    })

    seedSettings({ 'agentTeam.gitTabRepo': '/ws/sub' })
    resolveSeed('/ws')
    await flushPromises()

    expect(wrapper.findAll('.repo-tab')[1].classes()).toContain('active')
    expect(settingsGet('agentTeam.gitTabRepo', null)).toBe('/ws/sub')
  })
})
