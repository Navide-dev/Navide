// @vitest-environment happy-dom
// GitWindowApp (the navide.git standalone window) — wiring tests for the
// "Editorial Calm" design: the checkbox-IS-the-stage-state file card, the
// commit composer, conflict quick-resolution, the sidebar "⋯" popover menus
// (branches / stashes / worktrees / remotes), and the diff detail. The backend
// is composed with the same Host adapters as the production renderer, so every
// assertion is on the real useGit → GitTransport wire format.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { extractDropPaths, shellEscape } from '../../lib/drop'
import { aiTerminalPaneId } from '@navide/plugin-shell'
import { i18n } from '@navide/plugin-ui/foundation'

// Control surface for the stubbed CLI terminal: tests seed the PTY state the
// dock sees at mount and read back what "Resolve with Agent" pasted into it.
const term = vi.hoisted(() => ({
  /** Seeds the stub's status ref at mount ('running' = a live CLI). */
  status: 'idle',
  /** Seeds lastRawActivityAt; a past timestamp means "the CLI is quiet". */
  lastRawActivityAt: 0,
  /** Everything pasted into the PTY, in order. */
  pastes: [] as string[],
  spawnCalls: 0,
  /** Whether spawn() lands in 'running' (false = the CLI failed to start). */
  spawnRuns: true
}))

// The CLI dock's terminal host pulls in useTerminal/xterm — stub it with the
// imperative surface the dock drives (reattach/fit are called on first open).
vi.mock('@navide/terminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: () => {
      const status = ref(term.status)
      return {
        mount: vi.fn(),
        updateXtermTheme: vi.fn(),
        spawn: vi.fn(async () => {
          term.spawnCalls++
          if (term.spawnRuns) status.value = 'running'
        }),
        tryReattach: vi.fn(async () => undefined),
        // Returns true like the real one, which reports whether the write left.
        pasteText: vi.fn((text: string) => {
          term.pastes.push(text)
          return true
        }),
        interrupt: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined),
        cancelPendingCreate: vi.fn(async () => undefined),
        fitTerminal: vi.fn(),
        focus: vi.fn(),
        status,
        displayStatus: ref('idle'),
        lastRawActivityAt: ref(term.lastRawActivityAt),
        sessionId: ref(''),
        error: ref('')
      }
    }
  }
})

interface SentCall {
  type: string
  payload: Record<string, unknown>
}

const sends = vi.hoisted(() => ({ calls: [] as { type: string; payload: Record<string, unknown> }[] }))

// Per-test override for the git.status payload.
const statusOverride = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))

function baseStatus(): Record<string, unknown> {
  return {
    is_git_repo: true,
    branch: 'main',
    remote_branch: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: [{ path: 'src/staged.ts', status: 'M' }],
    unstaged: [{ path: 'src/a.ts', status: 'M' }],
    untracked: [{ path: 'src/new.ts', status: '?' }],
    ignored: [],
    operation_in_progress: ''
  }
}

// Per-test override for git.clean's dry run (the file list the confirmation
// dialog enumerates). The real delete pass echoes the same list back.
const cleanFiles = vi.hoisted(() => ({ value: [] as string[] }))

// Per-test override for fs.read_file (the conflicted file "Resolve with
// agent" quotes into its prompt).
const fileRead = vi.hoisted(() => ({ ok: true, content: '', error: '' }))

vi.mock('../../composables/useBackend', () => {
  function payloadFor(type: string, payload: Record<string, unknown>): unknown {
    if (type === 'git.status') return statusOverride.value ?? baseStatus()
    if (type === 'git.clean') return { ok: true, files: cleanFiles.value, dry_run: payload.dry_run }
    if (type === 'git.blame')
      return {
        ok: true,
        lines: [
          { short_hash: 'abc1234', author: 'neillu', date: '2026-08-01', line_no: 1, content: 'const a = 1' }
        ]
      }
    if (type === 'git.diff_blame')
      return {
        ok: true,
        hunks: [
          {
            header: '@@ -1,2 +1,3 @@',
            lines: [
              { kind: '+', old_no: null, new_no: 2, text: 'added', author: '', date: '', committed: false },
              { kind: '-', old_no: 2, new_no: null, text: 'removed', author: 'neillu', date: '2026-08-01', committed: true }
            ]
          }
        ]
      }
    if (type === 'git.file_log')
      return {
        ok: true,
        commits: [
          { hash: 'aaaaaaaaaaaa', short_hash: 'aaaaaaa', message: 'touch a.ts', branches: [], parents: [], author: 'neillu', date: '2026-08-01' }
        ]
      }
    if (type === 'git.commit_file_diff')
      return {
        ok: true,
        hunks: [
          {
            header: '@@ -1 +1 @@',
            lines: [{ kind: '+', old_no: null, new_no: 1, text: 'hello', author: 'neillu', date: '2026-08-01', committed: true }]
          }
        ]
      }
    if (type === 'git.init') return { ok: true, gitignore_created: true }
    if (type === 'git.clone') return { ok: true, path: '/tmp/cloned' }
    if (type === 'git.ignore') return { ok: true, target_file: '.gitignore', untracked: [] }
    if (type === 'git.branches')
      return {
        ok: true,
        branches: [
          { name: 'main', is_current: true, is_remote: false, tracking: 'origin/main' },
          { name: 'feature-x', is_current: false, is_remote: false, tracking: '' },
          { name: 'origin/feature-y', is_current: false, is_remote: true, tracking: '' }
        ]
      }
    if (type === 'git.log') return { ok: true, commits: [] }
    if (type === 'git.stash_list')
      return { ok: true, stashes: [{ index: 0, ref: 'stash@{0}', message: 'wip sidebar' }] }
    if (type === 'git.remotes')
      return { ok: true, remotes: [{ name: 'origin', fetch_url: 'https://example.com/r.git', push_url: 'https://example.com/r.git' }] }
    if (type === 'git.tags') return { ok: true, tags: [] }
    if (type === 'git.worktrees')
      return {
        ok: true,
        worktrees: [
          {
            path: '/tmp/ws', head: 'abc1234', branch: 'main', is_main: true,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          },
          {
            path: '/tmp/wt-feature', head: 'def5678', branch: 'feature-x', is_main: false,
            detached: false, bare: false, locked: false, lock_reason: '',
            prunable: false, prune_reason: ''
          }
        ]
      }
    if (type === 'ui.pick_folder') return { ok: true, path: '/tmp/picked' }
    if (type === 'issues.provider')
      return { ok: true, provider: 'github', cli_available: true, authenticated: true }
    if (type === 'issues.list')
      return {
        ok: true,
        provider: 'github',
        issues: [
          {
            number: 7, title: 'Sidebar parity', state: 'open', author: 'neillu',
            labels: [], assignees: [], updated_at: '', url: 'https://example.com/issues/7'
          }
        ]
      }
    if (type === 'git.config_get')
      return { ok: true, config: { 'user.name': 'neillu' }, allowed_keys: ['user.name', 'user.email'] }
    if (type === 'ui.settings.get') return { ok: true, settings: {} }
    if (type === 'fs.read_file')
      return fileRead.ok
        ? { ok: true, content: fileRead.content }
        : { ok: false, error: fileRead.error }
    return { ok: true }
  }
  return {
    useBackend: () => ({
      status: ref('connected'),
      wsUrl: ref(''),
      httpUrl: ref(''),
      shell: ref(''),
      port: ref(0),
      pid: ref(0),
      lastError: ref(''),
      send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
        sends.calls.push({ type, payload })
        return {
          id: 'r',
          type,
          ok: true,
          payload: payloadFor(type, payload),
          error: null,
          timestamp: new Date().toISOString()
        }
      }),
      on: vi.fn(() => () => {}),
      restart: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    })
  }
})

import GitWindowApp from '../../GitWindowApp.vue'
import { useNotify } from '@navide/plugin-ui/foundation'
import { useBackend } from '../../composables/useBackend'
import { createHostGitTransport } from '../../composables/hostGitTransport'
import { createHostGitSurfacePorts, createHostTerminalDockPort } from '../../composables/hostSurfacePorts'
import {
  GIT_BRANCH_DIFF_KEY,
  GIT_ACCOUNTS_KEY,
  GIT_CREDENTIALS_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from '../../ports/gitSurface'
import { TERMINAL_DOCK_KEY } from '@navide/terminal'

// notify.confirm resolves through the (stubbed-out) NotificationHost, so tests
// answer the dialog directly on the shared useNotify singleton.
const notify = useNotify()

function dialogMessage(): string {
  const d = notify.dialog.value
  expect(d, 'a confirmation dialog is open').toBeTruthy()
  return d!.message
}
async function answerDialog(ok: boolean): Promise<void> {
  expect(notify.dialog.value, 'a dialog is open').toBeTruthy()
  notify.resolveDialog(ok)
  await flushPromises()
}

// Every assertion below matches the English copy, so pin the locale instead of
// letting it fall out of navigator.language / the settings cache.
i18n.global.locale.value = 'en-US'

const STUBS = {
  GitHistoryModal: true,
  GitCredentialModal: true,
  NotificationHost: true,
  DiffPane: true,
  BranchDiffPane: true
}

function callsOf(type: string): SentCall[] {
  return sends.calls.filter((c) => c.type === type)
}

type DragStub = Event & {
  dataTransfer: { setData: ReturnType<typeof vi.fn>; effectAllowed: string }
}

function rowFor(w: VueWrapper, file: string): DOMWrapper<Element> {
  const row = w.findAll('.frow').find((r) => r.text().includes(file))
  expect(row, file).toBeDefined()
  return row!
}

function dispatchDragStart(row: DOMWrapper<Element>): DragStub {
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.assign(ev, {
    dataTransfer: { types: [], getData: () => '', setData: vi.fn(), effectAllowed: '' }
  })
  row.element.dispatchEvent(ev)
  return ev as DragStub
}

function textPlainPayload(ev: DragStub): string | undefined {
  const call = ev.dataTransfer.setData.mock.calls.find(([type]) => type === 'text/plain')
  return call?.[1] as string | undefined
}

async function mountApp(workspacePath = '/tmp/ws', workspaceDisplayName = ''): Promise<VueWrapper> {
  window.history.replaceState(
    {},
    '',
    `/?workspace_path=${encodeURIComponent(workspacePath)}` +
      (workspaceDisplayName ? `&workspace_display_name=${encodeURIComponent(workspaceDisplayName)}` : ''),
  )
  const backend = useBackend()
  const gitTransport = createHostGitTransport(backend)
  const surfacePorts = createHostGitSurfacePorts(backend, gitTransport)
  const terminalPort = createHostTerminalDockPort(backend)
  const wrapper = mount(GitWindowApp, {
    global: {
      stubs: STUBS,
      plugins: [i18n],
      provide: {
        [GIT_TRANSPORT_KEY as symbol]: gitTransport,
        [GIT_FILE_ACCESS_KEY as symbol]: surfacePorts.fileAccess,
        [GIT_UI_KEY as symbol]: surfacePorts.ui,
        [GIT_BRANCH_DIFF_KEY as symbol]: surfacePorts.branchDiff,
        [GIT_CREDENTIALS_KEY as symbol]: surfacePorts.credentials,
        [GIT_ACCOUNTS_KEY as symbol]: surfacePorts.accounts,
        [GIT_ISSUES_KEY as symbol]: surfacePorts.issues,
        [TERMINAL_DOCK_KEY as symbol]: terminalPort,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('GitWindowApp — Editorial Calm wiring', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sends.calls.length = 0
    statusOverride.value = null
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('loads the repo surface on mount (status, log, branches, worktrees)', async () => {
    wrapper = await mountApp()
    for (const t of [
      'git.status',
      'git.log',
      'git.branches',
      'git.remotes',
      'git.tags',
      'git.stash_list',
      'git.worktrees'
    ]) {
      expect(callsOf(t).length, t).toBeGreaterThan(0)
    }
    expect(callsOf('git.status')[0]!.payload.workspace_path).toBe('/tmp/ws')
  })

  it('stages via the checkbox and unstages via the checked checkbox', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.frow')
    const unstagedRow = rows.find((r) => r.text().includes('a.ts'))
    await unstagedRow!.find('button.chk:not(.on)').trigger('click')
    await flushPromises()
    expect(callsOf('git.stage')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      files: ['src/a.ts']
    })

    const stagedRow = wrapper.findAll('.frow').find((r) => r.text().includes('staged.ts'))
    await stagedRow!.find('button.chk.on').trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('stages all and unstages all from the list header links', async () => {
    wrapper = await mountApp()
    const stageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Stage All')
    await stageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.stage_all').length).toBe(1)

    const unstageAll = wrapper.findAll('.hdr-actions .linkbtn').find((b) => b.text() === 'Unstage All')
    await unstageAll!.trigger('click')
    await flushPromises()
    expect(callsOf('git.unstage')[0]!.payload).toMatchObject({ files: ['src/staged.ts'] })
  })

  it('commits the staged files with the composed message', async () => {
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('feat: editorial calm')
    const btn = wrapper.find('button.commitbtn')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(callsOf('git.commit')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      message: 'feat: editorial calm'
    })
  })

  it('disables commit when nothing is staged and no operation is in progress', async () => {
    statusOverride.value = { ...baseStatus(), staged: [] }
    wrapper = await mountApp()
    await wrapper.find('textarea.cmp-input').setValue('msg')
    expect(wrapper.find('button.commitbtn').attributes('disabled')).toBeDefined()
  })

  it('shows the operation banner and conflict quick-resolution during a merge', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    expect(wrapper.find('.op-banner').text()).toContain('merge in progress')
    const conflictRow = wrapper.find('.frow.conflict')
    expect(conflictRow.exists()).toBe(true)
    const ours = conflictRow.findAll('button.linkbtn').find((b) => b.text() === 'ours')
    await ours!.trigger('click')
    await flushPromises()
    expect(callsOf('git.resolve_ours')[0]!.payload).toMatchObject({ filepath: 'src/conflict.ts' })
  })

  it('makes every file row draggable with its absolute path as text/plain', async () => {
    wrapper = await mountApp()
    for (const [file, expected] of [
      ['staged.ts', '/tmp/ws/src/staged.ts'],
      ['a.ts', '/tmp/ws/src/a.ts'],
      ['new.ts', '/tmp/ws/src/new.ts']
    ] as const) {
      const row = rowFor(wrapper, file)
      expect(row.attributes('draggable'), file).toBe('true')
      const ev = dispatchDragStart(row)
      expect(textPlainPayload(ev), file).toBe(expected)
      expect(ev.dataTransfer.effectAllowed, file).toBe('copy')
    }
  })

  it('makes conflict rows draggable too', async () => {
    statusOverride.value = {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/conflict.ts', status: 'U' }]
    }
    wrapper = await mountApp()
    const row = wrapper.find('.frow.conflict')
    expect(row.attributes('draggable')).toBe('true')
    expect(textPlainPayload(dispatchDragStart(row))).toBe('/tmp/ws/src/conflict.ts')
  })

  it('normalizes a trailing slash in the workspace path and tolerates a missing dataTransfer', async () => {
    wrapper = await mountApp('/tmp/ws/')
    expect(textPlainPayload(dispatchDragStart(rowFor(wrapper, 'a.ts')))).toBe('/tmp/ws/src/a.ts')

    const bare = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.assign(bare, { dataTransfer: null })
    expect(() => rowFor(wrapper!, 'a.ts').element.dispatchEvent(bare)).not.toThrow()
  })

  it('emits a payload the terminal drop handler turns into a shell-escaped path', async () => {
    // The contract with the main window: GitWindowApp only sets text/plain, and
    // TerminalPane runs extractDropPaths → shellEscape → pasteText on it.
    wrapper = await mountApp()
    const payload = textPlainPayload(dispatchDragStart(rowFor(wrapper, 'a.ts')))

    const original = window.agentTeam
    window.agentTeam = { getPathForFile: () => '' } as unknown as typeof window.agentTeam
    try {
      const drop = {
        dataTransfer: {
          items: [],
          files: [],
          getData: (type: string) => (type === 'text/plain' ? payload : '')
        }
      } as unknown as DragEvent
      const paths = extractDropPaths(drop)
      expect(paths).toEqual(['/tmp/ws/src/a.ts'])
      expect(paths.map(shellEscape).join(' ')).toBe("'/tmp/ws/src/a.ts'")
    } finally {
      window.agentTeam = original
    }
  })

  it('shows a clicked file diff in the bottom DiffPane detail', async () => {
    wrapper = await mountApp()
    const row = wrapper.findAll('.frow').find((r) => r.text().includes('a.ts'))
    await row!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.detail').exists()).toBe(true)
    const diff = wrapper.findComponent({ name: 'DiffPane' })
    expect(diff.attributes('filepath')).toBe('src/a.ts')
  })

  it('hosts the shared AI CLI dock with this window\'s width key, pane id and context', async () => {
    wrapper = await mountApp()
    // The shared shell (AiCliDock) owns the rail/resize/eager-mount and the
    // CLI state machine — covered in depth by AiCliDock.test.ts. Here: it is
    // wired to this window's workspace, width key and per-workspace derived
    // pane id, and the terminal mounts eagerly (PTY ownership claim) while
    // the panel starts closed.
    const dock = wrapper.findComponent({ name: 'AiCliDock' })
    expect(dock.exists()).toBe(true)
    expect(dock.props('widthKey')).toBe('git-ai-panel-width')
    expect(dock.props('workspacePath')).toBe('/tmp/ws')
    expect(dock.props('paneId')).toBe(aiTerminalPaneId('git', '/tmp/ws'))
    expect(dock.props('origin')).toBe('git-window')
    expect(typeof dock.props('buildContext')).toBe('function')
    // The injected context reflects this window's git status snapshot.
    const context = (dock.props('buildContext') as () => string)()
    expect(context).toContain('Workspace: /tmp/ws')
    expect(context).toContain('Current branch: main')
    expect(context).toContain('src/staged.ts')
    const term = wrapper.findComponent({ name: 'AiCliTerminal' })
    expect(term.exists()).toBe(true)
    expect(term.props('workspacePath')).toBe('/tmp/ws')
    expect(term.props('paneId')).toBe(aiTerminalPaneId('git', '/tmp/ws'))
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')

    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await flushPromises()
    expect(panelEl.style.display).not.toBe('none')
  })

  it('switches branch only via the explicit ↵ button, never on row click', async () => {
    wrapper = await mountApp()
    const rows = wrapper.findAll('.branch-row')
    const feature = rows.find((r) => r.text().includes('feature-x'))
    await feature!.trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch').length).toBe(0)

    await feature!.find('button[title="Switch"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.switch_branch')[0]!.payload).toMatchObject({ name: 'feature-x' })

    // The current branch row offers no action buttons at all.
    const current = rows.find((r) => r.classes().includes('current'))
    expect(current!.find('button[title="Switch"]').exists()).toBe(false)
  })

  it('deletes a branch from its right-click context menu (GitPane style)', async () => {
    wrapper = await mountApp()
    const feature = wrapper.findAll('.branch-row').find((r) => r.text().includes('feature-x'))
    await feature!.trigger('contextmenu')
    const del = wrapper.findAll('.menu-item').find((m) => m.text().startsWith('Delete Branch'))
    expect(del).toBeTruthy()
  })

  it('drives stash actions from the Stashes card buttons', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Stashes'))
    await hdr!.trigger('click')
    await flushPromises()
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('wip sidebar'))
    await row!.find('button[title="Pop (Apply & Remove)"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.stash_pop').length).toBe(1)
  })

  it('drives worktree lock and reveal from the Worktrees card buttons', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Worktrees'))
    await hdr!.trigger('click')
    await flushPromises()
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('wt-feature'))
    await row!.find('button[title="Lock"]').trigger('click')
    await flushPromises()
    expect(callsOf('git.lock_worktree')[0]!.payload).toMatchObject({ worktree_path: '/tmp/wt-feature' })
    // Reveal goes through the preload bridge, NOT a WS type: the backend has
    // no `ui.reveal_path` handler, so sending it there resolved ok:false and
    // the reveal silently did nothing.
    const originalAgentTeam = window.agentTeam
    const revealPath = vi.fn(async () => ({ ok: true }))
    window.agentTeam = { revealPath } as unknown as typeof window.agentTeam
    try {
      await row!.find('button[title="Reveal in Finder"]').trigger('click')
      await flushPromises()
      expect(revealPath).toHaveBeenCalledWith('/tmp/wt-feature')
      expect(callsOf('ui.reveal_path')).toHaveLength(0)
    } finally {
      window.agentTeam = originalAgentTeam
    }
  })

  it('opens the remote URL through the ui.open_external host capability', async () => {
    wrapper = await mountApp()
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Remotes'))
    await hdr!.trigger('click')
    await flushPromises()
    await wrapper.find('button[title="Open Remote URL"]').trigger('click')
    await flushPromises()
    expect(callsOf('ui.open_external')[0]!.payload).toMatchObject({ url: 'https://example.com/r.git' })
  })

  it('lazy-loads the Issues card on expand and lists issues (GitPane parity)', async () => {
    wrapper = await mountApp()
    expect(callsOf('issues.provider').length).toBe(0)
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Issues'))
    await hdr!.trigger('click')
    await flushPromises()
    expect(callsOf('issues.provider').length).toBe(1)
    expect(callsOf('issues.list').length).toBe(1)
    const row = wrapper.findAll('.generic-row').find((r) => r.text().includes('#7'))
    expect(row).toBeTruthy()
  })

  it('loads git config on Config card expand and edits a key inline', async () => {
    wrapper = await mountApp()
    // useGit auto-loads config once at mount; expanding the card reloads it.
    const before = callsOf('git.config_get').length
    const hdr = wrapper.findAll('.card-hdr').find((h) => h.text().includes('Config'))
    await hdr!.trigger('click')
    await flushPromises()
    expect(callsOf('git.config_get').length).toBe(before + 1)
    const row = wrapper.findAll('.config-row').find((r) => r.text().includes('user.name'))
    await row!.find('.config-val').trigger('click')
    await row!.find('input.config-inline-input').setValue('newname')
    const save = row!.findAll('button').find((b) => b.text() === '✓')
    await save!.trigger('click')
    await flushPromises()
    expect(callsOf('git.config_set')[0]!.payload).toMatchObject({ key: 'user.name', value: 'newname' })
  })

  it('opens the branch-diff view with a sensible base/compare preselection', async () => {
    wrapper = await mountApp()
    const btn = wrapper.findAll('.navi button').find((b) => b.text() === 'Branch Diff')
    await btn!.trigger('click')
    await flushPromises()
    const selects = wrapper.findAll('select.ed-select')
    expect(selects.length).toBe(2)
    expect((selects[0]!.element as HTMLSelectElement).value).toBe('main')
  })
})

// ── The second wave: entries for backend/composable features that had no UI ──
describe('GitWindowApp — toolbar ⋯, detail modes, file menu, bootstrap', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sends.calls.length = 0
    statusOverride.value = null
    cleanFiles.value = []
    if (notify.dialog.value) notify.resolveDialog(false)
  })
  afterEach(() => {
    if (notify.dialog.value) notify.resolveDialog(false)
    wrapper?.unmount()
    wrapper = null
  })

  function menuItem(w: VueWrapper, label: string): DOMWrapper<Element> {
    const item = w.findAll('.menu-item').find((m) => m.text() === label)
    expect(item, label).toBeDefined()
    return item!
  }

  async function openToolbarMenu(w: VueWrapper): Promise<void> {
    await w.find('button.tb-more').trigger('click')
  }

  async function openFileMenu(w: VueWrapper, file: string): Promise<void> {
    await rowFor(w, file).trigger('contextmenu', { clientX: 40, clientY: 60 })
  }

  // ── 1. Toolbar ⋯ menu ──────────────────────────────────────────────────────
  it('runs pull --rebase and push --set-upstream from the toolbar ⋯ menu', async () => {
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Pull (Rebase)').trigger('click')
    await flushPromises()
    expect(callsOf('git.pull_rebase')[0]!.payload).toMatchObject({ workspace_path: '/tmp/ws' })

    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Push (Set Upstream)').trigger('click')
    await flushPromises()
    expect(callsOf('git.push_upstream')[0]!.payload).toMatchObject({
      branch: 'main',
      remote: 'origin'
    })
  })

  it('hides "Push (Set Upstream)" when the repo has no current branch', async () => {
    statusOverride.value = { ...baseStatus(), branch: '' }
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    const labels = wrapper.findAll('.menu-item').map((m) => m.text())
    expect(labels).toContain('Pull (Rebase)')
    expect(labels).not.toContain('Push (Set Upstream)')
  })

  it('force-pushes only after the destructive confirmation is accepted', async () => {
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Force Push…').trigger('click')
    await flushPromises()
    expect(dialogMessage()).toContain('cannot be undone')
    await answerDialog(false)
    expect(callsOf('git.push_force').length).toBe(0)

    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Force Push…').trigger('click')
    await flushPromises()
    await answerDialog(true)
    expect(callsOf('git.push_force').length).toBe(1)
  })

  it('undoes the last commit behind a confirmation', async () => {
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Undo Last Commit…').trigger('click')
    await flushPromises()
    expect(dialogMessage()).toContain('stay in your working tree')
    await answerDialog(true)
    expect(callsOf('git.undo_commit').length).toBe(1)
  })

  it('cleans untracked files in two stages: dry run → confirmation → delete', async () => {
    cleanFiles.value = Array.from({ length: 12 }, (_, i) => `junk/f${i}.log`)
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Clean Untracked Files…').trigger('click')
    await flushPromises()

    // Stage 1 is the dry run; nothing is deleted yet.
    const clean = callsOf('git.clean')
    expect(clean.length).toBe(1)
    expect(clean[0]!.payload).toMatchObject({ dry_run: true })

    // The confirmation enumerates the dry run's own list (capped at 10).
    const msg = dialogMessage()
    expect(msg).toContain('permanently deletes 12 untracked files')
    expect(msg).toContain('cannot be undone')
    expect(msg).toContain('junk/f0.log')
    expect(msg).toContain('junk/f9.log')
    expect(msg).not.toContain('junk/f10.log')
    expect(msg).toContain('…and 2 more')

    await answerDialog(true)
    const after = callsOf('git.clean')
    expect(after.length).toBe(2)
    expect(after[1]!.payload).toMatchObject({ dry_run: false })
  })

  it('never deletes when the clean confirmation is declined', async () => {
    cleanFiles.value = ['junk/a.log']
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Clean Untracked Files…').trigger('click')
    await flushPromises()
    await answerDialog(false)
    expect(callsOf('git.clean').length).toBe(1)
  })

  it('stops at the dry run when there is nothing to clean', async () => {
    cleanFiles.value = []
    wrapper = await mountApp()
    await openToolbarMenu(wrapper)
    await menuItem(wrapper, 'Clean Untracked Files…').trigger('click')
    await flushPromises()
    expect(callsOf('git.clean').length).toBe(1)
    expect(notify.dialog.value).toBeNull()
  })

  // ── 2. Detail modes ────────────────────────────────────────────────────────
  it('switches the detail between Diff, Blame and History', async () => {
    wrapper = await mountApp()
    await rowFor(wrapper, 'a.ts').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(true)

    const mode = (label: string): DOMWrapper<Element> =>
      wrapper!.findAll('.dt-modes button').find((b) => b.text() === label)!

    await mode('Blame').trigger('click')
    await flushPromises()
    expect(callsOf('git.blame')[0]!.payload).toMatchObject({ filepath: 'src/a.ts' })
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(false)
    expect(wrapper.find('.blame-row').text()).toContain('abc1234')

    // "Only changed lines" swaps blame for the diff-blame hunks.
    await wrapper.find('.detail-hdr input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(callsOf('git.diff_blame')[0]!.payload).toMatchObject({
      filepath: 'src/a.ts',
      staged: false
    })
    expect(wrapper.find('.db-hunk-head').text()).toBe('@@ -1,2 +1,3 @@')
    expect(wrapper.find('.db-line.db-add').text()).toContain('Uncommitted')

    await mode('History').trigger('click')
    await flushPromises()
    expect(callsOf('git.file_log')[0]!.payload).toMatchObject({ filepath: 'src/a.ts', n: 30 })
    const commitRow = wrapper.find('.hist-row')
    expect(commitRow.text()).toContain('touch a.ts')

    await commitRow.trigger('click')
    await flushPromises()
    expect(callsOf('git.commit_file_diff')[0]!.payload).toMatchObject({
      commit_hash: 'aaaaaaaaaaaa',
      filepath: 'src/a.ts'
    })
  })

  // ── 2b. Conflict mode: resolve the merge inside the Git window ─────────────
  function mergingStatus(): Record<string, unknown> {
    return {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/conflict.ts', status: 'U' }]
    }
  }
  const modeLabels = (w: VueWrapper): string[] =>
    w.findAll('.dt-modes button').map((b) => b.text())

  it('offers the Conflict mode on conflicted files only', async () => {
    statusOverride.value = mergingStatus()
    wrapper = await mountApp()

    // A plain modified file gets the three reading modes it always had.
    await rowFor(wrapper, 'a.ts').trigger('click')
    await flushPromises()
    expect(modeLabels(wrapper)).toEqual(['Diff', 'Blame', 'History'])
    expect(wrapper.findComponent({ name: 'ConflictPane' }).exists()).toBe(false)

    // The conflicted one gains a fourth, and opens straight into it.
    await wrapper.find('.frow.conflict').trigger('click')
    await flushPromises()
    expect(modeLabels(wrapper)).toEqual(['Diff', 'Blame', 'History', 'Conflict'])
    expect(wrapper.findAll('.dt-modes button.on').map((b) => b.text())).toEqual(['Conflict'])
  })

  it('mounts ConflictPane on the conflicted file with the composed ports', async () => {
    statusOverride.value = mergingStatus()
    wrapper = await mountApp()
    await wrapper.find('.frow.conflict').trigger('click')
    await flushPromises()

    const pane = wrapper.findComponent({ name: 'ConflictPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('filepath')).toBe('src/conflict.ts')
    expect(pane.props('workspacePath')).toBe('/tmp/ws')
    expect(pane.props('gitTransport')).toBeTruthy()
    expect(pane.props('fileAccess')).toBeTruthy()
    // The merge is live, so the panel is in service.
    expect(pane.props('mergeAborted')).toBe(false)
    // It reads the file and the index's three stages through named ports.
    expect(callsOf('fs.read_file').some((c) => c.payload.rel_path === 'src/conflict.ts')).toBe(true)
    expect(callsOf('git.conflict_stages')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      filepath: 'src/conflict.ts'
    })
  })

  it('takes the panel out of service once the file is no longer unmerged', async () => {
    statusOverride.value = mergingStatus()
    wrapper = await mountApp()
    await wrapper.find('.frow.conflict').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ConflictPane' }).props('mergeAborted')).toBe(false)

    // Someone ran `git merge --abort` elsewhere: the next status read has no
    // unmerged paths left.
    statusOverride.value = baseStatus()
    await rowFor(wrapper, 'a.ts').find('button.chk').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent({ name: 'ConflictPane' }).props('mergeAborted')).toBe(true)
    expect(modeLabels(wrapper)).toEqual(['Diff', 'Blame', 'History'])
  })

  it('returns to the diff and refreshes after the panel resolves the file', async () => {
    statusOverride.value = mergingStatus()
    wrapper = await mountApp()
    await wrapper.find('.frow.conflict').trigger('click')
    await flushPromises()
    const before = callsOf('git.status').length

    wrapper.findComponent({ name: 'ConflictPane' }).vm.$emit('resolved')
    await flushPromises()

    expect(wrapper.findAll('.dt-modes button.on').map((b) => b.text())).toEqual(['Diff'])
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(true)
    expect(callsOf('git.status').length).toBeGreaterThan(before)
  })

  it('keeps the conflict row actions the Git window already had', async () => {
    statusOverride.value = mergingStatus()
    wrapper = await mountApp()
    const actions = wrapper.find('.frow.conflict').findAll('button.linkbtn').map((b) => b.text())
    expect(actions).toEqual(['ours', 'theirs', 'editor', 'agent'])
  })

  it('resets the detail to Diff and drops the caches when another file is opened', async () => {
    wrapper = await mountApp()
    await rowFor(wrapper, 'a.ts').trigger('click')
    await flushPromises()
    await wrapper.findAll('.dt-modes button').find((b) => b.text() === 'Blame')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.blame-row').exists()).toBe(true)

    await rowFor(wrapper, 'staged.ts').trigger('click')
    await flushPromises()
    expect(wrapper.find('.blame-row').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'DiffPane' }).exists()).toBe(true)
    const on = wrapper.findAll('.dt-modes button').find((b) => b.classes().includes('on'))
    expect(on!.text()).toBe('Diff')
  })

  // ── 3. File row context menu ───────────────────────────────────────────────
  it('offers "Add to .gitignore" on untracked rows only, and wires it up', async () => {
    wrapper = await mountApp()
    await openFileMenu(wrapper, 'a.ts')
    expect(wrapper.findAll('.menu-item').map((m) => m.text())).toEqual([
      'Open in Editor',
      'View History',
      'Blame',
      'Restore from Branch…'
    ])

    await openFileMenu(wrapper, 'new.ts')
    await menuItem(wrapper, 'Add to .gitignore').trigger('click')
    await flushPromises()
    expect(callsOf('git.ignore')[0]!.payload).toMatchObject({
      pattern: 'src/new.ts',
      target: 'project',
      untrack: true
    })
  })

  it('opens Blame and History straight from the file context menu', async () => {
    wrapper = await mountApp()
    await openFileMenu(wrapper, 'staged.ts')
    await menuItem(wrapper, 'Blame').trigger('click')
    await flushPromises()
    expect(callsOf('git.blame')[0]!.payload).toMatchObject({ filepath: 'src/staged.ts' })

    await openFileMenu(wrapper, 'staged.ts')
    await menuItem(wrapper, 'View History').trigger('click')
    await flushPromises()
    expect(callsOf('git.file_log')[0]!.payload).toMatchObject({ filepath: 'src/staged.ts' })
  })

  it('restores a file from another branch through the two-level menu', async () => {
    wrapper = await mountApp()
    await openFileMenu(wrapper, 'a.ts')
    await menuItem(wrapper, 'Restore from Branch…').trigger('click')
    await flushPromises()
    // Second level lists the other local branches only (never the current one).
    const branches = wrapper.findAll('.menu-item').map((m) => m.text())
    expect(branches).toEqual(['feature-x'])

    await menuItem(wrapper, 'feature-x').trigger('click')
    await flushPromises()
    expect(dialogMessage()).toContain('Restore src/a.ts from feature-x')
    await answerDialog(true)
    expect(callsOf('git.restore_from_branch')[0]!.payload).toMatchObject({
      branch: 'feature-x',
      filepath: 'src/a.ts'
    })
  })

  it('keeps the file rows draggable and left-clickable next to the context menu', async () => {
    wrapper = await mountApp()
    const row = rowFor(wrapper, 'a.ts')
    expect(row.attributes('draggable')).toBe('true')
    await row.trigger('contextmenu', { clientX: 5, clientY: 5 })
    expect(wrapper.findAll('.menu-item').length).toBeGreaterThan(0)
    await wrapper.find('.menu-backdrop').trigger('click')
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.find('.detail').exists()).toBe(true)
  })

  // ── 4. Branch context menu ─────────────────────────────────────────────────
  it('merges the current branch into another one from the branch context menu', async () => {
    wrapper = await mountApp()
    const feature = wrapper.findAll('.branch-row').find((r) => r.text().includes('feature-x'))
    await feature!.trigger('contextmenu')
    await menuItem(wrapper, 'Merge Current into feature-x').trigger('click')
    await flushPromises()
    expect(dialogMessage()).toContain('Merge main into feature-x')
    await answerDialog(true)
    expect(callsOf('git.merge_into')[0]!.payload).toMatchObject({ target: 'feature-x' })
  })

  // ── 5. Non-repo bootstrap ──────────────────────────────────────────────────
  it('initializes a repository from the empty state, honouring the .gitignore box', async () => {
    statusOverride.value = { ...baseStatus(), is_git_repo: false }
    wrapper = await mountApp()
    expect(wrapper.find('.init-card').exists()).toBe(true)

    await wrapper.find('.init-row input[type="checkbox"]').setValue(false)
    await wrapper.findAll('.init-card button').find((b) => b.text().includes('Initialize'))!.trigger('click')
    await flushPromises()
    expect(callsOf('git.init')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      create_gitignore: false
    })
  })

  it('clones from the empty state and opens the clone as a new workspace', async () => {
    statusOverride.value = { ...baseStatus(), is_git_repo: false }
    wrapper = await mountApp()
    await wrapper.findAll('.init-card button').find((b) => b.text().includes('Clone Repository'))!.trigger('click')

    const cloneBtn = (): DOMWrapper<Element> =>
      wrapper!.findAll('.init-clone button').find((b) => b.text() === 'Clone')!
    expect(cloneBtn().attributes('disabled')).toBeDefined()

    const inputs = wrapper.findAll('.init-clone input')
    await inputs[0]!.setValue('https://example.com/r.git')
    // The target folder can come from the ui.pick_folder host capability.
    await wrapper.find('.init-clone .btn-ghost').trigger('click')
    await flushPromises()
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('/tmp/picked')
    expect(cloneBtn().attributes('disabled')).toBeUndefined()

    await cloneBtn().trigger('click')
    await flushPromises()
    expect(callsOf('git.clone')[0]!.payload).toMatchObject({
      url: 'https://example.com/r.git',
      target_dir: '/tmp/picked'
    })
    expect(callsOf('ui.open_workspace')[0]!.payload).toMatchObject({ workspace_path: '/tmp/cloned' })
  })
})

// ── Resolve with agent: hand a conflicted file to the embedded CLI dock ──────
describe('GitWindowApp — Resolve with agent', () => {
  let wrapper: VueWrapper | null = null

  const SMALL_CONFLICT = [
    'const a = 1',
    '<<<<<<< HEAD',
    'const b = 2',
    '=======',
    'const b = 3',
    '>>>>>>> feature-x',
    'const c = 4'
  ].join('\n')

  /** 700 lines with a single conflict block at lines 501–505. */
  function largeConflict(): string {
    const lines: string[] = []
    for (let i = 1; i <= 500; i++) lines.push(`FILLER_${i}`)
    lines.push('<<<<<<< HEAD', 'const b = 2', '=======', 'const b = 3', '>>>>>>> feature-x')
    for (let i = 501; i <= 700; i++) lines.push(`FILLER_${i}`)
    return lines.join('\n')
  }

  function conflictStatus(): Record<string, unknown> {
    return {
      ...baseStatus(),
      operation_in_progress: 'merge',
      unstaged: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/conflict.ts', status: 'U' }]
    }
  }

  function agentButton(w: VueWrapper): DOMWrapper<Element> {
    const btn = w
      .find('.frow.conflict')
      .findAll('button.linkbtn')
      .find((b) => b.text() === 'agent')
    expect(btn, 'the conflict row offers an "agent" action').toBeDefined()
    return btn!
  }

  /** The prompt paste (the dock also injects its own git context on a fresh
   *  spawn, so pick ours out of the stream rather than assuming an index). */
  function promptPaste(): string | undefined {
    return term.pastes.find((p) => p.includes('Resolve a git merge conflict'))
  }

  function toastMessages(): string[] {
    return notify.toasts.value.map((t) => t.message)
  }

  beforeEach(() => {
    sends.calls.length = 0
    statusOverride.value = conflictStatus()
    fileRead.ok = true
    fileRead.content = SMALL_CONFLICT
    fileRead.error = ''
    term.pastes.length = 0
    term.spawnCalls = 0
    term.spawnRuns = true
    term.status = 'running'
    // A timestamp well in the past = the CLI has been quiet, so the injection
    // wait resolves without burning real time.
    term.lastRawActivityAt = Date.now() - 60_000
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    term.status = 'idle'
    term.lastRawActivityAt = 0
    term.pastes.length = 0
  })

  it('offers the agent action on conflict rows only', async () => {
    wrapper = await mountApp()
    expect(agentButton(wrapper).exists()).toBe(true)
    for (const file of ['a.ts', 'staged.ts', 'new.ts']) {
      const labels = rowFor(wrapper, file)
        .findAll('button.linkbtn')
        .map((b) => b.text())
      expect(labels, file).not.toContain('agent')
    }
  })

  it('adds "Resolve with Agent" to the context menu of conflicted files only', async () => {
    wrapper = await mountApp()
    await wrapper.find('.frow.conflict').trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(wrapper.findAll('.menu-item').map((m) => m.text())[0]).toBe('Resolve with Agent')

    await wrapper.find('.menu-backdrop').trigger('click')
    await rowFor(wrapper, 'a.ts').trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(wrapper.findAll('.menu-item').map((m) => m.text())).not.toContain('Resolve with Agent')
  })

  it('quotes a small file in full and submits it as one bracketed paste', async () => {
    wrapper = await mountApp()
    await agentButton(wrapper).trigger('click')
    await flushPromises()

    expect(callsOf('fs.read_file')[0]!.payload).toMatchObject({
      workspace_path: '/tmp/ws',
      rel_path: 'src/conflict.ts'
    })
    const prompt = promptPaste()
    expect(prompt).toBeDefined()
    expect(prompt!.startsWith('\x1b[200~')).toBe(true)
    expect(prompt!.endsWith('\x1b[201~')).toBe(true)
    expect(prompt).toContain('File: src/conflict.ts (absolute path: /tmp/ws/src/conflict.ts)')
    expect(prompt).toContain('Operation in progress: merge')
    expect(prompt).toContain('Conflict blocks in this file: 1')
    expect(prompt).toContain('Full content of src/conflict.ts:')
    expect(prompt).toContain(SMALL_CONFLICT)
    expect(prompt).not.toContain('This is an excerpt')

    // The submitting CR follows the paste.
    await vi.waitFor(() => expect(term.pastes).toContain('\r'))
    expect(toastMessages().some((m) => m.includes('Sent the conflict in src/conflict.ts'))).toBe(true)
  })

  it('sends only the conflict regions of a large file, pointing at the full path', async () => {
    fileRead.content = largeConflict()
    wrapper = await mountApp()
    await agentButton(wrapper).trigger('click')
    await flushPromises()

    const prompt = promptPaste()!
    expect(prompt).toContain('This is an excerpt — read the complete file at /tmp/ws/src/conflict.ts')
    expect(prompt).toContain('--- src/conflict.ts lines 495-511 ---')
    // 6 lines of context on each side of the block, and nothing beyond them.
    expect(prompt).toContain('\nFILLER_495\n')
    expect(prompt).not.toContain('\nFILLER_494\n')
    expect(prompt).toContain('\nFILLER_506\n')
    expect(prompt).not.toContain('\nFILLER_507\n')
    expect(prompt.length).toBeLessThan(fileRead.content.length)
  })

  it('starts the CLI first when no PTY is running, then injects the prompt', async () => {
    term.status = 'idle'
    wrapper = await mountApp()
    await agentButton(wrapper).trigger('click')
    await flushPromises()

    expect(term.spawnCalls).toBe(1)
    expect(promptPaste()).toBeDefined()
    // The panel is expanded so the user sees the agent working.
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.display).not.toBe('none')
  })

  it('reports an error instead of failing silently when the CLI cannot start', async () => {
    term.status = 'idle'
    term.spawnRuns = false
    wrapper = await mountApp()
    await agentButton(wrapper).trigger('click')
    await flushPromises()

    expect(term.spawnCalls).toBe(1)
    expect(promptPaste()).toBeUndefined()
    expect(toastMessages().some((m) => m.includes('Could not start the CLI agent'))).toBe(true)
  })

  it('reports a read failure and never pastes a partial prompt', async () => {
    fileRead.ok = false
    fileRead.error = 'permission denied'
    wrapper = await mountApp()
    await agentButton(wrapper).trigger('click')
    await flushPromises()

    expect(promptPaste()).toBeUndefined()
    expect(toastMessages()).toContain('permission denied')
  })
})

describe('GitWindowApp — workspace title (legacy recovery bundle)', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('wears the alias the Host resolved, in the window title and the toolbar crumb', async () => {
    wrapper = await mountApp('/Users/dev/projects/agent-team', '  Navide  ')
    expect(document.title).toBe('Navide — Git')
    expect(wrapper.get('.toolbar .crumb').text()).toContain('Navide')
  })

  it('falls back to the folder name when the alias is absent or blank', async () => {
    for (const alias of ['', ' ', '   ']) {
      document.title = 'untouched'
      const view = await mountApp('/Users/dev/projects/agent-team', alias)
      expect(document.title, JSON.stringify(alias)).toBe('agent-team — Git')
      expect(view.get('.toolbar .crumb').text(), JSON.stringify(alias)).toContain('agent-team')
      view.unmount()
    }
  })
})
