// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { useGit } from '../useGit'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { createMockBackend, withScope, flush } from './mockBackend'

const WS = '/tmp/test-workspace'

const mockStatus = {
  is_git_repo: true,
  branch: 'main',
  remote_branch: 'origin/main',
  ahead: 1,
  behind: 0,
  staged: [{ path: 'src/foo.ts', status: 'M' }],
  unstaged: [],
  untracked: [{ path: 'new.txt', status: '?' }],
}

describe('useGit', () => {
  it('loads status on init when workspace is set', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(true)
    expect(result.gitStatus.value.branch).toBe('main')
    expect(result.gitStatus.value.staged).toHaveLength(1)
    scope.stop()
  })

  it('returns empty status when workspace is empty', async () => {
    const mock = createMockBackend('connected')

    const { result, scope } = withScope(() => useGit(() => '', mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(false)
    expect(mock.sent.find(s => s.type === 'git.status')).toBeUndefined()
    scope.stop()
  })

  it('exposes git.status failures and clears them after a successful retry', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', null, {
      ok: false,
      error: { code: 'CAPABILITY_DENIED', message: 'Git capability is unavailable' },
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.statusError.value).toBe('Git capability is unavailable')
    expect(result.statusLoaded.value).toBe(false)
    expect(result.gitStatus.value.is_git_repo).toBe(false)

    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    await result.loadStatus()

    expect(result.statusError.value).toBe('')
    expect(result.statusLoaded.value).toBe(true)
    expect(result.gitStatus.value.is_git_repo).toBe(true)
    scope.stop()
  })

  it('exposes a rejected git.status request without treating it as a repository result', async () => {
    const mock = createMockBackend('connected')
    mock.setRejection('git.status', 'ws not open')

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.statusError.value).toBe('ws not open')
    expect(result.statusLoaded.value).toBe(false)
    expect(result.gitStatus.value.is_git_repo).toBe(false)
    scope.stop()
  })

  it('loads log on init', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', {
      commits: [{ hash: 'abc123', short_hash: 'abc123', message: 'feat: init', branches: ['main'] }],
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitLog.value).toHaveLength(1)
    expect(result.gitLog.value[0].message).toBe('feat: init')
    scope.stop()
  })

  it('stageFile sends git.stage and reloads status', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.stage', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.stageFile('new.txt')
    await flush()

    const stageCall = mock.sent.find(s => s.type === 'git.stage')
    expect(stageCall).toBeDefined()
    expect(stageCall?.payload.files).toEqual(['new.txt'])
    scope.stop()
  })

  it('sets gitError when a write op fails, and clears it on next success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.unstage', { ok: false, error: 'could not resolve HEAD' })
    mock.setResponse('git.stage', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitError.value).toBe('')

    await result.unstageFiles(['a.txt'])
    await flush()
    expect(result.gitError.value).toBe('could not resolve HEAD')

    // A subsequent successful write clears the prior error.
    await result.stageFile('a.txt')
    await flush()
    expect(result.gitError.value).toBe('')
    scope.stop()
  })

  it('clearGitError resets the error channel', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.discard', { ok: false, error: 'boom' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.discardFiles(['x.txt'])
    await flush()
    expect(result.gitError.value).toBe('boom')

    result.clearGitError()
    expect(result.gitError.value).toBe('')
    scope.stop()
  })

  it('commit sends git.commit and reloads on success', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.commit', { ok: true, hash: 'abc1234' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const commitResult = await result.commit('feat: test commit')
    await flush()

    expect(commitResult.ok).toBe(true)
    const commitCall = mock.sent.find(s => s.type === 'git.commit')
    expect(commitCall?.payload.message).toBe('feat: test commit')
    scope.stop()
  })

  it('commit returns error when backend reports failure', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.commit', { ok: false, error: 'nothing to commit' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const commitResult = await result.commit('empty commit')
    expect(commitResult.ok).toBe(false)
    expect(commitResult.error).toBeTruthy()
    scope.stop()
  })

  it('refreshes on git.changed broadcast', async () => {
    vi.useFakeTimers()
    try {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })

      const { scope } = withScope(() => useGit(() => WS, mock.backend))
      await vi.runAllTimersAsync()

      const countBefore = mock.sent.filter(s => s.type === 'git.status').length

      mock.emit('git.changed', { workspace_path: WS })
      // Advance past the 300 ms debounce the handler uses
      await vi.runAllTimersAsync()

      const countAfter = mock.sent.filter(s => s.type === 'git.status').length
      expect(countAfter).toBeGreaterThan(countBefore)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-syncs status on backend reconnect', async () => {
    const mock = createMockBackend('disconnected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const countBefore = mock.sent.filter(s => s.type === 'git.status').length

    mock.status.value = 'connected'
    await flush()

    const countAfter = mock.sent.filter(s => s.type === 'git.status').length
    expect(countAfter).toBeGreaterThan(countBefore)
    scope.stop()
  })

  it('does not refresh on git.changed for different workspace', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const countBefore = mock.sent.filter(s => s.type === 'git.status').length

    mock.emit('git.changed', { workspace_path: '/other/path' })
    await flush()

    const countAfter = mock.sent.filter(s => s.type === 'git.status').length
    expect(countAfter).toBe(countBefore)
    scope.stop()
  })

  it('applyPatch sends git.apply_patch with reverse/cached flags', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.apply_patch', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const r = await result.applyPatch('PATCH', true, false)
    await flush()

    expect(r.ok).toBe(true)
    const call = mock.sent.find(s => s.type === 'git.apply_patch')
    expect(call?.payload).toMatchObject({ patch: 'PATCH', reverse: true, cached: false })
    scope.stop()
  })

  it('diffBlame sends git.diff_blame and returns the annotated hunks', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.diff_blame', {
      ok: true,
      hunks: [{ header: '@@ -1 +1,2 @@', lines: [
        { kind: '+', old_no: null, new_no: 2, text: 'new line', author: '', date: '', committed: false },
      ] }],
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const hunks = await result.diffBlame('README.md', false)
    await flush()

    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines[0]).toMatchObject({ kind: '+', committed: false })
    const call = mock.sent.find(s => s.type === 'git.diff_blame')
    expect(call?.payload).toMatchObject({ filepath: 'README.md', staged: false })
    scope.stop()
  })

  it('cloneRepo sends git.clone and returns the cloned path', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.clone', { ok: true, path: '/tmp/cloned/repo' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const r = await result.cloneRepo('https://example.com/x.git', '/tmp/cloned/repo')
    expect(r.ok).toBe(true)
    expect(r.path).toBe('/tmp/cloned/repo')
    const call = mock.sent.find(s => s.type === 'git.clone')
    expect(call?.payload).toMatchObject({ url: 'https://example.com/x.git', target_dir: '/tmp/cloned/repo' })
    scope.stop()
  })

  it('addToGitignore sends git.ignore with the pattern', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.ignore', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.addToGitignore('node_modules/')
    const call = mock.sent.find(s => s.type === 'git.ignore')
    expect(call?.payload.pattern).toBe('node_modules/')
    expect(call?.payload.target).toBe('project')
    expect(call?.payload.untrack).toBe(true)
    scope.stop()
  })

  it('addToGitignore forwards the chosen target', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.ignore', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.addToGitignore('cache/', 'local')
    const call = mock.sent.find(s => s.type === 'git.ignore')
    expect(call?.payload.target).toBe('local')
    scope.stop()
  })

  it('checkIgnore sends git.check_ignore and returns the verdict', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.check_ignore', {
      ok: true, ignored: true, tracked: false, source: '.gitignore', line: 3, pattern: '*.log',
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const r = await result.checkIgnore('debug.log')
    const call = mock.sent.find(s => s.type === 'git.check_ignore')
    expect(call?.payload.filepath).toBe('debug.log')
    expect(r.ignored).toBe(true)
    expect(r.pattern).toBe('*.log')
    scope.stop()
  })

  it('toggling showIgnored re-requests status with include_ignored', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    result.showIgnored.value = true
    await flush()
    const statusCalls = mock.sent.filter(s => s.type === 'git.status')
    expect(statusCalls.at(-1)?.payload.include_ignored).toBe(true)
    scope.stop()
  })

  it('abortOperation sends git.abort with the op', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.abort', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.abortOperation('rebase')
    const call = mock.sent.find(s => s.type === 'git.abort')
    expect(call?.payload.op).toBe('rebase')
    scope.stop()
  })

  it('stashApply sends git.stash_apply with the index', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.stash_apply', { ok: true })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.stashApply(2)
    const call = mock.sent.find(s => s.type === 'git.stash_apply')
    expect(call?.payload.index).toBe(2)
    scope.stop()
  })

  it('pullRebase and pushForce send their message types', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.pull_rebase', { ok: true, output: 'rebased', error: '' })
    mock.setResponse('git.push_force', { ok: true, output: 'forced', error: '' })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const pr = await result.pullRebase()
    const pf = await result.pushForce()
    expect(pr.ok).toBe(true)
    expect(pf.ok).toBe(true)
    expect(mock.sent.find(s => s.type === 'git.pull_rebase')).toBeDefined()
    expect(mock.sent.find(s => s.type === 'git.push_force')).toBeDefined()
    scope.stop()
  })

  it('loadLog defaults to all-branches scope with the page limit', async () => {
    __resetSettingsForTest()
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    const logSend = mock.sent.find(s => s.type === 'git.log')
    expect(logSend?.payload.all).toBe(true)
    expect(logSend?.payload.n).toBe(50)
    expect(result.logScope.value).toBe('all')
    scope.stop()
  })

  it('setLogScope("current") reloads with all:false and resets the limit', async () => {
    __resetSettingsForTest()
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.setLogScope('current')
    await flush()

    const last = [...mock.sent].reverse().find(s => s.type === 'git.log')
    expect(last?.payload.all).toBe(false)
    expect(last?.payload.n).toBe(50)
    expect(result.logScope.value).toBe('current')
    scope.stop()
  })

  it('persists log scope to the settings store and restores it on init', async () => {
    __resetSettingsForTest()
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    // First instance: switch to 'current' → persisted.
    const first = withScope(() => useGit(() => WS, mock.backend))
    await flush()
    await first.result.setLogScope('current')
    await flush()
    first.scope.stop()

    // Second instance starts up reading the persisted scope.
    const mock2 = createMockBackend('connected')
    mock2.setResponse('git.status', mockStatus)
    mock2.setResponse('git.log', { commits: [] })
    const second = withScope(() => useGit(() => WS, mock2.backend))
    await flush()

    expect(second.result.logScope.value).toBe('current')
    const logSend = mock2.sent.find(s => s.type === 'git.log')
    expect(logSend?.payload.all).toBe(false)
    second.scope.stop()
    __resetSettingsForTest()
  })

  it('loadMoreLog grows the limit by a page and refetches', async () => {
    __resetSettingsForTest()
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    await result.loadMoreLog()
    await flush()

    const last = [...mock.sent].reverse().find(s => s.type === 'git.log')
    expect(last?.payload.n).toBe(100)
    expect(result.logLimit.value).toBe(100)
    scope.stop()
  })

  it('discovers nested repos when root is not a git repo', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', { is_git_repo: false })
    mock.setResponse('git.log', { commits: [] })
    mock.setResponse('git.discover_repositories', {
      ok: true,
      repositories: [{ rel_path: 'a', abs_path: '/tmp/test-workspace/a', branch: 'main' }],
    })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(false)
    expect(mock.sent.find(s => s.type === 'git.discover_repositories')).toBeDefined()
    expect(result.discoveredRepos.value).toHaveLength(1)
    expect(result.discoveredRepos.value[0].rel_path).toBe('a')
    scope.stop()
  })

  it('does not discover repos when root is already a git repo', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })

    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    expect(result.gitStatus.value.is_git_repo).toBe(true)
    expect(mock.sent.find(s => s.type === 'git.discover_repositories')).toBeUndefined()
    expect(result.discoveredRepos.value).toHaveLength(0)
    scope.stop()
  })

  describe('cloud-synced workspaces (skipped discovery)', () => {
    const SKIPPED_RESP = {
      ok: true,
      repositories: [],
      truncated: true,
      skipped: 'cloud_storage',
    }

    function discoverCalls(mock: ReturnType<typeof createMockBackend>) {
      return mock.sent.filter(s => s.type === 'git.discover_repositories')
    }

    function mockNonRepo() {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', { is_git_repo: false })
      mock.setResponse('git.log', { commits: [] })
      return mock
    }

    it('leaves discoverySkipped false on a normal response', async () => {
      const mock = mockNonRepo()
      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [{ rel_path: 'a', abs_path: '/tmp/test-workspace/a', branch: 'main' }],
      })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      expect(result.discoverySkipped.value).toBe(false)
      expect(discoverCalls(mock)[0].payload.force).toBe(false)
      scope.stop()
    })

    it('sets discoverySkipped and yields the root-only list when the backend skips', async () => {
      const mock = mockNonRepo()
      mock.setResponse('git.discover_repositories', {
        ...SKIPPED_RESP,
        repositories: [{ rel_path: '.', abs_path: WS, branch: 'main' }],
      })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      expect(result.discoverySkipped.value).toBe(true)
      expect(result.discoveredRepos.value).toHaveLength(1)
      expect(result.discoveredRepos.value[0].rel_path).toBe('.')
      scope.stop()
    })

    it('sends force: true only for an explicit forced scan, and clears the flag', async () => {
      const mock = mockNonRepo()
      mock.setResponse('git.discover_repositories', SKIPPED_RESP)

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()
      expect(result.discoverySkipped.value).toBe(true)

      mock.setResponse('git.discover_repositories', {
        ok: true,
        repositories: [{ rel_path: 'a', abs_path: '/tmp/test-workspace/a', branch: 'main' }],
      })
      await result.discoverRepositories(true)

      const calls = discoverCalls(mock)
      expect(calls[0].payload.force).toBe(false)
      expect(calls[1].payload.force).toBe(true)
      expect(result.discoverySkipped.value).toBe(false)
      expect(result.discoveredRepos.value).toHaveLength(1)
      scope.stop()
    })

    it('does not force when loadStatus re-discovers', async () => {
      const mock = mockNonRepo()
      mock.setResponse('git.discover_repositories', SKIPPED_RESP)

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      await result.loadStatus()
      await flush()

      const calls = discoverCalls(mock)
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.every(c => c.payload.force === false)).toBe(true)
      expect(result.discoverySkipped.value).toBe(true)
      scope.stop()
    })
  })

  describe('credential prompt (askpass)', () => {
    it('pairs the independent Username/Password requests by host', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: WS, host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })
      expect(result.showCredentialPrompt.value).toBe(true)
      expect(result.credentialPrompt.value?.usernameRequestId).toBe('req-user')
      expect(result.credentialPrompt.value?.passwordRequestId).toBeNull()

      mock.emit('git.credential_request', {
        request_id: 'req-pass', workspace_path: WS, host: 'gitlab.com',
        prompt: "Password for 'https://gitlab.com': ",
      })
      expect(result.credentialPrompt.value?.usernameRequestId).toBe('req-user')
      expect(result.credentialPrompt.value?.passwordRequestId).toBe('req-pass')
      expect(result.credentialPrompt.value?.host).toBe('gitlab.com')
      scope.stop()
    })

    it('ignores credential_request events for a different workspace', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: '/other/path', host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })
      expect(result.credentialPrompt.value).toBeNull()
      scope.stop()
    })

    it('submitCredential sends git.credential_submit for both fields and closes the modal', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })
      mock.setResponse('git.credential_submit', { ok: true })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: WS, host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })
      mock.emit('git.credential_request', {
        request_id: 'req-pass', workspace_path: WS, host: 'gitlab.com',
        prompt: "Password for 'https://gitlab.com': ",
      })
      result.credentialPrompt.value!.username = 'octocat'
      result.credentialPrompt.value!.password = 'ghp_token'

      await result.submitCredential()
      await flush()

      const submits = mock.sent.filter(s => s.type === 'git.credential_submit')
      expect(submits).toHaveLength(2)
      expect(submits.find(s => s.payload.request_id === 'req-user')?.payload.value).toBe('octocat')
      expect(submits.find(s => s.payload.request_id === 'req-pass')?.payload.value).toBe('ghp_token')
      expect(result.credentialPrompt.value).toBeNull()
      scope.stop()
    })

    it('auto-submits the second field once its request arrives after submit', async () => {
      // git resolves askpass invocations sequentially: Password's request_id
      // may not exist yet when the user hits submit.
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })
      mock.setResponse('git.credential_submit', { ok: true })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: WS, host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })
      result.credentialPrompt.value!.username = 'octocat'
      result.credentialPrompt.value!.password = 'ghp_token'

      await result.submitCredential()
      await flush()

      // Username submitted immediately; modal hidden while password is pending.
      expect(mock.sent.filter(s => s.type === 'git.credential_submit')).toHaveLength(1)
      expect(result.showCredentialPrompt.value).toBe(false)

      // Backend resolves the username future, git now invokes askpass for Password.
      mock.emit('git.credential_request', {
        request_id: 'req-pass', workspace_path: WS, host: 'gitlab.com',
        prompt: "Password for 'https://gitlab.com': ",
      })
      await flush()

      const submits = mock.sent.filter(s => s.type === 'git.credential_submit')
      expect(submits).toHaveLength(2)
      expect(submits.find(s => s.payload.request_id === 'req-pass')?.payload.value).toBe('ghp_token')
      expect(result.credentialPrompt.value).toBeNull()
      scope.stop()
    })

    it('cancelCredential sends git.credential_cancel and closes the modal', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })
      mock.setResponse('git.credential_cancel', { ok: true })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: WS, host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })

      await result.cancelCredential()
      await flush()

      const cancels = mock.sent.filter(s => s.type === 'git.credential_cancel')
      expect(cancels).toHaveLength(1)
      expect(cancels[0].payload.request_id).toBe('req-user')
      expect(result.credentialPrompt.value).toBeNull()
      scope.stop()
    })

    it('closes the modal when the backend broadcasts credential_cancelled for a pending request', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })

      const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
      await flush()

      mock.emit('git.credential_request', {
        request_id: 'req-user', workspace_path: WS, host: 'gitlab.com',
        prompt: "Username for 'https://gitlab.com': ",
      })
      expect(result.credentialPrompt.value).not.toBeNull()

      mock.emit('git.credential_cancelled', { request_id: 'req-user', workspace_path: WS })

      expect(result.credentialPrompt.value).toBeNull()
      scope.stop()
    })
  })

  describe('three-way conflict surface', () => {
    const stages = {
      ok: true,
      base: 'base\n',
      ours: 'ours\n',
      theirs: 'theirs\n',
      has_base: true,
      has_ours: true,
      has_theirs: true,
      binary: false,
    }

    async function mounted(ws = WS) {
      const mock = createMockBackend('connected')
      mock.setResponse('git.status', mockStatus)
      mock.setResponse('git.log', { commits: [] })
      const { result, scope } = withScope(() => useGit(() => ws, mock.backend))
      await flush()
      return { mock, result, scope }
    }

    it('conflictStages sends git.conflict_stages with the filepath', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.conflict_stages', stages)

      const r = await result.conflictStages('src/f.ts')
      const call = mock.sent.find(s => s.type === 'git.conflict_stages')
      expect(call?.payload).toEqual({ workspace_path: WS, filepath: 'src/f.ts' })
      expect(r.ok).toBe(true)
      expect(r.base).toBe('base\n')
      expect(r.has_theirs).toBe(true)
      scope.stop()
    })

    it('conflictStages passes a stage-missing result through untouched', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.conflict_stages', { ...stages, base: '', has_base: false })

      const r = await result.conflictStages('new.txt')
      expect(r.ok).toBe(true)
      expect(r.has_base).toBe(false)
      expect(r.base).toBe('')
      scope.stop()
    })

    it('conflictStages returns no-workspace without sending', async () => {
      const { mock, result, scope } = await mounted('')

      const r = await result.conflictStages('f.txt')
      expect(r.ok).toBe(false)
      expect(r.error).toBe('no workspace')
      expect(mock.sent.find(s => s.type === 'git.conflict_stages')).toBeUndefined()
      scope.stop()
    })

    it('conflictStages surfaces a backend error and an absent payload', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.conflict_stages', {
        ...stages, ok: false, base: '', ours: '', theirs: '',
        has_base: false, has_ours: false, has_theirs: false,
        error: 'f.txt is not conflicted',
      })
      const failed = await result.conflictStages('f.txt')
      expect(failed.ok).toBe(false)
      expect(failed.error).toBe('f.txt is not conflicted')

      const { mock: mock2, result: result2, scope: scope2 } = await mounted()
      mock2.setResponse('git.conflict_stages', null)
      const empty = await result2.conflictStages('f.txt')
      expect(empty.ok).toBe(false)
      expect(empty.error).toBe('no response')
      scope.stop()
      scope2.stop()
    })

    it('listConflicts sends git.list_conflicts and returns the entries', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.list_conflicts', {
        ok: true,
        conflicts: [
          { path: 'f.txt', kind: 'both-modified' },
          { path: 'n.txt', kind: 'both-added' },
        ],
      })

      const r = await result.listConflicts()
      const call = mock.sent.find(s => s.type === 'git.list_conflicts')
      expect(call?.payload).toEqual({ workspace_path: WS })
      expect(r.ok).toBe(true)
      expect(r.conflicts).toHaveLength(2)
      expect(r.conflicts[1].kind).toBe('both-added')
      scope.stop()
    })

    it('listConflicts returns no-workspace and no-response empties', async () => {
      const { mock, result, scope } = await mounted('')
      const noWs = await result.listConflicts()
      expect(noWs).toEqual({ ok: false, conflicts: [], error: 'no workspace' })
      expect(mock.sent.find(s => s.type === 'git.list_conflicts')).toBeUndefined()

      const { mock: mock2, result: result2, scope: scope2 } = await mounted()
      mock2.setResponse('git.list_conflicts', null)
      expect(await result2.listConflicts()).toEqual({ ok: false, conflicts: [], error: 'no response' })
      scope.stop()
      scope2.stop()
    })

    it('markResolved sends git.mark_resolved with the write timeout and reloads status', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.mark_resolved', { ok: true })

      const before = mock.sent.filter(s => s.type === 'git.status').length
      const r = await result.markResolved('f.txt')
      await flush()

      const call = mock.sent.find(s => s.type === 'git.mark_resolved')
      expect(call?.payload).toEqual({ workspace_path: WS, filepath: 'f.txt' })
      expect(call?.timeoutMs).toBe(20_000)
      expect(r.ok).toBe(true)
      expect(mock.sent.filter(s => s.type === 'git.status').length).toBeGreaterThan(before)
      scope.stop()
    })

    it('markResolved reports a backend failure without reloading status', async () => {
      const { mock, result, scope } = await mounted()
      mock.setResponse('git.mark_resolved', { ok: false, error: 'pathspec did not match' })

      const before = mock.sent.filter(s => s.type === 'git.status').length
      const r = await result.markResolved('gone.txt')
      await flush()

      expect(r.ok).toBe(false)
      expect(r.error).toBe('pathspec did not match')
      expect(mock.sent.filter(s => s.type === 'git.status').length).toBe(before)
      scope.stop()
    })

    it('markResolved returns no-workspace and no-response failures', async () => {
      const { mock, result, scope } = await mounted('')
      expect(await result.markResolved('f.txt')).toEqual({ ok: false, error: 'no workspace' })
      expect(mock.sent.find(s => s.type === 'git.mark_resolved')).toBeUndefined()

      const { mock: mock2, result: result2, scope: scope2 } = await mounted()
      mock2.setResponse('git.mark_resolved', null)
      expect(await result2.markResolved('f.txt')).toEqual({ ok: false, error: 'no response' })
      scope.stop()
      scope2.stop()
    })
  })
})

describe('useGit read errors', () => {
  const commit = { hash: 'a1', short_hash: 'a1', subject: 'first', author: 'me', date: '2026-10-15' }

  it('keeps the commit list and names the reason when git.log fails', async () => {
    __resetSettingsForTest()
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [commit] })
    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()
    expect(result.gitLog.value).toHaveLength(1)
    expect(result.logError.value).toBe('')

    mock.setResponse('git.log', null, { ok: false, error: { code: 'GIT_ERROR', message: 'fatal: bad object' } })
    expect(await result.loadLog()).toBe(false)
    expect(result.logError.value).toBe('fatal: bad object')
    expect(result.gitLog.value).toHaveLength(1)

    mock.setRejection('git.log', 'ws not open')
    await result.loadLog()
    expect(result.logError.value).toBe('ws not open')

    mock.clearRejection('git.log')
    mock.setResponse('git.log', { commits: [commit] })
    expect(await result.loadLog()).toBe(true)
    expect(result.logError.value).toBe('')
    scope.stop()
  })

  it('names the reason when a commit cannot be shown', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('git.status', mockStatus)
    mock.setResponse('git.log', { commits: [] })
    const { result, scope } = withScope(() => useGit(() => WS, mock.backend))
    await flush()

    mock.setResponse('git.show_commit', { ok: false, error: 'bad revision' })
    expect(await result.showCommit('zz')).toBeNull()
    expect(result.commitDetailError.value).toBe('bad revision')

    mock.setRejection('git.show_commit', 'ws not open')
    expect(await result.showCommit('zz')).toBeNull()
    expect(result.commitDetailError.value).toBe('ws not open')

    mock.clearRejection('git.show_commit')
    mock.setResponse('git.show_commit', { ok: true, hash: 'a1', files: [] })
    expect(await result.showCommit('a1')).not.toBeNull()
    expect(result.commitDetailError.value).toBe('')
    scope.stop()
  })
})
