import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_NO_PERMISSION, FnKeyService, parseFnKeyLine, RESPAWN_BACKOFF_MS, type FnKeyLine } from './fn-key-helper'
import { FN_KEY_EVENT_CHANNEL, FN_KEY_STATUS_CHANNEL } from '../shared/fnKey'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid: number | undefined = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed: NodeJS.Signals[] = []
  kill(sig: NodeJS.Signals): boolean {
    this.killed.push(sig)
    return true
  }
  line(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function setup(opts: { supported?: boolean; path?: string | null; query?: FnKeyLine | null } = {}) {
  const children: FakeChild[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let now = 0
  const spawn = vi.fn(() => {
    const c = new FakeChild()
    children.push(c)
    return c as unknown as ChildProcess
  })
  const query = vi.fn(async () => (opts.query === undefined ? null : opts.query))
  const service = new FnKeyService({
    supported: opts.supported ?? true,
    helperPath: () => (opts.path === undefined ? '/bin/navide-fn-key' : opts.path),
    spawn,
    query,
    log: () => {},
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const received: Array<[string, unknown]> = []
  const sub = { id: 1, send: (channel: string, payload: unknown) => received.push([channel, payload]) }
  const events = () => received.filter(([c]) => c === FN_KEY_EVENT_CHANNEL).map(([, p]) => (p as { type: string }).type)
  const phases = () => received.filter(([c]) => c === FN_KEY_STATUS_CHANNEL).map(([, p]) => (p as { phase: string }).phase)
  return {
    service,
    spawn,
    query,
    children,
    timers,
    sub,
    events,
    phases,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('parseFnKeyLine', () => {
  it('reads each event the helper prints and nothing else', () => {
    expect(parseFnKeyLine('{"event":"down"}')).toEqual({ event: 'down' })
    expect(parseFnKeyLine('{"event":"up"}')).toEqual({ event: 'up' })
    expect(parseFnKeyLine('{"event":"chord"}')).toEqual({ event: 'chord' })
    expect(parseFnKeyLine('{"event":"ready","fnUsage":2}')).toEqual({ event: 'ready', fnUsage: 2 })
    expect(parseFnKeyLine('{"event":"status","granted":true,"fnUsage":0}')).toEqual({ event: 'status', granted: true, fnUsage: 0 })
    expect(parseFnKeyLine('{"event":"permission","granted":false}')).toEqual({ event: 'permission', granted: false })
    expect(parseFnKeyLine('{"event":"reenabled","reason":"timeout"}')).toEqual({ event: 'reenabled', reason: 'timeout' })
    expect(parseFnKeyLine('{"event":"ready"}')).toEqual({ event: 'ready', fnUsage: -1 })
    expect(parseFnKeyLine('garbage')).toBeNull()
    expect(parseFnKeyLine('{"event":"explode"}')).toBeNull()
    expect(parseFnKeyLine('null')).toBeNull()
  })
})

describe('FnKeyService', () => {
  it('spawns nothing until someone subscribes', () => {
    const t = setup()
    expect(t.spawn).not.toHaveBeenCalled()
    expect(t.service.getStatus()).toEqual({ phase: 'off', fnUsage: null })
  })

  it('off macOS: subscribing spawns nothing', () => {
    const t = setup({ supported: false })
    expect(t.service.subscribe(t.sub).phase).toBe('unsupported')
    expect(t.spawn).not.toHaveBeenCalled()
  })

  it('relays down / up / chord (split across chunks) and reports ready with the 🌐 setting', async () => {
    const t = setup()
    t.service.subscribe(t.sub)
    expect(t.spawn).toHaveBeenCalledTimes(1)
    const c = t.children[0]
    c.line({ event: 'ready', fnUsage: 1 })
    c.stdout.write('{"event":"do')
    c.stdout.write('wn"}\n{"event":"up"}\n{"event":"chord"}\n')
    await flush()
    expect(t.events()).toEqual(['down', 'up', 'chord'])
    expect(t.service.getStatus()).toEqual({ phase: 'ready', fnUsage: 1 })
  })

  it('a second subscriber shares the helper; the last one leaving stops it by its own handle', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.service.subscribe({ id: 2, send: () => {} })
    expect(t.spawn).toHaveBeenCalledTimes(1)
    t.service.unsubscribe(1)
    expect(t.children[0].killed).toEqual([])
    t.service.unsubscribe(2)
    expect(t.children[0].killed).toEqual(['SIGTERM'])
    expect(t.service.isRunning()).toBe(false)
    expect(t.service.getStatus().phase).toBe('off')
  })

  it('quitting stops the helper by its own handle', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.service.dispose()
    expect(t.children[0].killed).toEqual(['SIGTERM'])
    expect(t.service.isRunning()).toBe(false)
  })

  it('no Input Monitoring: says so and does not respawn until access is requested', async () => {
    const t = setup({ query: { event: 'status', granted: true, fnUsage: 0 } })
    t.service.subscribe(t.sub)
    t.children[0].line({ event: 'permission', granted: false })
    await flush()
    t.children[0].exit(EXIT_NO_PERMISSION)
    expect(t.service.getStatus().phase).toBe('no-permission')
    expect(t.timers).toEqual([])
    t.service.subscribe(t.sub)
    expect(t.spawn).toHaveBeenCalledTimes(1)
    await t.service.requestPermission()
    expect(t.query).toHaveBeenCalledWith('/bin/navide-fn-key', '--request')
    expect(t.spawn).toHaveBeenCalledTimes(2)
  })

  it('access still refused: stays in no-permission', async () => {
    const t = setup({ query: { event: 'status', granted: false, fnUsage: 0 } })
    t.service.subscribe(t.sub)
    t.children[0].exit(EXIT_NO_PERMISSION)
    expect((await t.service.requestPermission()).phase).toBe('no-permission')
    expect(t.spawn).toHaveBeenCalledTimes(1)
  })

  it('asking for access that gets no answer (helper failed or timed out) says so instead of nothing', async () => {
    const t = setup({ query: null })
    t.service.subscribe(t.sub)
    t.children[0].exit(EXIT_NO_PERMISSION)
    expect((await t.service.requestPermission()).phase).toBe('request-failed')
    expect(t.phases().at(-1)).toBe('request-failed')
    expect(t.spawn).toHaveBeenCalledTimes(1)
  })

  it('a crash respawns with backoff, and gives up after the last step', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    for (let i = 0; i < RESPAWN_BACKOFF_MS.length; i++) {
      t.children[i].exit(null, 'SIGSEGV')
      expect(t.service.getStatus().phase).toBe('restarting')
      expect(t.timers).toHaveLength(1)
      expect(t.timers[0].ms).toBe(RESPAWN_BACKOFF_MS[i])
      t.timers.shift()!.fn()
      expect(t.spawn).toHaveBeenCalledTimes(i + 2)
    }
    t.children.at(-1)!.exit(1)
    expect(t.service.getStatus().phase).toBe('failed')
    expect(t.timers).toEqual([])
    // A crash sends an up, so no take is left waiting for one.
    expect(t.events().every((e) => e === 'up')).toBe(true)
  })

  it('a helper that cannot be started (not executable) is a crash, not a start that never ends', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    // What Node does for EACCES / ENOENT: no pid, 'error' then 'close', never 'exit'.
    const c = t.children[0]
    c.pid = undefined
    c.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    c.emit('close', -13, null)
    expect(t.service.isRunning()).toBe(false)
    expect(t.service.getStatus().phase).toBe('restarting')
    expect(t.timers).toHaveLength(1)
    t.timers.shift()!.fn()
    expect(t.spawn).toHaveBeenCalledTimes(2)
  })

  it('a helper that ran a while before crashing starts the backoff over', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.children[0].exit(1)
    t.timers.shift()!.fn()
    t.advance(120_000)
    t.children[1].exit(1)
    expect(t.timers[0].ms).toBe(RESPAWN_BACKOFF_MS[0])
  })

  it('unsubscribing during a backoff cancels the respawn', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.children[0].exit(1)
    t.service.unsubscribe(1)
    expect(t.timers).toEqual([])
    expect(t.service.getStatus().phase).toBe('off')
  })

  it('a missing helper binary says missing (not a crash) without spawning, and a later subscribe looks again', () => {
    let path: string | null = null
    const t = setup()
    const service = new FnKeyService({
      supported: true,
      helperPath: () => path,
      spawn: t.spawn,
      query: t.query,
      log: () => {},
    })
    const seen: string[] = []
    expect(service.subscribe({ id: 1, send: (c, p) => c === FN_KEY_STATUS_CHANNEL && seen.push((p as { phase: string }).phase) }).phase).toBe('missing')
    expect(seen).toEqual(['missing'])
    expect(t.spawn).not.toHaveBeenCalled()
    // Built meanwhile (pnpm build:fn-key): the next subscribe (Try again) starts it.
    path = '/bin/navide-fn-key'
    service.unsubscribe(1)
    expect(service.subscribe({ id: 1, send: () => {} }).phase).toBe('starting')
    expect(t.spawn).toHaveBeenCalledTimes(1)
  })

  it('one renderer holding two subscriptions (voice wiring and a recorder) keeps the helper until both let go', () => {
    const t = setup()
    t.service.subscribe(t.sub) // the wiring: fn is bound
    t.service.subscribe(t.sub) // a recorder in the same window
    expect(t.spawn).toHaveBeenCalledTimes(1)
    t.service.unsubscribe(1) // the recorder is done
    expect(t.service.isRunning()).toBe(true)
    expect(t.children[0].killed).toEqual([])
    t.service.unsubscribe(1)
    expect(t.children[0].killed).toEqual(['SIGTERM'])
    expect(t.service.getStatus().phase).toBe('off')
  })

  it('a renderer that is destroyed or reloads drops every subscription it held', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.service.subscribe(t.sub)
    t.service.drop(1)
    expect(t.children[0].killed).toEqual(['SIGTERM'])
    expect(t.service.isRunning()).toBe(false)
    // Counted from zero again afterwards.
    t.service.subscribe(t.sub)
    t.service.unsubscribe(1)
    expect(t.children[1].killed).toEqual(['SIGTERM'])
  })

  it('a stale unsubscribe from a renderer that holds nothing changes nothing', () => {
    const t = setup()
    t.service.subscribe(t.sub)
    t.service.unsubscribe(2)
    expect(t.service.isRunning()).toBe(true)
  })
})

// `pnpm dev` never ran `pnpm build`, so a checkout's fn toggle once had no
// helper at all and nothing said so.
describe('fn-key helper in a dev checkout', () => {
  const root = resolve(__dirname, '..', '..')

  it('pnpm dev builds the helper when it is missing or stale, and a failure does not stop dev', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const dev = pkg.scripts.dev
    expect(dev).toContain('node scripts/build-fn-key-helper.mjs --if-needed')
    expect(dev.indexOf('build-fn-key-helper.mjs')).toBeLessThan(dev.indexOf('electron-vite dev'))
    const script = readFileSync(join(root, 'scripts', 'build-fn-key-helper.mjs'), 'utf8')
    expect(script).toMatch(/if \(ifNeeded\) \{\s*try \{\s*build\(\)\s*\} catch/)
  })
})

// The real helper, on a Mac: the lone-fn logic tests, and the binary's
// non-interactive modes (no key can be pressed here).
describe.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/cc'))('native fn-key helper', () => {
  const src = resolve(__dirname, '..', '..', 'native', 'fn-key')

  it('fn_logic_test.c passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fn-key-test-'))
    try {
      const bin = join(dir, 'fn_logic_test')
      execFileSync('cc', ['-Wall', '-Wextra', '-Werror', '-o', bin, join(src, 'fn_logic_test.c')])
      expect(execFileSync(bin, { encoding: 'utf8' })).toContain('all tests passed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('main.c builds warning-free and --check answers one status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fn-key-test-'))
    try {
      const bin = join(dir, 'navide-fn-key')
      execFileSync('cc', ['-Wall', '-Wextra', '-Werror', '-framework', 'ApplicationServices', '-framework', 'CoreFoundation', '-o', bin, join(src, 'main.c')])
      const out = execFileSync(bin, ['--check'], { encoding: 'utf8' }).trim()
      const parsed = parseFnKeyLine(out)
      expect(parsed?.event).toBe('status')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
