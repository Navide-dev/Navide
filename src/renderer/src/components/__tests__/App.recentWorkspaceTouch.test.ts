// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootWorkspaceToRecord } from '../../lib/bootWorkspace'

// Only Welcome's click handler and File > Open Recent used to call
// workspace.touch, so folders opened from outside the app (Finder "Open With",
// the macOS Quick Action, CLI path args) never appeared in Recent. The decision
// of which boot qualifies lives in bootWorkspaceToRecord so it can be tested
// directly; the wiring checks below stay source-text assertions because
// mounting App starts backend/terminal/settings lifecycles, as in the other
// App.*.test.ts files.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('bootWorkspaceToRecord', () => {
  it('records a workspace opened from outside the app', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj')).toBe('/Users/test/proj')
  })

  it('records nothing when the window carries no workspace', () => {
    expect(bootWorkspaceToRecord('')).toBe('')
    expect(bootWorkspaceToRecord('?duplicate=1')).toBe('')
  })

  it('skips session restore — six restored windows would reorder Recent by connect order', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj&restore=1')).toBe('')
  })

  it('skips duplicated windows', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj&duplicate=1')).toBe('')
  })

  it('skips windows main opens for an agent, a plugin or a menu that touches Recent itself', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj&skip_recent=1')).toBe('')
  })

  it('skips detached run-group children', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj&detached_group=g1')).toBe('')
  })

  it('treats an empty detached_group as a normal boot', () => {
    expect(bootWorkspaceToRecord('?workspace_path=/Users/test/proj&detached_group=')).toBe(
      '/Users/test/proj'
    )
  })
})

describe('recent-workspace recording wiring', () => {
  it('touches the qualifying boot workspace once the backend connects', () => {
    const start = appSource.indexOf('const touchBootWorkspace = ')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(block).toContain("backend.status.value !== 'connected'")
    expect(block).toContain('touchRecentWorkspace(_bootRecordWorkspace)')
  })

  it('gates the boot touch on bootWorkspaceToRecord, not on the raw URL param', () => {
    expect(appSource).toContain(
      'const _bootRecordWorkspace = bootWorkspaceToRecord(window.location.search)'
    )
    expect(appSource).toContain('if (_bootRecordWorkspace) {')
  })

  it('re-runs the boot touch on the connected transition', () => {
    const start = appSource.indexOf('const touchBootWorkspace = ')
    const block = appSource.slice(start, appSource.indexOf('// Feed the native', start))
    expect(block).toContain('watch(() => backend.status.value, touchBootWorkspace)')
  })

  it('touches the picked workspace from the Open Workspace… menu action', () => {
    const start = appSource.indexOf("if (action === 'open-workspace') {")
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(
      start,
      appSource.indexOf("if (action.startsWith('open-recent:'))", start)
    )
    // Must sit after the focus short-circuit: focusing an already-open window
    // is not a new open and should not re-sort Recent.
    const focusAt = block.indexOf('focusWorkspaceWindow')
    const touchAt = block.indexOf('touchRecentWorkspace(picked)')
    expect(touchAt).toBeGreaterThan(focusAt)
  })
})
