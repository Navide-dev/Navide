// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Claude fires Notification(idle_prompt) about a minute after EVERY finished
// turn. It arrives as an agent_active, but it says the pane is WAITING. Letting
// it stamp the activity clocks made isTurnInFlight read a finished pane as
// mid-turn for up to TURN_STALE_MS, holding queued messages behind a turn that
// had already ended. permission_prompt and real activity must still stamp.
//
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function agentActiveBranch(): string {
  const start = appSource.indexOf("} else if (ev.event_type === 'agent_active') {")
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('sysNotify.markActive(ev.pane_id)', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function idleGuardBlock(): string {
  const body = agentActiveBranch()
  const guard = "if (ev.notification_type !== 'idle_prompt') {"
  const at = body.indexOf(guard)
  expect(at).toBeGreaterThan(-1)
  const close = body.indexOf('\n    }\n', at)
  expect(close).toBeGreaterThan(at)
  return body.slice(at, close)
}

describe('idle_prompt does not count as activity', () => {
  it('leaves the shared clock alone, so isTurnInFlight keeps the turn ended', () => {
    expect(idleGuardBlock()).toContain('paneLastActiveAt.set(ev.pane_id, Date.now())')
  })

  it('does not open a new turn', () => {
    expect(idleGuardBlock()).toContain('paneTurnStartedAt.set(ev.pane_id, Date.now())')
  })

  it("leaves the loop's working clock alone too", () => {
    expect(idleGuardBlock()).toContain(
      "if (activityMeansWorking(ev.detail ?? '')) paneLastWorkingAt.set(ev.pane_id, Date.now())"
    )
  })

  it('narrows on idle_prompt alone, so permission_prompt and real activity still stamp', () => {
    const body = agentActiveBranch()
    expect(body.match(/idle_prompt'/g)?.length).toBe(1)
    expect(body).not.toContain("notification_type === 'permission_prompt'")
  })

  it('stamps nowhere else in the branch', () => {
    const body = agentActiveBranch()
    expect(body.split('paneLastActiveAt.set(').length - 1).toBe(1)
  })
})
