// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, nextTick } from 'vue'

// Control the discovered repo list.
const mockRepositories = ref<{ rel_path: string; abs_path: string; branch: string; badge: { branch: string; dirtyCount: number } }[]>([])
const stubSurfacePorts = {
  gitTransport: {
    status: { value: 'connected' },
    send: vi.fn(),
    on: vi.fn(() => () => {}),
  },
} as never

import MultiRepoGit from '../MultiRepoGit.vue'
vi.mock('../../composables/useRepoDiscovery', () => ({
  useRepoDiscovery: () => ({ repositories: mockRepositories, discoveryFailed: { value: false }, refresh: vi.fn(), adopt: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))

vi.mock('@navide/plugin-ui/foundation', () => ({
  vTruncate: {},
  useNotify: () => ({ confirm: vi.fn(async () => true), toast: vi.fn(), alert: vi.fn() }),
}))

// Controllable GitPane stub: renders a marker carrying its workspacePath so a
// test can locate the pane for a given repo and drive its changes-count emit
// (the real per-repo count that MultiRepoGit accumulates). Supplied via
// global.stubs so the async GitPane import is replaced without module mocking.
const gitPaneStub = {
  name: 'GitPane',
  props: ['workspacePath'],
  emits: ['changes-count', 'open-file', 'open-conflict', 'open-diff', 'open-branch-diff'],
  template: '<div class="gitpane-stub" :data-ws="workspacePath"></div>',
}

function mountRepo() {
  return mount(MultiRepoGit, {
    props: { workspacePath: '/ws', legacyRepoSelection: makeLegacyRepoSelection(), surfacePorts: stubSurfacePorts, repositorySource: mockRepositories },
    global: { stubs: { GitPane: gitPaneStub } },
  })
}

function makeRepo(relPath: string, absPath: string, branch = 'main', dirtyCount = 0) {
  return { rel_path: relPath, abs_path: absPath, branch, badge: { branch, dirtyCount } }
}

function makeLegacyRepoSelection() {
  return { readLegacyRepoSelection: vi.fn(async () => null) }
}

function panes(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents({ name: 'GitPane' })
}

async function emitFor(wrapper: ReturnType<typeof mount>, ws: string, n: number) {
  const pane = panes(wrapper).find((c) => c.props('workspacePath') === ws)
  if (!pane) throw new Error(`GitPane for ${ws} not mounted`)
  pane.vm.$emit('changes-count', n)
  await nextTick()
}

/** Latest value emitted on `changes-count`, or undefined if never emitted. */
function lastCount(wrapper: ReturnType<typeof mount>): number | undefined {
  const ev = wrapper.emitted('changes-count') as unknown[][] | undefined
  if (!ev || ev.length === 0) return undefined
  return ev[ev.length - 1][0] as number
}

beforeEach(() => {
  mockRepositories.value = []
})

describe('MultiRepoGit – badge staleness fixes', () => {
  it('attaches the emitting repo workspace to forwarded Git actions', async () => {
    mockRepositories.value = [
      makeRepo('.', '/ws'),
      makeRepo('sub', '/ws/sub', 'dev'),
    ]
    const wrapper = mountRepo()
    await flushPromises()

    const rootPane = panes(wrapper).find((c) => c.props('workspacePath') === '/ws')
    expect(rootPane).toBeDefined()
    rootPane!.vm.$emit('open-file', { filepath: 'README.md', name: 'README.md' })
    expect(wrapper.emitted('open-file')).toEqual([[
      { workspace_path: '/ws', filepath: 'README.md', name: 'README.md' },
    ]])

    await wrapper.findAll('.repo-tab')[1].trigger('click')
    await flushPromises()
    const subPane = panes(wrapper).find((c) => c.props('workspacePath') === '/ws/sub')
    expect(subPane).toBeDefined()
    subPane!.vm.$emit('open-diff', {
      filepath: 'src/app.ts',
      staged: false,
      name: 'app.ts',
      commit: 'abc123',
    })
    expect(wrapper.emitted('open-diff')).toEqual([[
      {
        workspace_path: '/ws/sub',
        filepath: 'src/app.ts',
        staged: false,
        name: 'app.ts',
        commit: 'abc123',
      },
    ]])
  })

  it('prunes a departed repo count so the total drops the vanished repo', async () => {
    // Three repos → multi mode.
    mockRepositories.value = [
      makeRepo('.', '/ws'),
      makeRepo('a', '/ws/a'),
      makeRepo('b', '/ws/b'),
    ]
    const wrapper = mountRepo()
    await flushPromises()

    // Root tab active by default → its pane is mounted; report 5 changes.
    await emitFor(wrapper, '/ws', 5)

    // Visit tab a and b so their panes mount, then report their counts.
    const tabs = wrapper.findAll('.repo-tab')
    await tabs[1].trigger('click')
    await flushPromises()
    await emitFor(wrapper, '/ws/a', 3)
    await tabs[2].trigger('click')
    await flushPromises()
    await emitFor(wrapper, '/ws/b', 2)

    // Total = 5 + 3 + 2 = 10.
    expect(lastCount(wrapper)).toBe(10)

    // Repo b leaves the workspace (still multi: 2 repos remain).
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    await flushPromises()

    // Without the prune watcher this would stay 10 (b's 2 lingering).
    expect(lastCount(wrapper)).toBe(8)
  })

  it('re-emits on multi→single flip instead of freezing the old total', async () => {
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    const wrapper = mountRepo()
    await flushPromises()

    // Multi total = 4.
    await emitFor(wrapper, '/ws', 4)
    expect(lastCount(wrapper)).toBe(4)

    // Drop to a single repo → mode flips to single.
    mockRepositories.value = [makeRepo('.', '/ws')]
    await flushPromises()

    // The flip watcher re-emits the single-mode count (0); the badge must not
    // stay frozen on the stale multi total of 4.
    expect(lastCount(wrapper)).toBe(0)
  })

  it('re-emits on single→multi flip', async () => {
    mockRepositories.value = [makeRepo('.', '/ws')]
    const wrapper = mountRepo()
    await flushPromises()

    // Single mode reports 7 (forwarded straight through).
    await emitFor(wrapper, '/ws', 7)
    expect(lastCount(wrapper)).toBe(7)

    // Grow to two repos → mode flips to multi; freshly mounted panes have not
    // reported yet, so the total is 0 — and the badge must reflect that, not 7.
    mockRepositories.value = [makeRepo('.', '/ws'), makeRepo('a', '/ws/a')]
    await flushPromises()

    expect(lastCount(wrapper)).toBe(0)
  })
})
