import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'

const killProcessTree = vi.hoisted(() => vi.fn())
vi.mock('./process-tree', () => ({ killProcessTree }))

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformId, setPlatformId } from '../shared/osplat'
import {
  bindBackendDisabledBuiltins,
  bindBackendPluginActivationCatalog,
  handConfirmKey,
  listNvmNodeBins,
  mergePathList,
  mintTrustConfirmation,
  pathEnvKey,
  stopBackendProcess,
  waitForHealth,
  proveWindow,
} from './backend'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

describe('backend plugin activation environment', () => {
  it('replaces directory discovery with a path and exact-byte digest binding', () => {
    expect(
      bindBackendPluginActivationCatalog(
        { AGENT_TEAM_PLUGINS_DIR: '/unsafe-scan', KEEP: 'yes' },
        { path: '/state/catalog.json', sha256: 'a'.repeat(64) }
      )
    ).toEqual({
      KEEP: 'yes',
      AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG: '/state/catalog.json',
      AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG_SHA256: 'a'.repeat(64),
    })
  })
})

describe('bindBackendDisabledBuiltins', () => {
  it('hands a starting backend the disabled built-ins, and nothing at all when none is', () => {
    expect(bindBackendDisabledBuiltins({ KEEP: 'yes' }, ['navide.plans', 'navide.git'])).toEqual({
      KEEP: 'yes',
      NAVIDE_DISABLED_BUILTIN_PLUGINS: 'navide.git,navide.plans',
    })
    // A value inherited from a launcher never survives an all-enabled start.
    expect(bindBackendDisabledBuiltins({ KEEP: 'yes', NAVIDE_DISABLED_BUILTIN_PLUGINS: 'navide.git' }, []))
      .toEqual({ KEEP: 'yes' })
  })
})

describe('listNvmNodeBins', () => {
  let home: string
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists every installed version bin, newest first, and nothing else', () => {
    home = mkdtempSync(join(tmpdir(), 'nvm-home-'))
    const node = join(home, '.nvm', 'versions', 'node')
    for (const v of ['v18.20.4', 'v22.11.0', 'v20.19.0']) mkdirSync(join(node, v, 'bin'), { recursive: true })
    mkdirSync(join(node, 'v16.0.0'), { recursive: true }) // no bin: half-installed
    writeFileSync(join(node, '.DS_Store'), '')
    expect(listNvmNodeBins(home)).toEqual([
      join(node, 'v22.11.0', 'bin'),
      join(node, 'v20.19.0', 'bin'),
      join(node, 'v18.20.4', 'bin'),
    ])
  })

  it('is empty without nvm', () => {
    home = mkdtempSync(join(tmpdir(), 'nvm-home-'))
    expect(listNvmNodeBins(home)).toEqual([])
  })
})

// waitForHealth is the low-level poller startBackend() delegates to; testing it
// directly (rather than startBackend, which spawns a real child process and
// touches Electron's `app`) verifies the configured timeout value is actually
// honored end-to-end once threaded through from Settings.
describe('waitForHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves as soon as /health responds ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(waitForHealth('127.0.0.1', 1234, 5_000)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1234/health')
  })

  it('gives up around the configured timeout instead of a hardcoded one', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)
    const start = Date.now()
    await expect(waitForHealth('127.0.0.1', 1234, 100)).rejects.toThrow(/did not become healthy within 100ms/)
    // Never healthy — must give up close to the configured bound (~250ms poll
    // granularity), not hang for the old hardcoded 45s.
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('keeps retrying until healthy as long as the configured timeout allows it', async () => {
    let calls = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++
      return calls < 3 ? Promise.reject(new Error('not up yet')) : Promise.resolve({ ok: true, status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(waitForHealth('127.0.0.1', 1234, 5_000)).resolves.toBeUndefined()
    expect(calls).toBe(3)
  })
})


// -- The trust-confirmation key -----------------------------------------------
//
// The check the backend performs rests entirely on where this key is and is
// not. Until now that rested on comments and one manual sweep; these are what
// notice when it moves.

describe('the trust-confirmation key', () => {
  afterEach(() => setPlatformId(BASELINE))

  it('goes over stdin once, followed by the host token, and closes the pipe', () => {
    // Not a file and not an environment variable, deliberately: `cat` and
    // `ps -E` are the two things a CLI agent on this machine does without
    // trying, and this key is the only thing telling that agent apart from the
    // window a person is looking at.
    setPlatformId('darwin')
    const writes: string[] = []
    let ended = false
    const proc = { stdin: { write: (s: string) => writes.push(s), end: () => { ended = true } } }
    handConfirmKey(proc as unknown as Parameters<typeof handConfirmKey>[0], 'host-token')

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/^[0-9a-f]{64} host-token\n$/)
    expect(ended).toBe(true)
  })

  it('keeps the pipe open on Windows, where it later carries the shutdown line', () => {
    setPlatformId('win32')
    const writes: string[] = []
    let ended = false
    const proc = { stdin: { write: (s: string) => writes.push(s), end: () => { ended = true } } }
    handConfirmKey(proc as unknown as Parameters<typeof handConfirmKey>[0], 'host-token')

    expect(writes).toHaveLength(1)
    expect(ended).toBe(false)
  })

  it('is a different key for every backend', () => {
    const first: string[] = []
    const second: string[] = []
    const proc = (into: string[]) =>
      ({ stdin: { write: (s: string) => into.push(s), end: () => {} } }) as unknown as Parameters<
        typeof handConfirmKey
      >[0]
    handConfirmKey(proc(first), 'host-token')
    handConfirmKey(proc(second), 'host-token')
    expect(first[0]).not.toEqual(second[0])
  })

  it('never puts the key anywhere a file or an env dump would show it', () => {
    // A source scan, which is weak evidence in general and the right kind here:
    // what it guards is that nobody adds the convenient line. The key is
    // referenced by exactly one name, so every use of it is greppable.
    const source = readFileSync(resolve(__dirname, 'backend.ts'), 'utf8')
    const uses = source.split('\n').filter((line) => line.includes('confirmKey'))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line).not.toMatch(/env\[|env\.|process\.env|writeFile|writeFileSync|appendFile/)
    }
  })

  it('signs the same bytes the backend verifies', () => {
    // The one place two languages have to agree. If either side's payload
    // changes shape, every trust action starts refusing and nothing else here
    // would say why - so this recomputes the backend's formula independently
    // rather than calling the same helper.
    const writes: string[] = []
    handConfirmKey({
      stdin: { write: (s: string) => writes.push(s), end: () => {} },
    } as unknown as Parameters<typeof handConfirmKey>[0], 'host-token')
    const key = writes[0].split('\n')[0].split(' ')[0]

    const token = mintTrustConfirmation('p2p.trust.device.approve', 'dev-1', 'subject-1')
    expect(token).not.toBeNull()
    const payload = [
      'navide/trust-confirm/v2',
      token!.nonce,
      token!.expires,
      'p2p.trust.device.approve',
      'dev-1',
      'subject-1',
    ].join('\u0000')
    expect(token!.mac).toBe(createHmac('sha256', key).update(payload).digest('hex'))
  })

  it('binds the action and the device, so one token cannot stand in for another', () => {
    handConfirmKey({
      stdin: { write: () => {}, end: () => {} },
    } as unknown as Parameters<typeof handConfirmKey>[0], 'host-token')
    const approve = mintTrustConfirmation('p2p.trust.device.approve', 'dev-1')!
    const block = mintTrustConfirmation('p2p.trust.block', 'dev-1')!
    const other = mintTrustConfirmation('p2p.trust.device.approve', 'dev-2')!
    const subjectA = mintTrustConfirmation('p2p.policy.set', '', '{"default":"deny"}')!
    const subjectB = mintTrustConfirmation('p2p.policy.set', '', '{"default":"allow"}')!
    expect(new Set([approve.mac, block.mac, other.mac, subjectA.mac, subjectB.mac]).size).toBe(5)
    // And a fresh nonce each time, which is what makes one-time use possible.
    expect(approve.nonce).not.toBe(other.nonce)
  })
})


// -- PATH handling ------------------------------------------------------------

describe('pathEnvKey', () => {
  it('returns the key the environment actually uses, whatever its case', () => {
    // Windows spells it `Path`; a spread copy of process.env keeps that
    // spelling and is a plain object, so `env.PATH` there is undefined.
    expect(pathEnvKey({ Path: 'C:\\Windows' })).toBe('Path')
    expect(pathEnvKey({ PATH: '/usr/bin' })).toBe('PATH')
  })

  it('falls back to PATH when the environment has none', () => {
    expect(pathEnvKey({ HOME: '/home/x' })).toBe('PATH')
  })
})

describe('mergePathList', () => {
  it('puts the head first, keeps what was there, and deduplicates', () => {
    expect(mergePathList(['/opt/homebrew/bin', '/usr/bin'], ['/usr/bin', '/bin'].join(delimiter))).toBe(
      ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter)
    )
  })

  it('joins with the platform delimiter rather than a literal colon', () => {
    // On Windows ':' is part of every entry (`C:\...`); only path.delimiter
    // is safe on both sides.
    expect(mergePathList(['a', 'b'], undefined)).toBe(`a${delimiter}b`)
  })

  it('drops empty segments from the existing value', () => {
    expect(mergePathList(['a'], `${delimiter}${delimiter}b${delimiter}`)).toBe(`a${delimiter}b`)
  })
})

// -- Stopping the backend -----------------------------------------------------

type FakeProc = EventEmitter & {
  pid: number
  exitCode: number | null
  kill: ReturnType<typeof vi.fn>
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = 4102
  proc.exitCode = null
  proc.kill = vi.fn(() => true)
  proc.stdin = { write: vi.fn(() => true), end: vi.fn() }
  return proc
}

const asChild = (proc: FakeProc): ChildProcess => proc as unknown as ChildProcess

describe('stopBackendProcess', () => {
  afterEach(() => {
    killProcessTree.mockReset()
    setPlatformId(BASELINE)
    vi.useRealTimers()
  })

  it('asks the backend to shut itself down on POSIX and waits for exit', async () => {
    setPlatformId('darwin')
    const proc = fakeProc()
    const stopped = stopBackendProcess(asChild(proc))
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(killProcessTree).not.toHaveBeenCalled()
    proc.exitCode = 0
    proc.emit('exit', 0)
    await expect(stopped).resolves.toBeUndefined()
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('takes the tree down by name when the POSIX grace period runs out', async () => {
    vi.useFakeTimers()
    setPlatformId('linux')
    const proc = fakeProc()
    const stopped = stopBackendProcess(asChild(proc))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(stopped).resolves.toBeUndefined()
    expect(killProcessTree).toHaveBeenCalledWith(4102, 'SIGKILL')
  })

  it('resolves at once for a backend that already exited', async () => {
    const proc = fakeProc()
    proc.exitCode = 1
    await expect(stopBackendProcess(asChild(proc))).resolves.toBeUndefined()
    expect(proc.kill).not.toHaveBeenCalled()
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  // On Windows proc.kill is TerminateProcess on the bootloader alone, which
  // fires 'exit' at once and would clear the timer before the tree kill ever
  // ran — so the graceful ask goes over stdin instead, and the timer still
  // tree-kills a backend that does not exit in time.
  it('asks over stdin on Windows and waits for exit', async () => {
    setPlatformId('win32')
    const proc = fakeProc()
    const stopped = stopBackendProcess(asChild(proc))
    expect(proc.kill).not.toHaveBeenCalled()
    expect(proc.stdin.write).toHaveBeenCalledWith('shutdown\n')
    expect(proc.stdin.end).toHaveBeenCalled()
    expect(killProcessTree).not.toHaveBeenCalled()
    proc.exitCode = 0
    proc.emit('exit', 0)
    await expect(stopped).resolves.toBeUndefined()
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('tree-kills a Windows backend that ignores the stdin ask', async () => {
    vi.useFakeTimers()
    setPlatformId('win32')
    const proc = fakeProc()
    const stopped = stopBackendProcess(asChild(proc))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(stopped).resolves.toBeUndefined()
    expect(killProcessTree).toHaveBeenCalledWith(4102, 'SIGKILL')
  })
})

// -- Spawn options ------------------------------------------------------------

describe('backend spawn options', () => {
  // startBackend spawns a real child and needs Electron's `app`, so like the
  // confirm-key check above this reads the source: both spawn calls (packaged
  // exe and dev `uv`) must hide the console window Windows would otherwise
  // pop up behind the app for a console-subsystem child.
  it('hides the console window on both spawn paths', () => {
    const source = readFileSync(resolve(__dirname, 'backend.ts'), 'utf8')
    const spawnCalls = source.split(/\bspawn\(/).slice(1)
    expect(spawnCalls).toHaveLength(2)
    for (const call of spawnCalls) {
      const options = call.slice(0, call.indexOf('\n  }') + 1 || undefined)
      expect(options).toContain('windowsHide: true')
    }
  })

  it('never splits or joins PATH on a literal colon', () => {
    const source = readFileSync(resolve(__dirname, 'backend.ts'), 'utf8')
    expect(source).not.toMatch(/split\(':'\)|join\(':'\)/)
  })
})

describe('proveWindow', () => {
  it('matches the vector the backend checks (test_ws_auth WINDOW_PROOF_VECTOR)', () => {
    expect(proveWindow('host-secret', 'nonce-1')).toBe('a4c453f892421e367a36312ee518ccbca38a442e010fc441ed351d433ec3d0f6')
  })

  it('binds the per-connection nonce, so one proof cannot answer another challenge', () => {
    expect(proveWindow('host-secret', 'nonce-1')).not.toBe(proveWindow('host-secret', 'nonce-2'))
  })
})
