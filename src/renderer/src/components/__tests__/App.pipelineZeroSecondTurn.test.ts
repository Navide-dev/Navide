// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue cannot be mounted in this suite, so the stage watcher's wiring is
// asserted against the source. The verdict itself is unit-tested in
// lib/__tests__/completion.quietTurnEnd.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function watcherBody(): string {
  const start = appSource.indexOf('function startStageWatcher(')
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end)
}

describe('a stage turn whose turn end was overtaken by a later activity record', () => {
  it('is finished by the quiet-turn-end fallback right after the turn_complete verdict', () => {
    const body = watcherBody()
    const primary = body.indexOf('turnCompleteDone({')
    const fallback = body.indexOf('quietTurnEndDone({')
    expect(primary).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(primary)
    const call = body.slice(fallback, body.indexOf('onStageSlotCompleted(', fallback))
    expect(call).toContain('paneTurnCompleteTimes.get(paneId)')
    expect(call).toContain('armedAt: watcher.armedAt')
    expect(call).toContain("=== 'running'")
    expect(call).toContain('paneBackgroundRunning(paneId)')
    expect(body.slice(fallback - 200, fallback)).toContain('!stage.allowQuestions')
  })
})
