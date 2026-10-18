// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The 'auto' resume scope brings back only the panes whose CLI was live when
// the app last closed. The pick is unit-tested in resumeBehavior.test.ts; App.vue
// cannot be mounted, so its wiring is asserted against the source like the
// other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const settingsSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.search(new RegExp(`function ${name}\\(`))
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('auto resume scope wiring', () => {
  it('feeds the panes live at the previous launch into the scope pick', () => {
    const body = fn('restoreSessionScopeTargets')
    expect(body).toContain('liveAtLastLaunchIds')
    expect(body).toContain('wasLiveAtLastLaunch(')
    expect(body).toContain('PREVIOUS_LAUNCH_ID_SETTING_KEY')
  })

  it('starts an auto restore two at a time, like all', () => {
    expect(fn('advanceRestoreSession')).toMatch(
      /else if \(decision === 'resume' && session\.scope === 'auto'\) \{\s*\/\/[^\n]*\n\s*await runWithConcurrency\(ids, ALL_SCOPE_RESTORE_CONCURRENCY/,
    )
  })

  it('clears the live stamp when an idle pane is reclaimed', () => {
    const body = fn('reclaimIdlePane')
    expect(body).toContain("'project.set_pane_resume_state'")
    expect(body).toContain("last_live_launch: ''")
  })

  it('leaves the live stamp alone on a rebuild', () => {
    expect(fn('rebuildPaneViaResume')).not.toContain('last_live_launch')
    expect(fn('rebuildPaneClean')).not.toContain('last_live_launch')
  })

  it('offers Auto after the four existing options', () => {
    expect(settingsSource).toMatch(
      /value="single"[\s\S]*?value="page"[\s\S]*?value="tab"[\s\S]*?value="all"[\s\S]*?value="auto">\{\{ \$t\('settings\.appearance\.restore-scope-auto'\) \}\}/,
    )
  })
})
