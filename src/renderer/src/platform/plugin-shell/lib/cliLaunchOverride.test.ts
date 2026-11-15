import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import {
  SPAWN_ENV_RESERVED_KEYS,
  chooseLaunchCommand,
  cliCommandKey,
  cliEnvKey,
  isReservedSpawnEnvKey,
  isValidEnvName,
  parseCliEnvOverride,
  serializeCliEnvOverride,
  spawnEnvOverride,
} from './cliLaunchOverride'

describe('settings keys', () => {
  it('mirror the per-vendor shape the other CLI settings use', () => {
    expect(cliCommandKey('claude')).toBe('agentTeam.cliCommand.claude')
    expect(cliEnvKey('claude')).toBe('agentTeam.cliEnv.claude')
  })
})

describe('chooseLaunchCommand', () => {
  it('uses the stored command when the caller named none', () => {
    expect(chooseLaunchCommand({ callerCommand: '', storedCommand: ' ccr code ', isLogin: false }))
      .toEqual({ command: 'ccr code', source: 'stored' })
  })

  it('lets the caller win, so a rebuilt resume command is not replaced by the setting', () => {
    // Reading the setting first would throw the resume line away and reopen
    // the pane on a fresh session — losing the conversation.
    expect(chooseLaunchCommand({ callerCommand: 'claude --resume abc', storedCommand: 'ccr code', isLogin: false }))
      .toEqual({ command: 'claude --resume abc', source: 'caller' })
  })

  it('never gives a login pane the stored command', () => {
    // The backend keeps only the first token and appends `auth login`, so a
    // wrapper line would become `npx auth login` / `ccr auth login`. 'none'
    // sends the login down the default-command path, where the custom binary
    // (the backend's override, applied at terminal.create) still applies.
    for (const storedCommand of ['npx @anthropic-ai/claude-code', 'ccr code', 'FOO=1 claude']) {
      expect(chooseLaunchCommand({ callerCommand: '', storedCommand, isLogin: true }))
        .toEqual({ command: '', source: 'none' })
    }
  })

  it('reads a blank setting as none', () => {
    expect(chooseLaunchCommand({ callerCommand: '  ', storedCommand: '   ', isLogin: false }))
      .toEqual({ command: '', source: 'none' })
  })
})

describe('parseCliEnvOverride', () => {
  it('reads an unset vendor as no rows', () => {
    expect(parseCliEnvOverride(null)).toEqual([])
    expect(parseCliEnvOverride(undefined)).toEqual([])
    expect(parseCliEnvOverride('')).toEqual([])
  })

  it('rejects shapes a legacy or half-written value could take', () => {
    // A scalar left by an earlier key, and an array — neither is a name→value
    // map, and reading either as rows would put junk in the table.
    expect(parseCliEnvOverride('HTTPS_PROXY=x')).toEqual([])
    expect(parseCliEnvOverride(['HTTPS_PROXY'])).toEqual([])
  })

  it('keeps insertion order so the table does not reshuffle on reload', () => {
    expect(parseCliEnvOverride({ Z_VAR: '1', A_VAR: '2' })).toEqual([
      { name: 'Z_VAR', value: '1' },
      { name: 'A_VAR', value: '2' },
    ])
  })

  it('drops names a process environment could not hold, and non-string values', () => {
    expect(parseCliEnvOverride({ 'BAD NAME': 'x', '1LEADING': 'x', OK: 'y', NUM: 3 })).toEqual([
      { name: 'OK', value: 'y' },
    ])
  })
})

describe('serializeCliEnvOverride', () => {
  it('clears the key rather than storing an empty map', () => {
    expect(serializeCliEnvOverride([])).toBeNull()
    // A row the user started and abandoned is not a setting.
    expect(serializeCliEnvOverride([{ name: '  ', value: 'orphan' }])).toBeNull()
  })

  it('trims names and lets a later duplicate win, as the spawn map would', () => {
    expect(serializeCliEnvOverride([
      { name: ' HTTPS_PROXY ', value: 'first' },
      { name: 'HTTPS_PROXY', value: 'second' },
    ])).toEqual({ HTTPS_PROXY: 'second' })
  })

  it('keeps an empty value — unsetting a var by blanking it is a real use', () => {
    expect(serializeCliEnvOverride([{ name: 'NO_PROXY', value: '' }])).toEqual({ NO_PROXY: '' })
  })

  it('round-trips through parse', () => {
    const stored = serializeCliEnvOverride([{ name: 'A', value: '1' }, { name: 'B', value: '2' }])
    expect(parseCliEnvOverride(stored)).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
  })
})

describe('spawnEnvOverride', () => {
  it('is undefined for an untouched vendor, so the spawn payload is unchanged', () => {
    expect(spawnEnvOverride(null)).toBeUndefined()
    expect(spawnEnvOverride({})).toBeUndefined()
  })

  it('hands the stored map straight through when there is one', () => {
    expect(spawnEnvOverride({ HTTPS_PROXY: 'http://proxy:8080' })).toEqual({
      HTTPS_PROXY: 'http://proxy:8080',
    })
  })
})

describe('isValidEnvName', () => {
  it('accepts what a shell accepts and nothing else', () => {
    expect(isValidEnvName('HTTPS_PROXY')).toBe(true)
    expect(isValidEnvName('_x1')).toBe(true)
    expect(isValidEnvName('1X')).toBe(false)
    expect(isValidEnvName('A B')).toBe(false)
    expect(isValidEnvName('A=B')).toBe(false)
    expect(isValidEnvName('')).toBe(false)
  })
})

describe('isReservedSpawnEnvKey', () => {
  it('marks a name the backend drops on the way in', () => {
    expect(isReservedSpawnEnvKey('ANTHROPIC_API_KEY')).toBe(true)
    expect(isReservedSpawnEnvKey(' CODEX_HOME ')).toBe(true)
  })

  it('leaves an ordinary name alone', () => {
    expect(isReservedSpawnEnvKey('HTTPS_PROXY')).toBe(false)
  })

  it('marks both MiniMax data-root aliases as reserved', () => {
    expect(isReservedSpawnEnvKey('MINIMAX_DATA_DIR')).toBe(true)
    expect(isReservedSpawnEnvKey('MAVIS_DATA_DIR')).toBe(true)
  })

  // Windows env names are case-insensitive: `minimax_data_dir` in the table
  // sets MINIMAX_DATA_DIR for the pane, so it has to be marked there. POSIX
  // names are not, and there the lower-case spelling is the user's own
  // variable — marking it would warn about a row that is perfectly legal.
  // Mirrors the backend's `filter_spawn_env_request` through
  // `osplat.paths.env_name_key`.
  // The caller passes the platform's answer (SettingsModal hands in
  // `isWindows()`); this module never reads the platform itself.
  it('folds case only where the host process environment does', () => {
    expect(isReservedSpawnEnvKey('minimax_data_dir', { foldCase: true })).toBe(true)
    expect(isReservedSpawnEnvKey('Claude_Config_Dir', { foldCase: true })).toBe(true)
    expect(isReservedSpawnEnvKey('https_proxy', { foldCase: true })).toBe(false)
    expect(isReservedSpawnEnvKey('minimax_data_dir', { foldCase: false })).toBe(false)
    expect(isReservedSpawnEnvKey('minimax_data_dir')).toBe(false)
    expect(isReservedSpawnEnvKey('MINIMAX_DATA_DIR', { foldCase: false })).toBe(true)
  })
})

// ── The one thing in this file that is not local knowledge ──────────────────
//
// SPAWN_ENV_RESERVED_KEYS is a copy of a list the backend computes at runtime
// (`app.spawn_env_deny_list()`), and a copy is exactly the kind of thing that
// goes stale in silence: a vendor gaining a home var would start being dropped
// by the backend while this page still called it fine. Rather than trust the
// copy, rebuild the union from the same three Python sources the backend reads
// and require the two to be identical.
//
// Parsed out of the sources rather than obtained by running Python: this suite
// has no interpreter and no backend virtualenv, and every one of the three is a
// literal tuple of string constants, so a parse cannot disagree with an import
// without the source having changed shape — which is itself worth failing on.

const BACKEND = fileURLToPath(new URL('../../../../../../backend/agent_team_backend/', import.meta.url))

/** The string literals inside `<name> = (...)` or `<name>=(...)`, balancing
 *  parentheses so a trailing comment or a nested call cannot end it early. */
function pythonTupleStrings(source: string, name: string): string[] {
  const opener = new RegExp(`${name}\\s*=\\s*\\(`)
  const match = opener.exec(source)
  if (!match) return []
  let depth = 1
  let i = match.index + match[0].length
  const start = i
  while (depth > 0 && i < source.length) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') depth--
    i++
  }
  return [...source.slice(start, i - 1).matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

function backendDenyList(): string[] {
  const keys = new Set<string>()
  const add = (names: string[]): void => names.forEach((n) => keys.add(n))

  // 1. API-key vars that displace a managed claude account's OAuth login.
  add(pythonTupleStrings(readFileSync(`${BACKEND}profiles_store.py`, 'utf8'), 'CLAUDE_ENV_OVERRIDES'))
  // 2. The legacy table of inherited home relocators / runtime markers.
  add(pythonTupleStrings(readFileSync(`${BACKEND}app.py`, 'utf8'), '_INHERITED_CLI_HOME_VARS'))
  // 3. Every vendor's home vars: the `env_strip` of its launch declaration,
  //    which is where the registry's `home_env_vars` come from.
  const declarations = JSON.parse(readFileSync(`${BACKEND}cli_declarations.json`, 'utf8')) as Array<{
    launch: { env_strip: string[] }
  }>
  for (const declaration of declarations) add(declaration.launch.env_strip)
  return [...keys].sort()
}

describe('SPAWN_ENV_RESERVED_KEYS', () => {
  it('is exactly the backend union — a drift here is a key the page lies about', () => {
    expect([...SPAWN_ENV_RESERVED_KEYS].sort()).toEqual(backendDenyList())
  })

  it('found all three sources (a rename would otherwise pass as an empty union)', () => {
    expect(backendDenyList().length).toBeGreaterThanOrEqual(20)
  })
})
