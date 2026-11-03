import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendExistingDirs,
  expandWindowsEnv,
  parseRegQueryPath,
  readWindowsRegistryPath,
} from './windows-registry-path'

// 11-03: Navide on Windows keeps the PATH Explorer gave it at launch, so a
// tool installed since (VS Code, Node via the guided install) stayed
// invisible to editor detection and launch until a restart. These read the
// registry PATH the way the backend's `_registry_path_entries` does.

const MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER = 'HKCU\\Environment'

describe('parseRegQueryPath', () => {
  it('reads the Path value of a `reg query` answer', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\tools',
      '',
    ].join('\r\n')
    expect(parseRegQueryPath(out)).toBe('%USERPROFILE%\\AppData\\Roaming\\npm;C:\\tools')
  })

  it('takes a plain REG_SZ too, and nothing when the value is absent', () => {
    expect(parseRegQueryPath('    Path    REG_SZ    C:\\a\r\n')).toBe('C:\\a')
    expect(parseRegQueryPath('ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })
})

describe('expandWindowsEnv', () => {
  it('expands %VAR% from the environment, case-insensitively, and keeps unknown ones', () => {
    expect(expandWindowsEnv('%UserProfile%\\x;%NOPE%\\y', { USERPROFILE: 'C:\\Users\\amy' })).toBe(
      'C:\\Users\\amy\\x;%NOPE%\\y'
    )
  })
})

describe('readWindowsRegistryPath', () => {
  it('returns Machine then User entries, expanded', () => {
    const answers: Record<string, string> = {
      [MACHINE]: '    Path    REG_EXPAND_SZ    C:\\Windows\\system32;%ProgramFiles%\\nodejs\\;\r\n',
      [USER]: '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\r\n',
    }
    const seen: string[][] = []
    const entries = readWindowsRegistryPath(
      (args) => {
        seen.push(args)
        return answers[args[1]]
      },
      { USERPROFILE: 'C:\\Users\\amy', ProgramFiles: 'C:\\Program Files' }
    )
    expect(seen).toEqual([
      ['query', MACHINE, '/v', 'Path'],
      ['query', USER, '/v', 'Path'],
    ])
    expect(entries).toEqual([
      'C:\\Windows\\system32',
      'C:\\Program Files\\nodejs\\',
      'C:\\Users\\amy\\AppData\\Local\\Programs\\Microsoft VS Code\\bin',
    ])
  })

  it('skips a key that cannot be read rather than failing the rest', () => {
    const entries = readWindowsRegistryPath((args) => {
      if (args[1] === MACHINE) throw new Error('reg exited 1')
      return '    Path    REG_SZ    C:\\tools\r\n'
    }, {})
    expect(entries).toEqual(['C:\\tools'])
  })
})

describe('appendExistingDirs', () => {
  let root = ''
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('appends only dirs that exist and PATH lacks, case-insensitively, keeping the order', () => {
    root = mkdtempSync(join(tmpdir(), 'navide-regpath-'))
    const have = join(root, 'Have')
    const code = join(root, 'VSCode')
    mkdirSync(have)
    mkdirSync(code)
    const base = [have, join(root, 'first')].join(delimiter)
    const merged = appendExistingDirs(base, [have.toUpperCase(), code, code, join(root, 'gone')])
    expect(merged).toBe([have, join(root, 'first'), code].join(delimiter))
  })

  it('leaves PATH untouched when there is nothing new', () => {
    expect(appendExistingDirs('a', [])).toBe('a')
  })
})
