import { describe, expect, it } from 'vitest'
import { claudePickerLabel, liveModelCommand } from '../liveModelSwitch'

describe('liveModelCommand', () => {
  it('types /model <id> for codex only', () => {
    expect(liveModelCommand('codex', ' gpt-6-astra ', '')).toBe('/model gpt-6-astra')
  })

  it('never types /model <id> into claude, which would save it as the default', () => {
    expect(liveModelCommand('claude', 'opus', '')).toBeNull()
  })

  it('restarts every other CLI', () => {
    expect(liveModelCommand('opencode', 'x', '')).toBeNull()
    expect(liveModelCommand('copilot', 'x', '')).toBeNull()
  })

  it('restarts when an effort is asked for, since /model takes none', () => {
    expect(liveModelCommand('codex', 'gpt-6-astra', 'high')).toBeNull()
  })
})

describe('claudePickerLabel', () => {
  it('names an alias by its family', () => {
    expect(claudePickerLabel('sonnet')).toBe('Sonnet')
    expect(claudePickerLabel(' Opus ')).toBe('Opus')
    expect(claudePickerLabel('haiku')).toBe('Haiku')
    expect(claudePickerLabel('fable')).toBe('Fable')
  })

  it('names a full id as the picker row reads', () => {
    expect(claudePickerLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(claudePickerLabel('claude-fable-5-2')).toBe('Fable 5.2')
  })

  it('does not guess at anything else', () => {
    for (const id of ['default', 'opus[1m]', 'claude-sonnet-4-5-20250929', 'claude-opus-5-5[1m]', 'gpt-6', '']) {
      expect(claudePickerLabel(id)).toBeNull()
    }
  })
})
