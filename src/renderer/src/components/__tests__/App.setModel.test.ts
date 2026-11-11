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
    expect(picker).toContain("return switched === 'default' ? fallBack('saved-as-default') : null")
  })

  it('closes the picker with Esc before every fallback after it opened', () => {
    for (const reason of ['picker-not-shown', 'model-not-in-picker', 'picker-changed', 'keys-failed', 'switch-not-confirmed']) {
      expect(picker).toContain(`return cancel('${reason}')`)
    }
    expect(picker).toContain("await write('\\x1b')")
  })

  it('answers the "Switch model?" box with Yes only for the target, else Esc twice', () => {
    expect(picker).toContain('onModelSwitchConfirm(text) || sawResult()')
    expect(picker).toContain('modelConfirmKeys(confirm, label)')
    expect(picker).toContain('stillOn: stillOnModelSwitchConfirm,')
    for (const reason of ['confirm-not-matched', 'confirm-changed', 'confirm-keys-failed', 'confirm-not-confirmed']) {
      expect(picker).toContain(`return cancel('${reason}', 2)`)
    }
  })

  it('logs one [set-model] line per fallback with the screen shape only, never its text', () => {
    expect(picker).toContain("console.warn('[set-model]', JSON.stringify({ fallback: reason, waitedMs: Date.now() - startedAt, ...modelSwitchDiagnostic(lastScreen) }))")
    expect(picker.match(/console\./g)).toHaveLength(1)
    // lastScreen is only assigned and handed to the shape reader.
    expect(picker.match(/lastScreen/g)).toHaveLength(4)
    expect(picker).toContain("return fallBack('model-not-in-picker')")
    expect(picker).toContain("return fallBack('pane-not-ready')")
    expect(picker).toContain('    return fallBack(reason)\n')
    // Every other return of a reason goes through cancel, which logs it.
    expect(picker).not.toMatch(/return '[a-z-]+'/)
  })

  it('waits longer for the result after Yes than after the picker keys', () => {
    expect(appSource).toContain('const MODEL_PICKER_WAIT_MS = 3000')
    expect(appSource).toContain('const MODEL_CONFIRM_WAIT_MS = 5000')
    expect(picker).toContain('done = await waitFor(sawResult, MODEL_CONFIRM_WAIT_MS)')
    expect(picker).toContain('let done = await waitFor((text) => onModelSwitchConfirm(text) || sawResult())\n')
  })

  it('reads the result line from the whole screen, the boxes from the 25-row tail', () => {
    // A tall full-screen pane keeps the result line far above the tail
    // (lib/__tests__/paneAnswerKeys.modelResultScreen.test.ts).
    expect(picker).toContain('const resultScreen = () => (lastScreen = (ref.readScreenTail?.(MODEL_RESULT_SCREEN_LINES) as string | undefined) ?? \'\')')
    expect(picker).toContain('const sawResult = () => (switched = modelSwitchResult(resultScreen())) !== null')
    expect(picker).toContain('const screen = () => (lastScreen = (ref.readScreenTail?.(AWAITING_SCREEN_LINES) as string | undefined) ?? \'\')')
    expect(picker.match(/modelSwitchResult\(/g)).toHaveLength(1)
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
