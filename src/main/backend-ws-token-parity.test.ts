import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'

// The invariant under test: the file main reads the ws token FROM is the file
// the backend writes it TO. Both sides derive the path independently — TS in
// resolveBackendDataDir, Python in applog/osplat — so the only honest check
// runs the Python side for real and compares. A packaged Linux build shipped
// with the two disagreeing (main: ~/.config, backend: ~/.local/share) and
// every window was refused; a test that only pinned the TS string would have
// been green the whole time.

const HOME = { posix: '/home/parity', win32: 'C:\\Users\\parity' }

const electron = vi.hoisted(() => ({
  isPackaged: true,
  platform: 'linux' as NodeJS.Platform,
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getPath(name: string): string {
      const p = electron.platform
      if (name === 'home') return p === 'win32' ? HOME.win32 : HOME.posix
      if (name === 'appData') {
        // What Electron's app.getPath('appData') answers on each platform.
        if (p === 'darwin') return posix.join(HOME.posix, 'Library', 'Application Support')
        if (p === 'win32') return win32.join(HOME.win32, 'AppData', 'Roaming')
        return posix.join(HOME.posix, '.config')
      }
      throw new Error(`unexpected app.getPath(${name})`)
    },
  },
}))

import { backendDataDir, wsTokenPath } from './backend'

type Vars = Record<string, string | undefined>

// The backend's own interpreter, run directly — never through `uv run`, which
// syncs the environment first: in a worktree without one it built a fresh
// .venv, and run against a shared one it rewrote the editable install's .pth
// to point at whichever checkout ran last. CI syncs before the suite starts
// (ci.yml "Install locked dependencies"); locally, sync once by hand.
const python = resolve('backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

/**
 * Ask the backend where it writes the ws token, with HOME and the XDG /
 * Windows base variables pinned. `layout` selects an osplat implementation
 * explicitly ('host' is whatever this machine selects — the packaged case).
 */
function pythonWsTokenPath(layout: 'host' | 'linux', vars: Vars): string {
  expect(existsSync(python), 'run uv --project backend sync --locked first').toBe(true)
  const script = `
import json, os, sys
vars = json.loads(os.environ["NAVIDE_PARITY_VARS"])
for key in ("AGENT_TEAM_DATA_DIR", "XDG_DATA_HOME", "APPDATA"):
    os.environ.pop(key, None)
os.environ["HOME"] = vars["HOME"]
os.environ["USERPROFILE"] = vars["HOME"]
for key, value in vars.items():
    if key != "HOME" and value is not None:
        os.environ[key] = value
layout = ${JSON.stringify(layout)}
if layout == "host":
    from agent_team_backend import applog
    print(applog.backend_ws_token_file())
else:
    from agent_team_backend.osplat import _linux
    print(_linux.LinuxLayout().state_dir("Agent-Team") / "backend-ws-token")
`
  return execFileSync(python, ['-'], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, NAVIDE_PARITY_VARS: JSON.stringify(vars) },
    timeout: 60_000,
  }).trim()
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  electron.platform = platform
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
    electron.platform = 'linux'
  }
}

// Every test here shells out to the backend's python, and the helper already
// budgets 60s for that. Vitest's own per-test default is 5s, and that is the
// one that governs: on a Windows runner a cold `uv` (venv resolution, then an
// interpreter start) took the file 5573ms and the first test was killed
// mid-call (main f9e7a3b7). Say the same number on both sides, so the outcome
// stops depending on how busy the runner was.
const PYTHON_PROBE_TIMEOUT_MS = 60_000

describe('ws token path parity (main reads where the backend writes)', () => {
  afterEach(() => {
    electron.isPackaged = true
  })

  it('agrees with the backend on this platform for a packaged app', () => {
    const home = process.platform === 'win32' ? HOME.win32 : HOME.posix
    const expected = pythonWsTokenPath('host', { HOME: home })
    const actual = withPlatform(process.platform, () => wsTokenPath(backendDataDir({})))
    expect(actual).toBe(expected)
  }, PYTHON_PROBE_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('agrees with the Linux layout, default XDG', () => {
    const expected = pythonWsTokenPath('linux', { HOME: HOME.posix })
    const actual = withPlatform('linux', () => wsTokenPath(backendDataDir({})))
    expect(actual).toBe(expected)
    // The bug this guards: main used to read under appData (~/.config).
    expect(actual).not.toContain('/.config/')
  }, PYTHON_PROBE_TIMEOUT_MS)

  it.skipIf(process.platform === 'win32')('agrees with the Linux layout when XDG_DATA_HOME is set', () => {
    const xdg = '/mnt/state/xdg-data'
    const expected = pythonWsTokenPath('linux', { HOME: HOME.posix, XDG_DATA_HOME: xdg })
    const actual = withPlatform('linux', () => wsTokenPath(backendDataDir({ XDG_DATA_HOME: xdg })))
    expect(actual).toBe(expected)
  }, PYTHON_PROBE_TIMEOUT_MS)

  it('honours AGENT_TEAM_DATA_DIR on both sides (the dev-mode contract)', () => {
    const override = process.platform === 'win32' ? 'C:\\navide-dev-state' : '/tmp/navide-dev-state'
    const home = process.platform === 'win32' ? HOME.win32 : HOME.posix
    const expected = pythonWsTokenPath('host', { HOME: home, AGENT_TEAM_DATA_DIR: override })
    electron.isPackaged = false
    const actual = withPlatform(process.platform, () =>
      wsTokenPath(backendDataDir({ AGENT_TEAM_DATA_DIR: override }))
    )
    expect(actual).toBe(expected)
  }, PYTHON_PROBE_TIMEOUT_MS)
})
