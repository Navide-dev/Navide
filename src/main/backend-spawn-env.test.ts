import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// R3-M2: the host token used to ride in the backend's spawn environment, which
// on macOS any same-uid process reads with `ps -E` even after the backend pops
// it. It now goes over stdin, second line after the confirm key. This drives
// startBackend for real (spawn faked) on both spawn paths -- packaged and dev;
// the crash auto-restart respawn calls the same startBackend -- and checks the
// env each one hands the child.

const electron = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getPath: (name: string) => `/fake/${name}`,
    getAppPath: () => '/fake/app',
  },
}))

const killProcessTree = vi.hoisted(() => vi.fn())
vi.mock('./process-tree', () => ({ killProcessTree }))

const spawned = vi.hoisted(() => [] as Array<{ env: Record<string, string | undefined>; stdin: string[] }>)
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    // The login-shell PATH probe: answer "no shell" so the fallback runs.
    execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(new Error('no shell')),
    spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
      const stdin: string[] = []
      spawned.push({ env: { ...opts.env }, stdin })
      const proc = Object.assign(new EventEmitter(), {
        pid: 4242,
        exitCode: null,
        kill: () => true,
        stdin: Object.assign(new EventEmitter(), { write: (s: string) => stdin.push(s), end: () => {} }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      return proc
    },
  }
})

import { startBackend } from './backend'

const CATALOG = { path: '/fake/catalog.json', sha256: 'a'.repeat(64) }

describe('backend spawn environment (R3-M2)', () => {
  beforeEach(() => {
    spawned.length = 0
    // Only Electron defines it; the packaged path joins the exe path under it.
    ;(process as { resourcesPath?: string }).resourcesPath = '/fake/resources'
  })

  for (const isPackaged of [true, false]) {
    it(`never carries the host token in the env (${isPackaged ? 'packaged' : 'dev'})`, async () => {
      electron.isPackaged = isPackaged
      process.env.NAVIDE_BACKEND_HOST_TOKEN = 'inherited-from-a-stale-launcher'
      try {
        // A zero health timeout fails the start right after the spawn, which is
        // all this needs to see.
        await expect(startBackend(0, CATALOG)).rejects.toThrow(/did not become healthy/)
      } finally {
        delete process.env.NAVIDE_BACKEND_HOST_TOKEN
      }
      expect(spawned).toHaveLength(1)
      const { env, stdin } = spawned[0]
      expect(Object.keys(env).filter((k) => k.toUpperCase().includes('HOST_TOKEN'))).toEqual([])
      // Both credentials went over stdin instead: confirm key, then host token.
      const lines = stdin.join('').split('\n')
      expect(lines[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(lines[1]).toMatch(/^[A-Za-z0-9_-]{43}$/)
      for (const value of Object.values(env)) expect(value).not.toContain(lines[1])
    })
  }
})
