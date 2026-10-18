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

  // The rest of the rule — Kill All, a CLI exiting by itself, closing a
  // workspace and a pipeline restart clear the stamp; the app ending and a
  // rebuild keep it — lives in the backend's terminal.exit hook and is
  // behaviour-tested there (backend/tests/test_projects_pane_last_live_launch.py).
  // What the renderer must guarantee is that the app ending never turns into a
  // requested kill ("killed" clears; only the shutdown kill_all keeps it).
  it('runs no workspace close and no kill while the app is ending', () => {
    const calls = appSource.split('\n').filter((line) =>
      /\bcloseWorkspace\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
    // The definition and the sidebar's own "Close workspace" event, nothing else.
    expect(calls.map((l) => l.trim())).toEqual([
      'async function closeWorkspace(path: string): Promise<void> {',
      '@close-workspace="closeWorkspace"',
    ])
    const quit = appSource.slice(
      appSource.indexOf('window.agentTeam?.onQuitProgress?.('),
      appSource.indexOf('\n  })', appSource.indexOf('window.agentTeam?.onQuitProgress?.(')),
    )
    expect(quit).not.toMatch(/onKill|closeWorkspace|terminal\.kill/)
    const unloads = [...appSource.matchAll(/addEventListener\('beforeunload', (\w+(?:\.\w+)?)\)/g)].map((m) => m[1])
    expect(unloads.sort()).toEqual(['flushSettingsOnExit', 'msgLog.flushOnExit', 'saveAllScrollSnapshots'])
  })

  it('offers Auto after the four existing options', () => {
    expect(settingsSource).toMatch(
      /value="single"[\s\S]*?value="page"[\s\S]*?value="tab"[\s\S]*?value="all"[\s\S]*?value="auto">\{\{ \$t\('settings\.appearance\.restore-scope-auto'\) \}\}/,
    )
  })
})
