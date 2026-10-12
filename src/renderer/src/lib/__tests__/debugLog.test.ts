import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  capLines,
  filterLogLines,
  logLineLevel,
  maskWsUrlToken,
  splitLogChunk,
} from '../debugLog'

const WARN =
  '[2026-08-06 09:37:44,989] WARNING agent_team_backend.claude_cli_usage: read failed'
const INFO = '[2026-08-06 16:58:42,251] INFO agent_team_backend.terminals: session closed'
const ERROR = '[2026-08-06 10:01:28,075] ERROR agent_team_backend.usage_service: boom'
const TRACEBACK = '  File "usage_service.py", line 2711, in poll_once'

describe('logLineLevel', () => {
  it('reads the level out of a backend log line', () => {
    expect(logLineLevel(WARN)).toBe('WARNING')
    expect(logLineLevel(INFO)).toBe('INFO')
    expect(logLineLevel(ERROR)).toBe('ERROR')
  })

  it('returns empty for continuation lines', () => {
    expect(logLineLevel(TRACEBACK)).toBe('')
    expect(logLineLevel('')).toBe('')
  })

  it('does not match a level word inside the message body', () => {
    expect(
      logLineLevel('[2026-08-06 10:00:00,000] INFO mod: raising an ERROR next time')
    ).toBe('INFO')
  })

  it('is not fooled by a bracketed level quoted inside the message', () => {
    // Real lines carry whole command lines and JSON; an unanchored match would
    // read this ERROR record as INFO and drop it under an ERROR filter.
    expect(
      logLineLevel('[2026-08-06 10:00:00,000] ERROR mod: cmd=[\'sh\', \'-c\'] INFO noise')
    ).toBe('ERROR')
  })

  it('ignores a level-looking word that is not the record header', () => {
    expect(logLineLevel('WARNING: this line has no timestamp header')).toBe('')
    expect(logLineLevel('[2026-08-06 10:00:00,000] TRACE mod: unknown level')).toBe('')
  })
})

describe('splitLogChunk', () => {
  it('splits complete lines and keeps the trailing fragment back', () => {
    const r = splitLogChunk('', 'a\nb\nhalf')
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.partial).toBe('half')
  })

  it('joins the fragment from the previous read', () => {
    const first = splitLogChunk('', 'complete\npar')
    const second = splitLogChunk(first.partial, 'tial\n')
    expect(second.lines).toEqual(['partial'])
    expect(second.partial).toBe('')
  })

  it('yields no lines when the chunk has no newline yet', () => {
    const r = splitLogChunk('abc', 'def')
    expect(r.lines).toEqual([])
    expect(r.partial).toBe('abcdef')
  })

  it('handles an empty chunk without losing the fragment', () => {
    const r = splitLogChunk('kept', '')
    expect(r.lines).toEqual([])
    expect(r.partial).toBe('kept')
  })
})

describe('capLines', () => {
  it('appends within the cap', () => {
    expect(capLines(['a'], ['b', 'c'], 10)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the newest lines when the cap is exceeded', () => {
    expect(capLines(['a', 'b'], ['c', 'd'], 3)).toEqual(['b', 'c', 'd'])
  })

  it('returns the same array when nothing came in', () => {
    const lines = ['a']
    expect(capLines(lines, [], 10)).toBe(lines)
  })

  it('caps even when a single read overflows on its own', () => {
    expect(capLines([], ['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
  })
})

describe('filterLogLines', () => {
  const lines = [INFO, WARN, ERROR, TRACEBACK]

  it('returns everything with no filters', () => {
    expect(filterLogLines(lines, { minLevel: 'all', text: '' })).toBe(lines)
  })

  it('keeps levels at or above the floor', () => {
    expect(filterLogLines(lines, { minLevel: 'WARNING', text: '' })).toEqual([WARN, ERROR])
  })

  it('drops continuation lines once a level filter is on', () => {
    expect(filterLogLines(lines, { minLevel: 'DEBUG', text: '' })).not.toContain(TRACEBACK)
  })

  it('keeps continuation lines when only filtering by text', () => {
    expect(filterLogLines(lines, { minLevel: 'all', text: 'usage_service.py' })).toEqual([
      TRACEBACK,
    ])
  })

  it('matches text case-insensitively and ignores surrounding whitespace', () => {
    expect(filterLogLines(lines, { minLevel: 'all', text: '  BOOM  ' })).toEqual([ERROR])
  })

  it('applies both gates together', () => {
    expect(filterLogLines(lines, { minLevel: 'ERROR', text: 'read failed' })).toEqual([])
    expect(filterLogLines(lines, { minLevel: 'WARNING', text: 'read failed' })).toEqual([WARN])
  })
})

describe('maskWsUrlToken (R3-M2)', () => {
  it('masks the token value and keeps everything else', () => {
    expect(maskWsUrlToken('ws://127.0.0.1:8765/ws?t=abc%2Bdef')).toBe('ws://127.0.0.1:8765/ws?t=••••')
    expect(maskWsUrlToken('ws://127.0.0.1:1/ws?x=1&t=secret&y=2')).toBe('ws://127.0.0.1:1/ws?x=1&t=••••&y=2')
  })

  it('leaves a URL without a token, and an empty one, alone', () => {
    expect(maskWsUrlToken('ws://127.0.0.1:1/ws')).toBe('ws://127.0.0.1:1/ws')
    expect(maskWsUrlToken('')).toBe('')
  })

  it('is what the Debug window shows', () => {
    const source = readFileSync(resolve(__dirname, '../../components/DebugModal.vue'), 'utf8')
    expect(source).toContain('maskWsUrlToken(backend.wsUrl.value)')
    expect(source).not.toMatch(/\{\{\s*backend\.wsUrl\.value/)
  })
})
