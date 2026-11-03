import { execFile, execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter } from 'node:path'

/**
 * The PATH a process started now would get on Windows, read from the
 * registry. Navide keeps the PATH Explorer handed it at launch, so a tool
 * installed since (VS Code, or Node through the guided install) stays
 * invisible until a restart without this. Mirrors the backend's
 * `osplat._windows._registry_path_entries`.
 */

/** The `Path` value of a `reg query <key> /v Path` answer, or null. */
export function parseRegQueryPath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
    if (match) return match[1].trim()
  }
  return null
}

/** `%VAR%` expanded from `env`, matching names case-insensitively the way
 *  Windows does; an unknown variable is left as written. */
export function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]))
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole)
}

// `reg.exe` answers in the console's OEM code page (cp950 on zh-TW), so a
// Chinese user name in %APPDATA%\npm came out as mojibake under utf8 and was
// dropped. PowerShell can switch its output to UTF-8 first; one run reads
// both values (expanded by .NET). Its start-up is slow, so main reads it in
// the background (backend.ts warmRegistryPath).
const READ_PATH_PS =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  "[Environment]::GetEnvironmentVariable('Path', 'Machine'); " +
  "[Environment]::GetEnvironmentVariable('Path', 'User')"

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', READ_PATH_PS]

type PathRunner = (args: string[]) => Uint8Array
type AsyncPathRunner = (args: string[]) => Promise<Uint8Array>

const runPowerShell: PathRunner = (args) =>
  execFileSync('powershell.exe', args, { timeout: 5000, windowsHide: true })

const runPowerShellAsync: AsyncPathRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      args,
      { encoding: 'buffer', timeout: 5000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })

/** PATH entries from READ_PATH_PS's output bytes; an entry that did not
 *  decode (U+FFFD) is skipped. */
function parsePathOutput(output: Uint8Array, env: NodeJS.ProcessEnv): string[] {
  const entries: string[] = []
  for (const value of new TextDecoder('utf-8').decode(output).split(/\r?\n/)) {
    if (!value.trim()) continue
    entries.push(
      ...expandWindowsEnv(value.trim(), env)
        .split(';')
        .filter((e) => e.trim() && !e.includes('\uFFFD'))
    )
  }
  return entries
}

/** Machine then User PATH entries, expanded. Blocks the calling thread for a
 *  PowerShell start-up; prefer readWindowsRegistryPathAsync on main. */
export function readWindowsRegistryPath(
  run: PathRunner = runPowerShell,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  try {
    return parsePathOutput(run(PS_ARGS), env)
  } catch {
    return []
  }
}

/** readWindowsRegistryPath without blocking: PowerShell failing to run, or
 *  timing out, contributes nothing. */
export async function readWindowsRegistryPathAsync(
  run: AsyncPathRunner = runPowerShellAsync,
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  try {
    return parsePathOutput(await run(PS_ARGS), env)
  } catch {
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * `base` with the existing directories among `dirs` that it lacks appended,
 * in order. Compared case-insensitively — NTFS paths — and appended, never
 * prepended, so nothing `base` resolves first is displaced. Same rule as the
 * backend's `_append_path_dirs`.
 */
export function appendExistingDirs(base: string, dirs: string[]): string {
  const current = base.split(delimiter).filter(Boolean)
  const seen = new Set(current.map((p) => p.toLowerCase()))
  const added: string[] = []
  for (const dir of dirs) {
    const key = dir.toLowerCase()
    if (!dir || seen.has(key) || !isDir(dir)) continue
    seen.add(key)
    added.push(dir)
  }
  return added.length ? [...current, ...added].join(delimiter) : base
}
