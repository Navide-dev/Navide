import { describe, expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from '../agents'
import {
  cliPermissionKey,
  parseCliPermissionMode,
  skipPermissionFlagFor,
} from './cliPermission'

const claude = { skipPermissionFlag: '--dangerously-skip-permissions' }
const grok = {}

describe('cliPermissionKey', () => {
  it('mirrors the per-vendor binary key shape', () => {
    expect(cliPermissionKey('claude')).toBe('agentTeam.cliPermission.claude')
  })
})

describe('parseCliPermissionMode', () => {
  it('accepts the three modes', () => {
    expect(parseCliPermissionMode('inherit')).toBe('inherit')
    expect(parseCliPermissionMode('force-on')).toBe('force-on')
    expect(parseCliPermissionMode('force-off')).toBe('force-off')
  })

  it('falls back to inherit for unset or unknown values', () => {
    expect(parseCliPermissionMode(null)).toBe('inherit')
    expect(parseCliPermissionMode(undefined)).toBe('inherit')
    expect(parseCliPermissionMode('')).toBe('inherit')
    expect(parseCliPermissionMode('yolo')).toBe('inherit')
  })
})

describe('skipPermissionFlagFor', () => {
  it('inherit follows the global toggle', () => {
    expect(skipPermissionFlagFor({ spec: claude, globalYolo: true, mode: 'inherit' })).toBe(
      '--dangerously-skip-permissions',
    )
    expect(skipPermissionFlagFor({ spec: claude, globalYolo: false, mode: 'inherit' })).toBe('')
  })

  it('force-on ignores a disabled global toggle', () => {
    expect(skipPermissionFlagFor({ spec: claude, globalYolo: false, mode: 'force-on' })).toBe(
      '--dangerously-skip-permissions',
    )
  })

  it('force-off ignores an enabled global toggle', () => {
    expect(skipPermissionFlagFor({ spec: claude, globalYolo: true, mode: 'force-off' })).toBe('')
  })

  it('yields nothing for a vendor with no bypass flag, in every mode', () => {
    for (const mode of ['inherit', 'force-on', 'force-off'] as const) {
      expect(skipPermissionFlagFor({ spec: grok, globalYolo: true, mode })).toBe('')
    }
  })

  it('yields nothing for an unknown vendor', () => {
    expect(skipPermissionFlagFor({ spec: undefined, globalYolo: true, mode: 'force-on' })).toBe('')
  })

  it('resolves every declared vendor bypass flag through the toggle', () => {
    for (const spec of CLI_AGENT_SPECS) {
      if (!spec.skipPermissionFlag) continue
      expect(skipPermissionFlagFor({ spec, globalYolo: true, mode: 'inherit' })).toBe(
        spec.skipPermissionFlag,
      )
      expect(skipPermissionFlagFor({ spec, globalYolo: true, mode: 'force-off' })).toBe('')
    }
  })

  it('keeps the five flagless vendors flagless', () => {
    const flagless = CLI_AGENT_SPECS.filter((spec) => !spec.skipPermissionFlag)
      .map((spec) => spec.agentKey)
      .sort()
    expect(flagless).toEqual(['goose', 'grok', 'mcode', 'opencode', 'pi'])
  })
})
