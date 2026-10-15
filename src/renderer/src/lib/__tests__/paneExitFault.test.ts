import { describe, expect, it } from 'vitest'
import { paneExitFault } from '../paneExitFault'

describe('paneExitFault — which CLI exits are worth a badge and a ledger entry', () => {
  it('flags a non-zero exit of an agent CLI', () => {
    expect(paneExitFault(1, 'claude', undefined, 1000)).toEqual({ code: 1, at: 1000 })
    expect(paneExitFault(139, 'codex', undefined, 5)).toEqual({ code: 139, at: 5 })
  })

  it('ignores a clean exit and an unknown code', () => {
    expect(paneExitFault(0, 'claude')).toBeNull()
    expect(paneExitFault(null, 'claude')).toBeNull()
    expect(paneExitFault(undefined, 'claude')).toBeNull()
  })

  it("leaves a plain terminal's shell alone: its exit code is the user's own", () => {
    expect(paneExitFault(1, 'terminal')).toBeNull()
  })

  it('leaves 127 from a missing CLI to the install prompt', () => {
    expect(paneExitFault(127, 'claude', 'not_found')).toBeNull()
    expect(paneExitFault(127, 'claude', 'found')).toEqual({ code: 127, at: expect.any(Number) })
  })
})
