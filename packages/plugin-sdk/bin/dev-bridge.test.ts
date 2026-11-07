import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM module without type declarations
import { PUBLIC_GIT_OVERRIDES, assertPublicGitConfigSafe, createDevBridge } from './dev-bridge.mjs'
// @ts-expect-error - plain ESM module without type declarations
import { parseCommand, validatePublicArgv } from './dev-shell-policy.mjs'

const roots: string[] = []
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-bridge-')))
  roots.push(root)
  writeFileSync(join(root, 'a.txt'), 'hello')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'b.txt'), 'b')
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const manifest = (permissions: Record<string, unknown>) => ({
  schemaVersion: 2, id: 'acme.files', version: '1.0.0', permissions,
  backend: { entry: 'backend/x', protocolVersion: 1, activation: 'startup', methods: ['files.read'] },
})
const request = (port: string, operation: string, args: unknown) => ({ origin: { kind: 'call', requestId: 'r1' }, port, operation, arguments: args })

describe('dev-backend local Host bridge', () => {
  it('serves declared filesystem reads inside the workspace and nothing outside it', async () => {
    const root = workspace()
    const activityFile = join(mkdtempSync(join(tmpdir(), 'dev-bridge-data-')), 'activity.jsonl')
    roots.push(join(activityFile, '..'))
    const bridge = createDevBridge({ manifest: manifest({ system: ['fs'] }), workspaceRoot: root, activityFile })
    await expect(bridge.handle(request('filesystem', 'read_file', { rel_path: 'a.txt' }))).resolves.toMatchObject({ value: { content: 'hello' } })
    await expect(bridge.handle(request('filesystem', 'list_dir', { rel_path: '.' }))).resolves.toEqual({ value: { entries: ['a.txt', 'sub'] } })
    await expect(bridge.handle(request('filesystem', 'stat_path', { rel_path: 'sub/b.txt' }))).resolves.toEqual({ value: { exists: true, isDirectory: false, size: 1 } })
    await expect(bridge.handle(request('filesystem', 'stat_path', { rel_path: 'nope' }))).resolves.toEqual({ value: { exists: false, isDirectory: false, size: 0 } })
    const range = await bridge.handle(request('filesystem', 'read_range', { rel_path: 'a.txt', offset: 1, length: 2 }))
    expect(range).toMatchObject({ value: { data_base64: Buffer.from('el').toString('base64'), size: 5, eof: false } })
    for (const rel of ['../secret', '/etc/passwd', 'sub/../../x']) {
      await expect(bridge.handle(request('filesystem', 'read_file', { rel_path: rel }))).resolves.toEqual({ error: { code: 'WORKSPACE_SCOPE_VIOLATION' } })
    }
    symlinkSync('/', join(root, 'escape'))
    await expect(bridge.handle(request('filesystem', 'list_dir', { rel_path: 'escape' }))).resolves.toEqual({ error: { code: 'WORKSPACE_SCOPE_VIOLATION' } })
    await expect(bridge.handle(request('filesystem', 'read_file', { rel_path: 'a.txt', extra: 1 }))).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } })
    await expect(bridge.handle(request('filesystem', 'watch', { rel_path: '.' }))).resolves.toEqual({ error: { code: 'METHOD_NOT_FOUND' } })
    // Writes need --allow-writes: the developer's stand-in for the per-workspace prompt.
    await expect(bridge.handle(request('filesystem', 'write_file', { rel_path: 'c.txt', content: 'x' }))).resolves.toEqual({
      error: { code: 'CAPABILITY_DENIED', reason: 'write-not-granted', message: expect.stringContaining('--allow-writes') },
    })
    expect(existsSync(join(root, 'c.txt'))).toBe(false)
    const rows = readFileSync(activityFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(rows.map((row) => [row.source, row.address, row.outcome, row.denied_reason, row.fs_path])).toEqual([
      ['broker', 'filesystem.read_file', 'allowed', '', 'a.txt'],
      ['broker', 'filesystem.list_dir', 'allowed', '', '.'],
      ['broker', 'filesystem.stat_path', 'allowed', '', 'sub/b.txt'],
      ['broker', 'filesystem.stat_path', 'allowed', '', 'nope'],
      ['broker', 'filesystem.read_range', 'allowed', '', 'a.txt'],
      ['broker', 'filesystem.read_file', 'error', 'WORKSPACE_SCOPE_VIOLATION', '../secret'],
      ['broker', 'filesystem.read_file', 'error', 'WORKSPACE_SCOPE_VIOLATION', '/etc/passwd'],
      ['broker', 'filesystem.read_file', 'error', 'WORKSPACE_SCOPE_VIOLATION', 'sub/../../x'],
      ['broker', 'filesystem.list_dir', 'error', 'WORKSPACE_SCOPE_VIOLATION', 'escape'],
      ['broker', 'filesystem.read_file', 'error', 'INVALID_ARGUMENT', 'a.txt'],
      ['broker', 'filesystem.watch', 'denied', 'METHOD_NOT_FOUND', '.'],
      ['broker', 'filesystem.write_file', 'denied', 'write-not-granted', 'c.txt'],
    ])
    expect(rows[0]).toMatchObject({ plugin_id: 'acme.files', plugin_version: '1.0.0', workspace: root, shell_command: '' })
  })

  it('writes, chunked writes, deletes and renames with --allow-writes, with the Host conflict check', async () => {
    const root = workspace()
    const bridge = createDevBridge({ manifest: manifest({ system: ['fs'] }), workspaceRoot: root, allowWrites: true })
    const written = await bridge.handle(request('filesystem', 'write_file', { rel_path: 'new/c.txt', content: 'c' }))
    expect(written).toMatchObject({ value: { ok: true } })
    expect(readFileSync(join(root, 'new', 'c.txt'), 'utf8')).toBe('c')
    await expect(bridge.handle(request('filesystem', 'write_file', { rel_path: 'new/c.txt', content: 'd', expected_mtime: 1 }))).resolves.toMatchObject({ value: { ok: false, conflict: true } })
    const data = Buffer.from('chunked').toString('base64')
    await expect(bridge.handle(request('filesystem', 'write_part', { rel_path: 'big.bin', upload_id: 'u1', offset: 0, data_base64: data }))).resolves.toEqual({ value: { ok: true, size: 7 } })
    await expect(bridge.handle(request('filesystem', 'write_part', { rel_path: 'big.bin', upload_id: 'u1', offset: 3, data_base64: data }))).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    await expect(bridge.handle(request('filesystem', 'write_commit', { rel_path: 'big.bin', upload_id: 'u1', total_size: 7 }))).resolves.toMatchObject({ value: { ok: true } })
    expect(readFileSync(join(root, 'big.bin'), 'utf8')).toBe('chunked')
    await expect(bridge.handle(request('filesystem', 'rename', { from: 'big.bin', to: 'sub/big.bin' }))).resolves.toEqual({ value: { ok: true } })
    await expect(bridge.handle(request('filesystem', 'rename', { from: 'sub/big.bin', to: '../out.bin' }))).resolves.toEqual({ error: { code: 'WORKSPACE_SCOPE_VIOLATION' } })
    await expect(bridge.handle(request('filesystem', 'delete', { rel_path: 'sub/big.bin' }))).resolves.toEqual({ value: { ok: true } })
    expect(existsSync(join(root, 'sub', 'big.bin'))).toBe(false)
  })

  it('refuses what the manifest does not declare, and everything without a workspace, exactly as Navide does', async () => {
    const root = workspace()
    const none = createDevBridge({ manifest: manifest({ system: ['ui'] }), workspaceRoot: root })
    await expect(none.handle(request('filesystem', 'read_file', { rel_path: 'a.txt' }))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'undeclared' } })
    await expect(none.handle(request('shell', 'run', { command: 'git status' }))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'undeclared' } })
    await expect(none.handle(request('web', 'navigate', {}))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'undeclared' } })
    await expect(none.handle(request('network', 'fetch', {}))).resolves.toEqual({ error: { code: 'PROTOCOL_ERROR' } })
    await expect(none.handle({ port: 'filesystem' })).resolves.toEqual({ error: { code: 'PROTOCOL_ERROR' } })
    expect(none.rows.map((row: { denied_reason: string }) => row.denied_reason)).toEqual(['undeclared', 'undeclared', 'undeclared'])

    const noWorkspace = createDevBridge({ manifest: manifest({ system: ['fs', 'agents'] }), workspaceRoot: null })
    await expect(noWorkspace.handle(request('filesystem', 'read_file', { rel_path: 'a.txt' }))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'no-workspace' } })
    const agents = createDevBridge({ manifest: manifest({ system: ['fs', 'agents'] }), workspaceRoot: root })
    await expect(agents.handle(request('agents', 'list', {}))).resolves.toMatchObject({ error: { code: 'BACKEND_UNAVAILABLE', reason: 'dev-backend' } })
  })

  it('runs allowlisted shell commands through the public policy and records them', async () => {
    const root = workspace()
    const calls: Array<[string[], string]> = []
    const bridge = createDevBridge({
      manifest: manifest({ system: ['fs'], shell: { mode: 'allowlist', executables: ['npm', 'bad.exe'] } }),
      workspaceRoot: root,
      runShell: (argv: string[], cwd: string) => { calls.push([argv, cwd]); return { exitCode: 0, stdout: 'ok', stderr: '' } },
    })
    await expect(bridge.handle(request('shell', 'run', { command: 'git status --short' }))).resolves.toEqual({ value: { exitCode: 0, stdout: 'ok', stderr: '' } })
    await expect(bridge.handle(request('shell', 'run', { command: 'npm test -- --watch=false' }))).resolves.toMatchObject({ value: { exitCode: 0 } })
    expect(calls).toEqual([[['git', 'status', '--short'], root], [['npm', 'test', '--', '--watch=false'], root]])
    for (const command of ['rm -rf /', 'git -c core.editor=x status', 'git config user.name', 'git status; rm x', 'gh auth login', 'bad.exe', 'git log -- ../other']) {
      await expect(bridge.handle(request('shell', 'run', { command }))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'policy' } })
    }
    await expect(bridge.handle(request('shell', 'run', { command: 'git status', cwd: '/' }))).resolves.toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    await expect(bridge.handle(request('shell', 'exec', { command: 'git status' }))).resolves.toEqual({ error: { code: 'METHOD_NOT_FOUND' } })
    expect(bridge.rows.filter((row: { source: string }) => row.source === 'shell').map((row: { outcome: string; shell_command: string }) => [row.outcome, row.shell_command]).slice(0, 3)).toEqual([
      ['allowed', 'git status --short'], ['allowed', 'npm test -- --watch=false'], ['denied', 'rm -rf /'],
    ])
  })
})

describe('the ported public shell policy', () => {
  it('splits commands like the broker and refuses shell syntax', () => {
    expect(parseCommand(`git commit -m "a b" 'c d' e\\ f`)).toEqual(['git', 'commit', '-m', 'a b', 'c d', 'e f'])
    expect(() => parseCommand('git status | cat')).toThrow('one allowlisted executable')
    expect(() => parseCommand('git commit -m "open')).toThrow('quoting')
  })

  it('accepts the Host-allowlisted commands and refuses the documented escapes', () => {
    const ok = ['git status', 'git log -5 --oneline', 'git diff --stat HEAD~1', 'git commit -m msg', 'git push origin main',
      'git clone https://github.com/x/y.git dest', 'gh pr list --limit 5', 'gh api repos/x/y', 'glab issue list', 'git remote -v',
      'git push user@host:path']
    for (const command of ok) expect(() => validatePublicArgv(parseCommand(command))).not.toThrow()
    const refused = ['git --exec-path=/x status', 'git -C /tmp status', 'git credential fill', 'git submodule update', 'git bisect run x',
      'git clone ext::sh x', 'git -- push origin', 'gh auth status', 'gh pr merge 1', 'gh api -X POST repos', 'glab mr merge 1',
      'git log /etc/passwd', 'git worktree remove x', 'gh issue list --input f', '/usr/bin/git status', 'ls']
    for (const command of refused) expect(() => validatePublicArgv(parseCommand(command)), command).toThrow()
    expect(validatePublicArgv(['npm', 'run', 'x'], { allowedExecutables: new Set(['npm']) })).toEqual(['npm', 'run', 'x'])
    expect(() => validatePublicArgv(['npm', 'run', 'x'])).toThrow('not allowlisted')
  })
})

describe('dev-bridge execution hardening (security review of eeb2b0896)', () => {
  it('runs git, gh and glab in an isolated environment with the Host overrides, and declared executables as the user', async () => {
    const root = workspace()
    const bridge = createDevBridge({ manifest: manifest({ system: ['fs'], shell: { mode: 'allowlist', executables: ['npm'] } }), workspaceRoot: root })
    const spawnPath = join(root, 'spy.sh')
    // A spy that records argv and the environment, installed as `git`, `gh` and `npm` on a private PATH.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const spyOut = join(root, 'spy.out')
    writeFileSync(spawnPath, `#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "${spyOut}"\nenv >> "${spyOut}.env"\n`, { mode: 0o755 })
    for (const name of ['git', 'gh', 'npm']) symlinkSync(spawnPath, join(bin, name))
    const previous = { PATH: process.env.PATH, NAVIDE_SPY_MARK: process.env.NAVIDE_SPY_MARK }
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.NAVIDE_SPY_MARK = 'present'
    try {
      await expect(bridge.handle(request('shell', 'run', { command: 'git status' }))).resolves.toMatchObject({ value: { exitCode: 0 } })
      const argv = readFileSync(spyOut, 'utf8').trim().split('\n')
      expect(argv.slice(1)).toEqual([...PUBLIC_GIT_OVERRIDES, '-c', expect.stringMatching(/^core\.hooksPath=/), 'status'])
      expect(PUBLIC_GIT_OVERRIDES).toEqual(expect.arrayContaining(['safe.bareRepository=explicit', 'commit.gpgsign=false', 'gpg.program=false', 'credential.helper=']))
      const env = Object.fromEntries(readFileSync(`${spyOut}.env`, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]))
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dirname(root))
      expect(env.HOME).not.toBe(process.env.HOME)
      expect(env.NAVIDE_SPY_MARK).toBeUndefined()
      expect(existsSync(env.HOME)).toBe(false) // the throw-away home is removed after the run

      rmSync(`${spyOut}.env`)
      await expect(bridge.handle(request('shell', 'run', { command: 'gh pr list' }))).resolves.toMatchObject({ value: { exitCode: 0 } })
      const ghEnv = Object.fromEntries(readFileSync(`${spyOut}.env`, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]))
      expect(ghEnv.GH_CONFIG_DIR).toMatch(/navide-public-cli-/) // not the user's sign-in without --provider-auth

      rmSync(`${spyOut}.env`)
      await expect(bridge.handle(request('shell', 'run', { command: 'npm test' }))).resolves.toMatchObject({ value: { exitCode: 0 } })
      const npmEnv = Object.fromEntries(readFileSync(`${spyOut}.env`, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]))
      expect(npmEnv.NAVIDE_SPY_MARK).toBe('present') // a declared executable runs with the user's environment
    } finally {
      process.env.PATH = previous.PATH
      if (previous.NAVIDE_SPY_MARK === undefined) delete process.env.NAVIDE_SPY_MARK
      else process.env.NAVIDE_SPY_MARK = previous.NAVIDE_SPY_MARK
    }
  })

  it('refuses git when the workspace .git/config selects a program, and a dangling link as a write target', async () => {
    const root = workspace()
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\thooksPath = /tmp/evil\n')
    const bridge = createDevBridge({
      manifest: manifest({ system: ['fs'], shell: 'allowlist' }), workspaceRoot: root, allowWrites: true,
      runShell: () => { throw new Error('must not run') },
    })
    await expect(bridge.handle(request('shell', 'run', { command: 'git status' }))).resolves.toMatchObject({ error: { code: 'CAPABILITY_DENIED', reason: 'policy' } })
    // git parses the file, so a spelling a hand parser could miss is still caught.
    for (const text of ['[gpg "ssh"]\n\tprogram = /tmp/x\n', '[filter "lfs"]\n\tprocess = evil\n', '[include]\n\tpath = /tmp/x\n', '[diff "x"]\n\ttextconv = cat\n', '[alias]\n\tst = !sh\n', '[url "https://evil/"]\n\tinsteadOf = https://github.com/\n', '[core]\nhooksPath=/tmp/x\n']) {
      writeFileSync(join(root, '.git', 'config'), text)
      expect(() => assertPublicGitConfigSafe(root, root), text).toThrow('public shell policy')
    }
    writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/x/y.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
    expect(() => assertPublicGitConfigSafe(root, root)).not.toThrow()
    const ran = createDevBridge({ manifest: manifest({ system: ['fs'], shell: 'allowlist' }), workspaceRoot: root, runShell: () => ({ exitCode: 0, stdout: '', stderr: '' }) })
    await expect(ran.handle(request('shell', 'run', { command: 'git status' }))).resolves.toMatchObject({ value: { exitCode: 0 } })

    symlinkSync('/tmp/navide-dev-bridge-escape.txt', join(root, 'dangling.txt'))
    await expect(bridge.handle(request('filesystem', 'write_file', { rel_path: 'dangling.txt', content: 'x' }))).resolves.toEqual({ error: { code: 'WORKSPACE_SCOPE_VIOLATION' } })
    expect(existsSync('/tmp/navide-dev-bridge-escape.txt')).toBe(false)
  })
})
