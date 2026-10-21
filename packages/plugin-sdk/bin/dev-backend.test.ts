import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildBubblewrapArgs as hostBubblewrapArgs,
  buildSeatbeltProfile as hostSeatbeltProfile,
} from '../../../src/main/plugins/pluginBackendSandbox'
// @ts-expect-error - plain ESM module without type declarations
import { buildBubblewrapArgs, buildSeatbeltProfile, defaultDataDir, formatOutput, resolveDevSandbox, startDevBackend } from './dev-backend.mjs'

const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const fixtureSource = join(process.cwd(), 'packages/plugin-sdk/test-fixtures/dev-backend-echo.c')
const PATHS = { packageDir: '/p/acme.echo', dataDir: '/d/acme.echo', entryFile: '/p/acme.echo/backend/acme-echo' }

describe('dev-backend sandbox', () => {
  it('uses exactly the Host sandbox profile and bubblewrap arguments', () => {
    expect(buildSeatbeltProfile(PATHS)).toBe(hostSeatbeltProfile(PATHS))
    expect(buildBubblewrapArgs(PATHS)).toEqual(hostBubblewrapArgs(PATHS))
    expect(buildSeatbeltProfile({ packageDir: '/a"b', dataDir: '/d' })).toBe(hostSeatbeltProfile({ packageDir: '/a"b', dataDir: '/d' }))
    const withHome = { ...PATHS, homeDir: '/Users/dev' }
    expect(buildSeatbeltProfile(withHome)).toBe(hostSeatbeltProfile(withHome))
  })

  it('refuses on macOS without sandbox-exec', () => {
    expect(resolveDevSandbox(PATHS, 'darwin', { sandboxExec: null })).toBeInstanceOf(Error)
  })

  // Linux and Windows are unit-tested with mocked probes only (unverified on real hosts).
  it('[unverified on Linux] uses bwrap when present and refuses clearly otherwise', () => {
    expect(resolveDevSandbox(PATHS, 'linux', { bubblewrap: '/usr/bin/bwrap' })).toMatchObject({
      command: '/usr/bin/bwrap',
      args: expect.arrayContaining(['--unshare-all', '--', PATHS.entryFile]),
    })
    const refused = resolveDevSandbox(PATHS, 'linux', { bubblewrap: null })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('bubblewrap')
  })

  it('[unverified on Windows] refuses on Windows in v1', () => {
    expect((resolveDevSandbox(PATHS, 'win32') as Error).message).toContain('Windows')
  })
})

const hasCc = process.platform !== 'win32' && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
const linuxSandbox = process.platform === 'linux' ? resolveDevSandbox(PATHS, 'linux') : null
const expectedSandbox = process.platform === 'darwin'
  ? '/usr/bin/sandbox-exec'
  : linuxSandbox && !(linuxSandbox instanceof Error) ? linuxSandbox.command : null
const canRunLive = hasCc && (
  (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) || expectedSandbox !== null
)

describe.runIf(process.platform === 'linux' && linuxSandbox instanceof Error)('dev-backend on Linux without bubblewrap (live)', () => {
  it('refuses with a clear message instead of running unsandboxed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-backend-refused-')))
    try {
      mkdirSync(join(root, 'backend'))
      writeFileSync(join(root, 'backend', 'acme-echo'), 'not run', { mode: 0o755 })
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.echo', name: 'Echo', version: '1.0.0', publisher: 'acme',
        permissions: {}, marketplace: { description: 'Echo fixture backend.', license: 'MIT' },
        backend: { entry: 'backend/acme-echo', protocolVersion: 1, activation: 'startup', methods: ['echo.ping'] },
      }))
      const refused = spawnSync(process.execPath, [cli, 'dev-backend', root, '--call', 'echo.ping'], { encoding: 'utf8' })
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('bubblewrap (bwrap) is not installed or unprivileged user namespaces are disabled')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.runIf(canRunLive)('dev-backend against a tiny fixture backend (live)', () => {
  let root = ''
  let pluginDir = ''
  const manifest = {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.echo',
    name: 'Echo',
    version: '1.0.0',
    publisher: 'acme',
    engines: { navide: '>=0.2.14' },
    permissions: {},
    marketplace: { description: 'Echo fixture backend.', license: 'MIT' },
    backend: {
      entry: 'backend/acme-echo',
      protocolVersion: 1,
      activation: 'startup',
      methods: ['echo.ping', 'echo.emit', 'echo.bridge', 'echo.escape'],
      events: ['echo.changed'],
    },
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-backend-')))
    pluginDir = join(root, 'plugin')
    mkdirSync(join(pluginDir, 'backend'), { recursive: true })
    writeFileSync(join(root, 'secret.txt'), 'secret')
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest))
    const compiled = spawnSync('cc', [
      '-O0',
      `-DSECRET_PATH="${join(root, 'secret.txt')}"`,
      '-o', join(pluginDir, 'backend', 'acme-echo'),
      fixtureSource,
    ], { encoding: 'utf8' })
    if (compiled.status !== 0) throw new Error(compiled.stderr)
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('answers calls and events, refuses undeclared methods, denies the bridge, and stays sandboxed', async () => {
    const output: Array<[string, unknown]> = []
    const session = await startDevBackend({
      directory: pluginDir,
      manifest,
      dataDir: join(root, 'data'),
      onOutput: (kind: string, detail: unknown) => output.push([kind, detail]),
    })
    try {
      expect(session.sandbox).toBe(expectedSandbox)
      await expect(session.call('echo.ping', {})).resolves.toEqual({ pong: true })
      await expect(session.call('echo.unknown', {})).rejects.toThrow('not declared in backend.methods')
      await expect(session.subscribe('echo.other')).rejects.toThrow('not declared in backend.events')
      await expect(session.subscribe('echo.changed')).resolves.toEqual(['echo.changed'])
      await expect(session.call('echo.emit', {})).resolves.toEqual({ emitted: true })
      expect(output).toContainEqual(['event', { event: 'echo.changed', payload: { n: 1 } }])
      await expect(session.call('echo.bridge', {})).resolves.toEqual({ denied: true })
      expect(output).toContainEqual(['bridge', { port: 'filesystem', operation: 'read_file', arguments: { rel_path: 'a.txt' } }])
      await expect(session.call('echo.escape', {})).resolves.toEqual({ readSecret: false })
    } finally {
      await session.close()
    }
  }, 30_000)

  it('kills a grandchild that escaped to launchd when the session closes', async () => {
    if (process.platform !== 'darwin') return
    const dfDir = join(root, 'double-fork')
    mkdirSync(join(dfDir, 'backend'), { recursive: true })
    const compiled = spawnSync('cc', ['-O0', '-o', join(dfDir, 'backend', 'acme-df'),
      join(process.cwd(), 'src/main/plugins/test-fixtures/double-fork-backend.c')], { encoding: 'utf8' })
    if (compiled.status !== 0) throw new Error(compiled.stderr)
    const dfManifest = { ...manifest, id: 'acme.df', backend: { ...manifest.backend, entry: 'backend/acme-df', methods: ['df.ping'], events: [] } }
    const dataDir = join(root, 'df-data')
    const session = await startDevBackend({ directory: dfDir, manifest: dfManifest, dataDir, onOutput: () => undefined })
    await expect(session.call('df.ping', {})).resolves.toEqual({ pong: true })
    let pid = 0
    for (let attempt = 0; attempt < 100 && !pid; attempt += 1) {
      try {
        pid = Number(readFileSync(join(realpathSync(dataDir), 'grandchild.pid'), 'utf8').trim())
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    const isAlive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(pid).toBeGreaterThan(0)
    expect(isAlive()).toBe(true)
    await session.close()
    for (let attempt = 0; attempt < 60 && isAlive(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isAlive()).toBe(false)
  }, 30_000)

  it('runs one call from the command line', () => {
    const ok = spawnSync(process.execPath, [cli, 'dev-backend', pluginDir, '--call', 'echo.ping', '--data', join(root, 'cli-data')], {
      encoding: 'utf8',
    })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(`running in the ${expectedSandbox} sandbox`)
    expect(ok.stdout).toContain('← result {"pong":true}')

    const refused = spawnSync(process.execPath, [cli, 'dev-backend', pluginDir, '--call', 'echo.nope', '--data', join(root, 'cli-data')], {
      encoding: 'utf8',
    })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('not declared in backend.methods')
  }, 30_000)
})

describe('dev-backend output and data (DX-REPORT 7.1 #6, #9)', () => {
  it('keeps its data out of the package directory it runs', () => {
    // resolve(): Windows adds the drive letter to a rooted path.
    const packageDir = resolve('/work/acme/dist/package')
    const data = defaultDataDir('/work/acme/dist/package')
    expect(data).toBe(join(dirname(packageDir), '.navide-dev', 'package', 'data'))
    expect(data.startsWith(packageDir + sep)).toBe(false)
  })

  it('marks a clean exit neutrally and a failed one with a cross', () => {
    expect(formatOutput('exit', { code: 0, signal: null })).toBe('• backend exited {"code":0,"signal":null}')
    expect(formatOutput('exit', { code: 1, signal: null })).toBe('× backend exited {"code":1,"signal":null}')
    expect(formatOutput('exit', { code: null, signal: 'SIGKILL' })).toBe('× backend exited {"code":null,"signal":"SIGKILL"}')
    expect(formatOutput('result', { count: 2 })).toBe('← result {"count":2}')
  })
})
