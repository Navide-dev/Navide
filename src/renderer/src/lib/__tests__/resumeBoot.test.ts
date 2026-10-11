import { describe, expect, it } from 'vitest'
import { RESUME_BOOT_MAX_MS, resumeBootHold, resumeUnconfirmed } from '../resumeBoot'

// cli_send(open_target=True) to a reclaimed pane, 2026-10-10 15:11Z
// (msg_key …:mcp:a938424d0a241404, pane 發版-0.2.18執行). The open spawned
// `claude --resume` at 15:11:46.8Z. A resumed claude reloads its transcript in
// silence for 20-30s, so after the shell's own first bytes the badge read idle
// and the messaging gate let the message through: it was typed at 15:12:02Z,
// 13s before claude's SessionStart:resume hook ran (15:12:15Z). The resume
// repaint that followed wiped the composer, read as echo and submit "growth",
// and the message was reported delivered at 15:12:23Z. The session transcript
// never received it; the pane sat idle for four hours.
const SPAWN = Date.parse('2026-10-10T15:11:46.800Z')
const TYPED = Date.parse('2026-10-10T15:12:02.000Z')
const SESSION_START = Date.parse('2026-10-10T15:12:15.300Z')

const base = {
  hasPty: true,
  resumeSpawnedAt: SPAWN,
  pushReady: false,
  lastSignalAt: 0,
}

describe('resumeBootHold — a resumed CLI is not ready because it went quiet', () => {
  it('holds the incident message: resumed 15s ago and the CLI has said nothing', () => {
    expect(resumeBootHold({ ...base, now: TYPED })).toBe(true)
  })

  it('lets go once the push channel is armed (claude SessionStart rewake)', () => {
    expect(resumeBootHold({ ...base, pushReady: true, now: SESSION_START })).toBe(false)
  })

  it('lets go on any CLI signal newer than the spawn', () => {
    expect(resumeBootHold({ ...base, lastSignalAt: SESSION_START, now: SESSION_START + 1 })).toBe(false)
  })

  it('ignores a signal left over from before the spawn', () => {
    // A rebuild reuses the pane id, so its turn clocks still hold the old PTY's
    // last turn — that says nothing about the CLI that is booting now.
    expect(resumeBootHold({ ...base, lastSignalAt: SPAWN - 60_000, now: TYPED })).toBe(true)
  })

  it('gives up holding at the resume ceiling', () => {
    expect(resumeBootHold({ ...base, now: SPAWN + RESUME_BOOT_MAX_MS - 1 })).toBe(true)
    expect(resumeBootHold({ ...base, now: SPAWN + RESUME_BOOT_MAX_MS })).toBe(false)
  })

  it('does not hold a pane that was not freshly resumed', () => {
    // 0 = a fresh spawn, or a reattach to a CLI that never stopped running.
    expect(resumeBootHold({ ...base, resumeSpawnedAt: 0, now: TYPED })).toBe(false)
  })

  it('holds a pane whose PTY does not exist yet', () => {
    // A resume parked for a hidden tab reads idle on the badge while it has no
    // PTY at all; typing into it can only fail.
    expect(resumeBootHold({ ...base, hasPty: false, resumeSpawnedAt: 0, now: TYPED })).toBe(true)
  })
})

describe('resumeUnconfirmed — weak evidence is not enough until the CLI has spoken', () => {
  it('is unconfirmed after a resume spawn with no CLI signal since', () => {
    expect(resumeUnconfirmed({ resumeSpawnedAt: SPAWN, lastSignalAt: 0 })).toBe(true)
    expect(resumeUnconfirmed({ resumeSpawnedAt: SPAWN, lastSignalAt: SPAWN - 1 })).toBe(true)
  })

  it('is confirmed by a signal newer than the spawn', () => {
    expect(resumeUnconfirmed({ resumeSpawnedAt: SPAWN, lastSignalAt: SESSION_START })).toBe(false)
  })

  it('never applies to a fresh spawn or a reattach', () => {
    expect(resumeUnconfirmed({ resumeSpawnedAt: 0, lastSignalAt: 0 })).toBe(false)
  })
})
