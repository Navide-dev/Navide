// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TURN_STALE_MS, isTurnInFlight, messagingGateStatus } from '../agentMessaging'

// 0.2.37: two Claude panes interrupted by cli_interrupt sat at their prompt
// ("Interrupted · What should Claude do instead?") for 90 minutes while every
// cli_send to them stayed queued. The STOP badge ('stopped') is sticky until a
// person types into the pane, and the messaging gate read any status other than
// running/idle as 'not-ready'. Its busy answer is mirrored to the backend too,
// which is why cli_get_status reported busy:true next to ui.status "stopped".

describe('messagingGateStatus', () => {
  it('reads through the STOP badge to the CLI state behind it', () => {
    expect(messagingGateStatus('stopped', 'idle')).toBe('idle')
  })

  it('keeps an interrupted pane that is still working busy', () => {
    expect(messagingGateStatus('stopped', 'running')).toBe('running')
  })

  it('keeps an interrupted pane parked on a prompt out of delivery', () => {
    expect(messagingGateStatus('stopped', 'awaiting')).toBe('awaiting')
  })

  it('leaves every other badge alone', () => {
    for (const s of ['idle', 'running', 'awaiting', 'starting', 'exited', 'error']) {
      expect(messagingGateStatus(s, 'idle')).toBe(s)
    }
  })

  it('stays not-ready when there is no live status to read', () => {
    // An older TerminalPane (or an ACP pane) exposes no liveStatus.
    expect(messagingGateStatus('stopped', undefined)).toBe('stopped')
  })
})

describe('the interrupted turn, as the gate sees it', () => {
  it('is no longer in flight once its last activity is stale', () => {
    // No Stop hook fires for an interrupted turn, so there is no turn_complete:
    // the stale bound is what closes it. The incident's last agent_active was
    // ~5800 s old.
    const now = 10_000_000
    expect(isTurnInFlight(now - 5_800_000, 0, now)).toBe(false)
    expect(isTurnInFlight(now - TURN_STALE_MS + 1_000, 0, now)).toBe(true)
  })
})

describe('App.vue wiring', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
  const start = appSource.indexOf('function messagingHoldKey(')
  const body = appSource.slice(start, appSource.indexOf('\n}\n', start))

  it('messagingHoldKey gates on messagingGateStatus over the live status', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain('messagingGateStatus(')
    expect(body).toContain('liveStatus')
  })

  it('TerminalPane exposes liveStatus', () => {
    const pane = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
    expect(pane).toContain('liveStatus: terminal.liveStatus')
  })
})
