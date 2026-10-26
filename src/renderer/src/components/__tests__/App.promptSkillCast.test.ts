// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of "only the default skill loops". isLoopSkill itself is
// covered in lib/__tests__/promptSkills.test.ts; what cannot be asserted there
// is the WIRING inside togglePaneLoop — that a one-shot skill returns before
// any loop state is touched, and that the loop path itself was left alone.
// App.vue cannot be mounted by this suite, so the wiring is asserted against
// the source the way the other App.*.test.ts files do.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function togglePaneLoopBody(): string {
  const start = appSource.indexOf('async function togglePaneLoop(')
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}\n', start))
}

describe('togglePaneLoop – one-shot skills', () => {
  const GATE = 'if (skillId != null && !isLoopSkill(skill))'

  function oneShotBranch(): string {
    const body = togglePaneLoopBody()
    const gate = body.indexOf(GATE)
    expect(gate).toBeGreaterThan(-1)
    return body.slice(gate, body.indexOf('if (pane.loopActive) {', gate))
  }

  it('sends a non-loop skill once and returns before the loop toggle', () => {
    const body = togglePaneLoopBody()
    const gate = body.indexOf(GATE)
    // Ahead of the toggle-off branch: casting a one-shot skill while the loop
    // runs must leave the loop running.
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('if (pane.loopActive) {'))
    expect(gate).toBeLessThan(body.indexOf('pane.loopActive = true'))
    // Only one one-shot branch: the old skillId-less copy was unreachable.
    expect(body.indexOf('if (!isLoopSkill(skill))')).toBe(-1)
    const branch = oneShotBranch()
    // Plain prompt, not the loop-wrapped one, and nothing tears down or arms a loop.
    expect(branch).toContain("injectPane(paneId, skill.prompt, 'skill-cast', true)")
    for (const loopOnly of [
      'withLoopDoneInstruction',
      'startLoopLimitWatcher',
      'stopLoopLimitWatcher',
      'bumpLoopGen',
      'loopActive = false',
      'loopSkillId',
      'loopMaxTurns',
    ]) {
      expect(branch).not.toContain(loopOnly)
    }
  })

  it('arms the running loop on the cast turn and refuses while a continue is in flight', () => {
    const branch = oneShotBranch()
    // Refused (visibly) while the loop's own continue is being injected.
    const busy = branch.indexOf('if (watcher?.continuing)')
    expect(busy).toBeGreaterThan(-1)
    expect(branch.slice(busy, branch.indexOf('return', busy))).toContain(
      "notifyRestore.toast(i18n.global.t('pane.terminal.skill-cast-busy'"
    )
    // Holds further continues while the cast injects, and always releases.
    const inject = branch.indexOf("injectPane(paneId, skill.prompt, 'skill-cast', true)")
    expect(branch.indexOf('watcher.continuing = true')).toBeLessThan(inject)
    expect(branch.slice(inject)).toMatch(/finally \{\s*if \(watcher\) watcher\.continuing = false/)
    // The next continue waits on the cast's turn, only once it landed.
    const arm = branch.indexOf('if (pane.loopActive) armLoopTurn(paneId)')
    expect(arm).toBeGreaterThan(inject)
    expect(branch.indexOf('if (!ok)')).toBeLessThan(arm)
  })

  it('tells the user when the cast does not land', () => {
    const branch = oneShotBranch()
    const failed = branch.slice(branch.indexOf('if (!ok)'))
    expect(failed).toContain("notifyRestore.toast(i18n.global.t('pane.terminal.skill-cast-failed'")
    expect(failed).toContain("{ type: 'error' }")
  })

  it('leaves the loop path intact for the default skill', () => {
    const body = togglePaneLoopBody()
    const loopPath = body.slice(body.indexOf('pane.loopActive = true'))
    expect(loopPath).toContain('withLoopDoneInstruction(skill.prompt)')
    expect(loopPath).toContain('pane.loopMaxTurns = skill.maxTurns')
    expect(loopPath).toContain('startLoopLimitWatcher(paneId)')
    expect(loopPath).toContain('armLoopTurn(paneId)')
  })

  it('tells the user when the loop start does not land', () => {
    const body = togglePaneLoopBody()
    const loopPath = body.slice(body.indexOf('pane.loopActive = true'))
    const failed = loopPath.slice(loopPath.indexOf('if (!ok)'), loopPath.indexOf('armLoopTurn(paneId)'))
    expect(failed).toContain("notifyRestore.toast(i18n.global.t('pane.terminal.loop-start-failed'")
    expect(failed).toContain("{ type: 'error' }")
    expect(failed).toContain('pane.loopActive = false')
  })
})
