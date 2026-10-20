// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTurnInFlight } from '../../lib/agentMessaging'
import { isToolResultHook } from '../../lib/cliAwaitingInput'

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
  const guard = "if (ev.notification_type !== 'idle_prompt' && !isToolResultHook(ev.detail)) {"
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

// PostToolUse / PostToolUseFailure are installed async, so the last tool's
// result can land after Stop. It arrives as an agent_active too, but it only
// releases a permission hold; stamping with it reopened the finished turn.
describe('a late tool result does not count as activity', () => {
  // The same stamping rule the guard above applies to the shared clock.
  function stamps(ev: { detail?: string; notification_type?: string }): boolean {
    return ev.notification_type !== 'idle_prompt' && !isToolResultHook(ev.detail)
  }

  it('leaves isTurnInFlight false when a Post event arrives after turn_complete', () => {
    const turnCompleteAt = 2_000
    const now = 2_500
    for (const detail of ['hook:post_tool_use', 'hook:post_tool_use_failure']) {
      const lastActive = stamps({ detail }) ? now : 1_900
      expect(isTurnInFlight(lastActive, turnCompleteAt, now), detail).toBe(false)
    }
    // A real tool start after the turn end still opens a turn.
    const lastActive = stamps({ detail: 'hook:pre_tool_use' }) ? now : 1_900
    expect(isTurnInFlight(lastActive, turnCompleteAt, now)).toBe(true)
  })

  it('is excluded from the clocks by the very guard that stamps them', () => {
    expect(idleGuardBlock()).toContain('!isToolResultHook(ev.detail)')
  })

  it('does not re-arm the done notification either', () => {
    expect(appSource).toContain(
      'if (!isToolResultHook(ev.detail)) sysNotify.markActive(ev.pane_id)'
    )
  })
})
