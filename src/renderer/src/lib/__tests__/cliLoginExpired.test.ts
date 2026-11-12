import { describe, it, expect } from 'vitest'
import { matchLoginExpired, loginCommandFor, turnClearsLoginExpired } from '../cliLoginExpired'

// matchLoginExpired detects a CLI's expired-login error in a pane's buffer
// tail so App.vue can light the re-login badge. Only `claude` has a spec for
// now; unknown agentKeys must never match.

describe('lib/cliLoginExpired matchLoginExpired', () => {
  it('matches the real compaction-time expired-login message', () => {
    expect(
      matchLoginExpired('claude', 'Error during compaction: Login expired · Please run /login')
    ).toBe(true)
  })

  it('matches when the instruction phrase is hard-wrapped across a line', () => {
    // A narrow pane hard-wraps mid-phrase; cleanBuffer keeps that `\n`. The
    // matcher normalizes whitespace, so "Please run\n/login" still matches —
    // this is the regression the whitespace-normalize fix targets.
    expect(
      matchLoginExpired('claude', 'Login expired · Please run\n/login now')
    ).toBe(true)
  })

  it('does not match a bare "Login expired" with no "Please run /login"', () => {
    // Design tightened: keying on the instruction phrase avoids spuriously
    // matching the bare "Login expired" string in ordinary output / catted logs.
    expect(matchLoginExpired('claude', 'Login expired')).toBe(false)
  })

  it('does not match ordinary output', () => {
    expect(matchLoginExpired('claude', 'All tests passed, 42 files checked')).toBe(false)
  })

  it('does not match a user-typed bare "/login" (no "Please run" prefix)', () => {
    expect(matchLoginExpired('claude', '> /login')).toBe(false)
  })

  it('does not match a bare "Please run /login" with no "Login expired" context', () => {
    // Assistant/ordinary output that merely mentions the instruction phrase
    // (e.g. this CLI discussing its own /login flow) must not match — the real
    // error always carries the "Login expired" context alongside it.
    expect(matchLoginExpired('claude', 'To re-auth, please run /login when ready')).toBe(false)
  })

  it('does not match when /login has a trailing word boundary (subcommand)', () => {
    // "/login-helper" / "/login2" are distinct tokens, not the recovery command.
    expect(matchLoginExpired('claude', 'Login expired · Please run /login-helper')).toBe(false)
    expect(matchLoginExpired('claude', 'Login expired · Please run /login2')).toBe(false)
  })

  it('never matches for an agentKey without a spec', () => {
    expect(matchLoginExpired('codex', 'Login expired · Please run /login')).toBe(false)
    expect(matchLoginExpired('unknown-cli', 'Login expired')).toBe(false)
  })
})

describe('lib/cliLoginExpired loginCommandFor', () => {
  it('returns /login for claude', () => {
    expect(loginCommandFor('claude')).toBe('/login')
  })

  it('returns null for agentKeys without a spec', () => {
    expect(loginCommandFor('codex')).toBeNull()
    expect(loginCommandFor('unknown-cli')).toBeNull()
  })
})

describe('lib/cliLoginExpired turnClearsLoginExpired', () => {
  const lit = 1_000_000

  it('clears on a real reply that ended after the badge lit', () => {
    expect(turnClearsLoginExpired('claude', 'Done, the report is ready.', lit + 1, lit)).toBe(true)
  })

  it('keeps the badge for the failed turn that printed the error', () => {
    expect(turnClearsLoginExpired('claude', 'Login expired · Please run /login', lit + 1, lit)).toBe(false)
  })

  it('keeps the badge for an empty-text turn end', () => {
    expect(turnClearsLoginExpired('claude', '   ', lit + 1, lit)).toBe(false)
  })

  it('keeps the badge for a turn that ended before it lit (replay)', () => {
    expect(turnClearsLoginExpired('claude', 'old reply', lit - 1, lit)).toBe(false)
    expect(turnClearsLoginExpired('claude', 'same instant', lit, lit)).toBe(false)
  })

  it('never clears without a recorded lit time', () => {
    expect(turnClearsLoginExpired('claude', 'reply', lit + 1, null)).toBe(false)
  })
})
