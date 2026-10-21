// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. Injected
// inter-CLI messages land in a CLI log as ordinary records, and a pane titled
// with one reads as someone else's instruction. Both auto-name paths in the
// agent.activity handler (the user-prompt path and the turn_complete fallback)
// must skip anything Navide injected — a forwarded envelope or a delivery
// failure notice alike.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function activityHandler(): string {
  const start = appSource.indexOf("backend.on('agent.activity'")
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf("backend.on(", start + 1)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function countOf(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++
  return n
}

describe('auto-naming skips inter-CLI envelopes', () => {
  it('both auto-name paths in agent.activity are envelope-guarded', () => {
    const body = activityHandler()
    // The user-prompt path and the turn_complete fallback.
    expect(countOf(body, 'setPaneAutoName(')).toBe(2)
    // Plus the reply recorder for {{prev.summary}}, which skips envelopes too.
    expect(countOf(body, 'isInjectedMessageText(')).toBe(3)
  })

  it('the turn_complete fallback guards its own text', () => {
    const body = activityHandler()
    const fallback = body.slice(body.indexOf('Auto-name fallback'))
    expect(fallback).toContain('!isInjectedMessageText(ev.text)')
    expect(fallback).toContain('setPaneAutoName(')
  })
})
