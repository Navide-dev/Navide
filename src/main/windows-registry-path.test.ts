import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendExistingDirs,
  expandWindowsEnv,
  parseRegQueryPath,
  readWindowsRegistryPath,
  readWindowsRegistryPathAsync,
} from './windows-registry-path'

// 11-03: Navide on Windows keeps the PATH Explorer gave it at launch, so a
// tool installed since (VS Code, Node via the guided install) stayed
// invisible to editor detection and launch until a restart. These read the
// registry PATH the way the backend's `_registry_path_entries` does.

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
  // Windows PowerShell writes to a pipe in the console's OEM code page
  // (cp950 on zh-TW) unless the script switches its output to UTF-8 first;
  // `reg.exe` has no such switch. %APPDATA%\npm of a Chinese user name was
  // read as mojibake and dropped.
  const UTF8_OUTPUT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8'
  const CP950_NAME = Buffer.from('a4fda470a9fa', 'hex') // 王小明 in cp950
  const powershell = (args: string[]): Buffer =>
    Buffer.concat([
      Buffer.from('C:\\Windows\\system32;%ProgramFiles%\\nodejs\\\r\nC:\\Users\\'),
      args[args.length - 1].includes(UTF8_OUTPUT) ? Buffer.from('王小明', 'utf8') : CP950_NAME,
      Buffer.from('\\AppData\\Roaming\\npm\r\n'),
    ])

  it('returns Machine then User entries, expanded, with a Chinese user name intact', () => {
    const seen: string[][] = []
    const entries = readWindowsRegistryPath(
      (args) => {
        seen.push(args)
        return powershell(args)
      },
      { ProgramFiles: 'C:\\Program Files' }
    )
    expect(seen).toHaveLength(1)
    expect(entries).toEqual([
      'C:\\Windows\\system32',
      'C:\\Program Files\\nodejs\\',
      'C:\\Users\\王小明\\AppData\\Roaming\\npm',
    ])
  })

  it('skips an entry that does not decode, keeping the rest', () => {
    const out = Buffer.concat([
      Buffer.from('C:\\tools;C:\\Users\\'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('\\npm\r\n'),
    ])
    expect(readWindowsRegistryPath(() => out, {})).toEqual(['C:\\tools'])
  })

  it('returns nothing when PowerShell cannot be run', () => {
    const fail = (): Buffer => {
      throw new Error('spawn powershell.exe ENOENT')
    }
    expect(readWindowsRegistryPath(fail, {})).toEqual([])
  })

  it('reads the same off the main thread, and nothing when PowerShell fails', async () => {
    const env = { ProgramFiles: 'C:\\Program Files' }
    expect(await readWindowsRegistryPathAsync(async (args) => powershell(args), env)).toEqual(
      readWindowsRegistryPath(powershell, env)
    )
    expect(
      await readWindowsRegistryPathAsync(async () => {
        throw new Error('timed out')
      }, {})
    ).toEqual([])
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
