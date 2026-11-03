/**
 * Open the user's terminal and run a command in it, visibly.
 *
 * Some installs cannot run inline: a `sudo` prompt or an OAuth flow needs a
 * real TTY the user can see and type into. The onboarding wizard marks those
 * `needs_terminal` and hands the command here.
 *
 * Until this module existed the only implementation was AppleScript driving
 * Terminal.app, so on Linux every one of those installs — all fourteen agent
 * CLIs and Ollama — failed with `spawn osascript ENOENT`. The wizard did show
 * the command so it could be pasted by hand, which is why nobody noticed.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

import { isLinux, isMac, isWindows } from '../shared/osplat'

export interface OpenTerminalResult {
  ok: boolean
  error?: string
}

type TerminalEntry = { bin: string; argv: (script: string) => string[] }

/** `-e`/`-x`-style: the rest of argv is the command. */
const rest = (flag: string) => (s: string): string[] => [flag, 'bash', '-c', s]
/** kitty/foot-style: argv after the binary is the command, no flag at all. */
const bare = (s: string): string[] => ['bash', '-c', s]

/**
 * Terminal emulators tried in order on Linux, after `$TERMINAL` and
 * `xdg-terminal-exec` (see linuxTerminalCandidates).
 *
 * Every entry takes the command as argv after its own separator, so the
 * command reaches `bash -c` verbatim with no quoting layer of ours in between
 * — which is why emulators whose only form is a single `-e "string"`
 * (tilix, lxterminal, qterminal) are not listed: they would need one.
 * `x-terminal-emulator` goes first: it is Debian's alternatives symlink to
 * whatever the user picked, which beats guessing their desktop environment.
 * The rest are one per desktop (GNOME old and new, KDE, XFCE, MATE) and the
 * Wayland-native set a tiling-WM user is likely to have instead.
 */
const LINUX_TERMINALS: ReadonlyArray<TerminalEntry> = [
  { bin: 'x-terminal-emulator', argv: rest('-e') },
  { bin: 'gnome-terminal', argv: rest('--') },
  { bin: 'ptyxis', argv: rest('--') },
  { bin: 'konsole', argv: rest('-e') },
  { bin: 'xfce4-terminal', argv: rest('-x') },
  { bin: 'mate-terminal', argv: rest('-x') },
  { bin: 'terminator', argv: rest('-x') },
  { bin: 'kitty', argv: bare },
  { bin: 'alacritty', argv: rest('-e') },
  { bin: 'wezterm', argv: (s) => ['start', '--', 'bash', '-c', s] },
  { bin: 'foot', argv: bare },
  { bin: 'xterm', argv: rest('-e') },
]

/**
 * The order Linux emulators are tried, given the user's environment.
 *
 * `$TERMINAL` first — it is the user naming their emulator outright, and its
 * argv form is looked up by basename in the table (an unknown one gets the
 * common `-e`). Then `xdg-terminal-exec`, the freedesktop resolver that reads
 * the desktop's own default. Then the table, so a machine with none of the
 * hints still gets whatever is installed.
 */
export function linuxTerminalCandidates(env: NodeJS.ProcessEnv): TerminalEntry[] {
  const candidates: TerminalEntry[] = []
  const preferred = env.TERMINAL?.trim()
  if (preferred) {
    const known = LINUX_TERMINALS.find((t) => t.bin === basename(preferred))
    candidates.push({ bin: preferred, argv: known?.argv ?? rest('-e') })
  }
  candidates.push({ bin: 'xdg-terminal-exec', argv: bare })
  for (const entry of LINUX_TERMINALS) {
    if (entry.bin !== preferred && basename(preferred ?? '') !== entry.bin) candidates.push(entry)
  }
  return candidates
}

/**
 * How long a freshly started emulator gets to fail before it counts as
 * opened. The `'spawn'` event alone is not evidence: gnome-terminal and its
 * kin are D-Bus clients that fork fine and only then exit non-zero when
 * there is no session bus or display, and xterm dies the same way on
 * "Can't open display" — so resolving on spawn reported success over a
 * headless SSH session while nothing opened. Same window as the editors.
 */
export const LINUX_TERMINAL_FAILURE_WINDOW_MS = 800

/** Options a caller (or a test) can pin instead of the machine's own. */
export interface OpenTerminalOptions {
  env?: NodeJS.ProcessEnv
  failureWindowMs?: number
}

/**
 * The suffixes Windows will run a bare command name under. `code` on PATH is
 * really `code.cmd`; `wt` is `wt.exe`. PATHEXT lists more, but these are the
 * four that name something spawn() can start.
 */
const WINDOWS_PATHEXT = ['.exe', '.cmd', '.bat', '.com']

/**
 * Where a binary lives on PATH, or null. Node has no `which`.
 *
 * On Windows the executable bit does not exist — `X_OK` there is `F_OK` at
 * best — so presence decides, and the bare name is tried before each PATHEXT
 * suffix, the way cmd.exe resolves a command.
 */
export function findOnPath(
  bin: string,
  path: string | undefined = process.env.PATH
): string | null {
  const windows = isWindows()
  const names = windows ? [bin, ...WINDOWS_PATHEXT.map((ext) => bin + ext)] : [bin]
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        // not here; keep looking
      }
    }
  }
  return null
}

function openWithTerminalApp(command: string): Promise<OpenTerminalResult> {
  // Terminal.app's `do script` opens a window, runs the line, and leaves the
  // shell open afterwards so the user can read what happened.
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Terminal" to do script "${escaped}"\ntell application "Terminal" to activate`
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }))
    proc.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `osascript exited ${code}` })
    )
  })
}

function launch(bin: string, argv: string[], extra: SpawnOptions = {}): Promise<OpenTerminalResult> {
  return new Promise((resolve) => {
    // Detached and unref'd: the terminal outlives this request, and the app
    // must not wait on it — an install that sits at a sudo prompt for a
    // minute would otherwise hold the IPC reply for a minute.
    const child = spawn(bin, argv, { detached: true, stdio: 'ignore', ...extra })
    child.on('error', (err) => resolve({ ok: false, error: String(err) }))
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/**
 * Start an emulator and report whether it stayed up.
 *
 * Unlike `launch`, success is "no non-zero exit inside the failure window":
 * an emulator that hands off to a running instance exits 0 at once and is
 * fine; one that exits non-zero could not open anything.
 */
function launchWatched(
  bin: string,
  argv: string[],
  extra: SpawnOptions,
  failureWindowMs: number
): Promise<OpenTerminalResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { detached: true, stdio: 'ignore', ...extra })
    let settled = false
    const settle = (result: OpenTerminalResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.unref()
      settle({ ok: true })
    }, failureWindowMs)
    child.on('error', (err) => settle({ ok: false, error: String(err) }))
    child.on('exit', (code) => {
      if (code !== 0) settle({ ok: false, error: `${basename(bin)} exited ${code}` })
    })
  })
}

async function openWithLinuxTerminal(
  command: string,
  path: string | undefined,
  { env = process.env, failureWindowMs = LINUX_TERMINAL_FAILURE_WINDOW_MS }: OpenTerminalOptions
): Promise<OpenTerminalResult> {
  // No display, no window: every emulator would fork and then die, and the
  // watched launch below would report each one — say so up front instead,
  // and the wizard shows the command for the user's own terminal.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { ok: false, error: 'no display (DISPLAY and WAYLAND_DISPLAY are unset)' }
  }
  // `; exec bash` mirrors Terminal.app: the window stays open with a shell
  // once the command finishes, so its output (or its sudo prompt) is not
  // gone the instant it returns.
  const script = `${command}; exec bash`
  // The emulator, and the bash inside it, get the login-shell PATH the
  // caller resolved: an `npm install -g` here has to find the nvm-provided
  // npm the session PATH omits.
  const childEnv = path === undefined ? env : { ...env, PATH: path }
  const tried: string[] = []
  const failures: string[] = []
  for (const terminal of linuxTerminalCandidates(env)) {
    tried.push(terminal.bin)
    const bin = findOnPath(terminal.bin, path)
    if (!bin) continue
    const result = await launchWatched(bin, terminal.argv(script), { env: childEnv }, failureWindowMs)
    if (result.ok) return result
    // Present on PATH but would not start — try the next one rather than
    // reporting a broken emulator as "no terminal".
    failures.push(result.error ?? terminal.bin)
  }
  return {
    ok: false,
    error: failures.length > 0
      ? `no terminal emulator could open a window (${failures.join('; ')})`
      : `no terminal emulator found (tried ${tried.join(', ')})`,
  }
}

/**
 * Prepended to every Windows terminal command: the window inherits the PATH
 * Navide launched with, so Node installed since (winget, in the guided
 * install) would leave `npm` unresolvable in it. PowerShell reads both
 * registry values itself at run time, so no PATH value is ever spliced into
 * the command line where it could be parsed as code. Appended, so nothing the
 * inherited PATH resolves first is displaced. No `"` (Node's argv quoting) and
 * no `%` (cmd.exe expansion on the `start` route).
 */
export const REFRESH_PATH_PS =
  "$env:Path = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), " +
  "[Environment]::GetEnvironmentVariable('Path', 'User')) -join [IO.Path]::PathSeparator;"

async function openWithWindowsTerminal(
  command: string,
  path: string | undefined
): Promise<OpenTerminalResult> {
  // `-NoExit` is PowerShell's `; exec bash`: the window stays open with a
  // shell once the command finishes. Windows Terminal when it is installed —
  // it takes the shell command line as argv, so nothing of ours is quoted.
  // Process-scoped Bypass: `npm` resolves to npm.ps1, which the default
  // Restricted / AllSigned policy refuses to load; the user's policy is kept.
  // A resolved binary comes back quoted (`'C:\...\claude.cmd' update`), which
  // PowerShell parses as a string plus a stray token; the call operator makes
  // it a command. Same rule as onboarding_deps.run_argv.
  if (command.startsWith("'") || command.startsWith('"')) command = `& ${command}`
  // Separate argv elements: PowerShell joins everything after -Command with
  // spaces, so the command itself still arrives as its own unmangled token.
  const powershell = (refresh: string): string[] =>
    ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', refresh, command]
  const wt = findOnPath('wt.exe', path)
  if (wt) {
    // wt splits its command line at every `;` into subcommands; `\;` is its
    // escape for a literal one.
    const result = await launch(wt, powershell(REFRESH_PATH_PS.replace(/;$/, '\\;')))
    if (result.ok) return result
    // On PATH but would not start — fall back rather than report no terminal.
  }
  // Otherwise the conhost route: `start` opens PowerShell in its own window.
  // windowsHide keeps the intermediate cmd.exe from flashing a console of
  // its own; the window `start` creates is not affected by it.
  return launch('cmd.exe', ['/c', 'start', ...powershell(REFRESH_PATH_PS)], { windowsHide: true })
}

/**
 * Run `command` in a visible terminal window on this platform.
 *
 * Resolves `ok: false` with a reason rather than throwing: the caller shows
 * the command alongside the error so the user can still paste it themselves.
 *
 * `path` is where terminal emulators are looked for; it defaults to this
 * process's PATH and is a parameter so a test can point it at a directory of
 * stand-ins instead of the machine it happens to run on.
 */
export function openInExternalTerminal(
  command: string,
  path: string | undefined = process.env.PATH,
  options: OpenTerminalOptions = {}
): Promise<OpenTerminalResult> {
  if (isMac()) return openWithTerminalApp(command)
  if (isLinux()) return openWithLinuxTerminal(command, path, options)
  return openWithWindowsTerminal(command, path)
}
