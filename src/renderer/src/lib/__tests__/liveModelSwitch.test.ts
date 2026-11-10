import { describe, expect, it } from 'vitest'
import { liveModelCommand } from '../liveModelSwitch'

describe('liveModelCommand', () => {
  it('types /model for claude and codex', () => {
    expect(liveModelCommand('claude', ' opus ', '')).toBe('/model opus')
    expect(liveModelCommand('codex', 'gpt-6-astra', '')).toBe('/model gpt-6-astra')
  })

  it('restarts every other CLI', () => {
    expect(liveModelCommand('opencode', 'x', '')).toBeNull()
    expect(liveModelCommand('copilot', 'x', '')).toBeNull()
  })

  it('restarts when an effort is asked for, since /model takes none', () => {
    expect(liveModelCommand('claude', 'opus', 'high')).toBeNull()
  })
})
