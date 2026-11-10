// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Reads the source like the other App.*.test.ts files: mounting App starts
// its backend and terminal lifecycles. The keys themselves are unit-tested in
// lib/__tests__/paneAnswerKeys.modelPicker.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(start: string, end: string): string {
  const at = appSource.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  return appSource.slice(at, appSource.indexOf(end, at))
}

const picker = block('async function setModelViaPicker(', '\n}\n')
const action = block("registerCommand('ui.pane.setModel'", '\n})\n')

describe('cli_set_model: claude through the /model picker', () => {
  it('opens the bare picker, never /model <id>', () => {
    expect(picker).toContain("injectPane(paneId, '/model', 'set-model', true)")
    expect(picker).not.toContain('/model ${')
  })

  it('presses the computed keys only while the same picker is up', () => {
    expect(picker).toContain('modelPickerKeys(menu, label)')
    expect(picker).toContain('stillOn: stillOnModelPicker,')
    expect(picker).toContain("return modelSwitchResult(done) === 'default' ? 'saved-as-default' : null")
  })

  it('closes the picker with Esc before every fallback after it opened', () => {
    for (const reason of ['picker-not-shown', 'model-not-in-picker', 'picker-changed', 'keys-failed', 'switch-not-confirmed']) {
      expect(picker).toContain(`return cancel('${reason}')`)
    }
    expect(picker).toContain("await write('\\x1b')")
  })

  it('answers picker, slash or restart, and falls back to the restart with its reason', () => {
    expect(action).toContain("if (pane.agentKey === 'claude' && !effort) {")
    expect(action).toContain("return { ok: true, method: 'picker', paneId: pane.id }")
    expect(action).toContain('const command = fallback ? null : liveModelCommand(pane.agentKey, model, effort)')
    expect(action).toContain("return { ok: true, method: 'slash', paneId: pane.id }")
    expect(action).toContain("fallback ? { ok: true, method: 'restart', paneId, fallback }")
    expect(action.indexOf('setModelViaPicker(')).toBeLessThan(action.indexOf('rebuildPaneViaResume('))
  })
})
