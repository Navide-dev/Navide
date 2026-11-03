import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter } from 'node:path'

/**
 * The PATH a process started now would get on Windows, read from the
 * registry. Navide keeps the PATH Explorer handed it at launch, so a tool
 * installed since (VS Code, or Node through the guided install) stays
 * invisible until a restart without this. Mirrors the backend's
 * `osplat._windows._registry_path_entries`.
 */

const KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const

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

type RegRunner = (args: string[]) => string

const runReg: RegRunner = (args) =>
  execFileSync('reg.exe', args, { encoding: 'utf8', timeout: 2000, windowsHide: true })

/** Machine then User PATH entries, expanded. A key that cannot be read (a
 *  locked-down profile has no User PATH) contributes nothing. */
export function readWindowsRegistryPath(
  run: RegRunner = runReg,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const entries: string[] = []
  for (const key of KEYS) {
    let value: string | null = null
    try {
      value = parseRegQueryPath(run(['query', key, '/v', 'Path']))
    } catch {
      continue
    }
    if (!value) continue
    entries.push(...expandWindowsEnv(value, env).split(';').filter((e) => e.trim()))
  }
  return entries
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
