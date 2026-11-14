import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// child_process is mocked at module level so no terminal ever actually opens
// during the suite; each test decides what `spawn` pretends happened.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { normalizePlatformId, platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import * as terminal from './external-terminal'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

// The real filesystem the suite runs on: NTFS has no executable bit to withhold.
const hostIsWindows = normalizePlatformId(process.platform) === 'win32'

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn> }

// Created at spawn() time, never ahead of it: the event fires on a microtask,
// and a child built while setting up a mock chain would emit before the
// code under test has attached its listeners.
function fakeChild(outcome: 'spawn' | 'error' | { close: number } | { exit: number }): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.unref = vi.fn()
  queueMicrotask(() => {
    if (outcome === 'spawn') child.emit('spawn')
    else if (outcome === 'error') child.emit('error', new Error('spawn ENOENT'))
    else if ('exit' in outcome) {
      child.emit('spawn')
      child.emit('exit', outcome.exit)
    } else child.emit('close', outcome.close)
  })
  return child
}

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

beforeEach(() => spawnMock.mockReset())
afterEach(() => {
  setPlatformId(BASELINE)
  vi.restoreAllMocks()
})

const on = (id: PlatformId): void => setPlatformId(id)

/** A directory holding executable stand-ins for the named emulators. */
function binDirWith(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-term-'))
  for (const name of names) {
    const file = join(dir, name)
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
  }
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The same, but without the executable bit — what every file is on Windows. */
function plainDirWith(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-term-'))
  for (const name of names) writeFileSync(join(dir, name), '')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

describe('findOnPath', () => {
  it('returns null when the binary is on no PATH entry', () => {
    expect(terminal.findOnPath('definitely-not-a-real-binary-xyz', '/nonexistent')).toBeNull()
  })

  it('finds an executable that is present', () => {
    on('darwin')
    const dir = binDirWith('tool')
    expect(terminal.findOnPath('tool', dir)).toBe(join(dir, 'tool'))
  })

  it('skips empty PATH segments instead of probing the cwd', () => {
    expect(terminal.findOnPath('sh', '::/nonexistent::')).toBeNull()
  })

  // chmod cannot withhold an executable bit NTFS does not have.
  it.skipIf(hostIsWindows)('requires the executable bit on POSIX', () => {
    on('linux')
    expect(terminal.findOnPath('tool', plainDirWith('tool'))).toBeNull()
  })

  describe('on Windows', () => {
    // `code` on a Windows PATH is `code.cmd`, `wt` is `wt.exe`; cmd.exe
    // resolves a bare name through PATHEXT and so must this.
    it('finds a command through its PATHEXT suffix', () => {
      on('win32')
      const dir = plainDirWith('code.cmd')
      expect(terminal.findOnPath('code', dir)).toBe(join(dir, 'code.cmd'))
    })

    it('tries the bare name before the suffixes', () => {
      on('win32')
      const dir = plainDirWith('wt.exe')
      expect(terminal.findOnPath('wt.exe', dir)).toBe(join(dir, 'wt.exe'))
      expect(terminal.findOnPath('wt', dir)).toBe(join(dir, 'wt.exe'))
    })

    it('does not rely on an executable bit that Windows does not have', () => {
      on('win32')
      const dir = plainDirWith('tool.exe')
      expect(terminal.findOnPath('tool', dir)).toBe(join(dir, 'tool.exe'))
    })

    it('does not treat a PATHEXT suffix as a hit off Windows', () => {
      on('linux')
      const dir = binDirWith('code.cmd')
      expect(terminal.findOnPath('code', dir)).toBeNull()
    })
  })
})

describe('openInExternalTerminal', () => {
  describe('on macOS', () => {
    it('drives Terminal.app through osascript, exactly as before', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 0 }))
      await expect(terminal.openInExternalTerminal('brew install uv')).resolves.toEqual({ ok: true })
      const [bin, argv] = spawnMock.mock.calls[0]
      expect(bin).toBe('osascript')
      expect(argv[1]).toContain('tell application "Terminal" to do script "brew install uv"')
    })

    it('AppleScript-escapes quotes and backslashes in the command', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 0 }))
      await terminal.openInExternalTerminal('echo "hi" \\ there')
      const script: string = spawnMock.mock.calls[0][1][1]
      expect(script).toContain('do script "echo \\"hi\\" \\\\ there"')
    })

    it('reports a non-zero osascript exit as a failure', async () => {
      on('darwin')
      spawnMock.mockImplementation(() => fakeChild({ close: 1 }))
      await expect(terminal.openInExternalTerminal('x')).resolves.toEqual({
        ok: false,
        error: 'osascript exited 1',
      })
    })
  })

  describe('on Linux', () => {
    // A display and a short failure window: the real one (800ms) would make
    // every success case wait that long, and the window is what is under test
    // only where a test says so.
    const display = { DISPLAY: ':0' }
    const open = (command: string, path: string | undefined, env: NodeJS.ProcessEnv = display) =>
      terminal.openInExternalTerminal(command, path, { env, failureWindowMs: 5 })

    // The bug this fixes: every needs_terminal install (fourteen agent CLIs
    // plus Ollama) went through osascript, which does not exist on Linux.
    it('never touches osascript', async () => {
      on('linux')
      await open('x', binDirWith())
      for (const call of spawnMock.mock.calls) expect(call[0]).not.toBe('osascript')
    })

    it('launches the first emulator on PATH and hands the command to bash -c verbatim', async () => {
      on('linux')
      // x-terminal-emulator absent, gnome-terminal present: the second entry wins.
      const bin = binDirWith('gnome-terminal', 'xterm')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      const command = 'curl -fsSL https://ollama.com/install.sh | sh'
      await expect(open(command, bin)).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, 'gnome-terminal'))
      // argv form, not a quoted string: the command reaches bash unmangled.
      expect(argv.slice(0, 3)).toEqual(['--', 'bash', '-c'])
      // The shell stays open afterwards, as Terminal.app's `do script` does.
      expect(argv[3]).toBe(`${command}; exec bash`)
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    })

    it('prefers the Debian alternatives symlink over guessing the desktop', async () => {
      on('linux')
      const bin = binDirWith('x-terminal-emulator', 'gnome-terminal', 'konsole')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await open('x', bin)
      expect(spawnMock.mock.calls[0][0]).toBe(join(bin, 'x-terminal-emulator'))
    })

    it('does not hold the reply open while the install runs', async () => {
      on('linux')
      let child!: FakeChild
      spawnMock.mockImplementation(() => (child = fakeChild('spawn')))
      await open('sleep 600', binDirWith('xterm'))
      expect(child.unref).toHaveBeenCalledTimes(1)
    })

    it('falls through to the next emulator when one is on PATH but will not start', async () => {
      on('linux')
      const bin = binDirWith('x-terminal-emulator', 'konsole')
      spawnMock
        .mockImplementationOnce(() => fakeChild('error'))
        .mockImplementationOnce(() => fakeChild('spawn'))
      await expect(open('x', bin)).resolves.toEqual({ ok: true })
      expect(spawnMock.mock.calls.map((c) => c[0])).toEqual([
        join(bin, 'x-terminal-emulator'),
        join(bin, 'konsole'),
      ])
    })

    it('names every emulator it tried when none is available', async () => {
      on('linux')
      const result = await open('x', binDirWith())
      expect(result.ok).toBe(false)
      for (const name of ['xdg-terminal-exec', 'x-terminal-emulator', 'gnome-terminal', 'ptyxis', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'foot', 'xterm']) {
        expect(result.error).toContain(name)
      }
      expect(spawnMock).not.toHaveBeenCalled()
    })

    // The lie this closes: gnome-terminal is a D-Bus client that forks fine
    // and only then exits 1 with no session bus or display; resolving on the
    // 'spawn' event reported success over a headless SSH session.
    it('refuses without a display instead of reporting a window that never opened', async () => {
      on('linux')
      const result = await open('x', binDirWith('gnome-terminal'), { HOME: '/home/x' })
      expect(result).toEqual({ ok: false, error: expect.stringContaining('DISPLAY') })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('accepts WAYLAND_DISPLAY alone as a display', async () => {
      on('linux')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await expect(open('x', binDirWith('foot'), { WAYLAND_DISPLAY: 'wayland-0' })).resolves.toEqual({ ok: true })
    })

    it('treats a non-zero exit inside the failure window as "could not open", and moves on', async () => {
      on('linux')
      const bin = binDirWith('gnome-terminal', 'xterm')
      spawnMock
        .mockImplementationOnce(() => fakeChild({ exit: 1 }))
        .mockImplementationOnce(() => fakeChild('spawn'))
      await expect(open('x', bin)).resolves.toEqual({ ok: true })
      expect(spawnMock.mock.calls.map((c) => c[0])).toEqual([join(bin, 'gnome-terminal'), join(bin, 'xterm')])
    })

    it('reports every emulator that started and died when none stays up', async () => {
      on('linux')
      const bin = binDirWith('gnome-terminal', 'xterm')
      spawnMock.mockImplementation(() => fakeChild({ exit: 1 }))
      const result = await open('x', bin)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('gnome-terminal exited 1')
      expect(result.error).toContain('xterm exited 1')
    })

    it('counts an immediate exit 0 as opened — a hand-off to a running instance', async () => {
      on('linux')
      spawnMock.mockImplementation(() => fakeChild({ exit: 0 }))
      await expect(open('x', binDirWith('gnome-terminal'))).resolves.toEqual({ ok: true })
    })

    it('honours $TERMINAL first, with its own argv form when the table knows it', async () => {
      on('linux')
      const bin = binDirWith('x-terminal-emulator', 'kitty')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await open('x', bin, { ...display, TERMINAL: 'kitty' })
      const [exe, argv] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, 'kitty'))
      expect(argv.slice(0, 2)).toEqual(['bash', '-c'])
    })

    it('gives an unknown $TERMINAL the common -e form', async () => {
      on('linux')
      const bin = binDirWith('my-term')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await open('x', bin, { ...display, TERMINAL: 'my-term' })
      expect(spawnMock.mock.calls[0][1].slice(0, 3)).toEqual(['-e', 'bash', '-c'])
    })

    it('asks xdg-terminal-exec before guessing from the table', async () => {
      on('linux')
      const bin = binDirWith('xdg-terminal-exec', 'x-terminal-emulator')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await open('x', bin)
      expect(spawnMock.mock.calls[0][0]).toBe(join(bin, 'xdg-terminal-exec'))
    })

    // Fedora 41+ ships ptyxis and no gnome-terminal; XFCE and the Wayland
    // tiling set were "no terminal emulator found" with the four-entry table.
    it.each([
      ['ptyxis', ['--', 'bash', '-c']],
      ['xfce4-terminal', ['-x', 'bash', '-c']],
      ['alacritty', ['-e', 'bash', '-c']],
      ['wezterm', ['start', '--', 'bash', '-c']],
      ['foot', ['bash', '-c']],
    ])('finds %s and passes the command as argv', async (name, prefix) => {
      on('linux')
      const bin = binDirWith(name)
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await expect(open('x', bin)).resolves.toEqual({ ok: true })
      const [exe, argv] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, name))
      expect(argv.slice(0, prefix.length)).toEqual(prefix)
    })

    it('hands the emulator the resolved PATH so the install can find nvm-provided npm', async () => {
      on('linux')
      const bin = binDirWith('xterm')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await open('npm install -g @openai/codex', bin)
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ env: { DISPLAY: ':0', PATH: bin } })
    })
  })

  describe('on Windows', () => {
    it('prefers Windows Terminal when it is on PATH', async () => {
      on('win32')
      const bin = plainDirWith('wt.exe')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      const command = 'winget install --id OpenAI.Codex'
      await expect(terminal.openInExternalTerminal(command, bin)).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe(join(bin, 'wt.exe'))
      // argv form: the command reaches PowerShell unmangled, and -NoExit
      // keeps the window open the way Terminal.app's `do script` does. The
      // process-scoped Bypass lets npm.ps1 and other .ps1 shims load under
      // the default Restricted / AllSigned policy, as the embedded run does.
      // The registry PATH goes first (`;` escaped for wt, which would
      // otherwise read it as its own subcommand separator).
      expect(argv).toEqual([
        'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command',
        terminal.REFRESH_PATH_PS.replace(/;$/, '\\;'), command,
      ])
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    })

    it('falls back to `cmd /c start powershell` without Windows Terminal', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))

      await expect(terminal.openInExternalTerminal('x', plainDirWith())).resolves.toEqual({ ok: true })

      const [exe, argv, opts] = spawnMock.mock.calls[0]
      expect(exe).toBe('cmd.exe')
      expect(argv).toEqual([
        '/c', 'start', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command',
        terminal.REFRESH_PATH_PS, 'x',
      ])
      // The launcher cmd.exe must not flash its own console; the PowerShell
      // window `start` opens is a new console and is unaffected.
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })
    })

    it('calls a quoted binary through `&`, as the embedded run does', async () => {
      // A resolved binary comes back quoted (`'C:\\...\\claude.cmd' update`),
      // which PowerShell reads as a string plus a stray token; mirrors
      // onboarding_deps.run_argv (test_run_argv_windows_calls_a_quoted_binary).
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      for (const quoted of ["'C:\\npm\\claude.cmd' update", '"C:\\npm\\claude.cmd" update']) {
        spawnMock.mockClear()
        await terminal.openInExternalTerminal(quoted, plainDirWith())
        expect(spawnMock.mock.calls[0][1].at(-1)).toBe(`& ${quoted}`)
      }
    })

    it('leaves an unquoted command as it is', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await terminal.openInExternalTerminal('npm install -g @openai/codex', plainDirWith())
      expect(spawnMock.mock.calls[0][1].at(-1)).toBe('npm install -g @openai/codex')
    })

    it('falls through to conhost when Windows Terminal is present but will not start', async () => {
      on('win32')
      const bin = plainDirWith('wt.exe')
      spawnMock
        .mockImplementationOnce(() => fakeChild('error'))
        .mockImplementationOnce(() => fakeChild('spawn'))
      await expect(terminal.openInExternalTerminal('x', bin)).resolves.toEqual({ ok: true })
      expect(spawnMock.mock.calls.map((c) => c[0])).toEqual([join(bin, 'wt.exe'), 'cmd.exe'])
    })

    it('reports the failure when even the conhost route cannot start', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('error'))
      const result = await terminal.openInExternalTerminal('x', plainDirWith())
      expect(result.ok).toBe(false)
      expect(result.error).toContain('ENOENT')
    })

    it('re-reads the registry PATH before the command runs', () => {
      // A terminal started from Navide inherits the PATH Navide launched
      // with: Node installed since (winget, in the guided install) would
      // leave `npm` unresolvable in this window. PowerShell reads both
      // registry values itself, at run time, so no PATH value is ever
      // spliced into the command line where it could be parsed as code.
      expect(terminal.REFRESH_PATH_PS).toBe(
        "$env:Path = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), " +
          "[Environment]::GetEnvironmentVariable('Path', 'User')) -join [IO.Path]::PathSeparator;"
      )
      // Survives both launchers' quoting: no double quote for Node's argv
      // quoting to collide with, no `%` for cmd.exe to expand.
      expect(terminal.REFRESH_PATH_PS).not.toMatch(/["%]/)
    })

    it('never touches osascript', async () => {
      on('win32')
      spawnMock.mockImplementation(() => fakeChild('spawn'))
      await terminal.openInExternalTerminal('x', plainDirWith())
      for (const call of spawnMock.mock.calls) expect(call[0]).not.toBe('osascript')
    })
  })
})
