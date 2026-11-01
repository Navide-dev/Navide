// @vitest-environment happy-dom
//
// Every account that is not confirmed to have no session window keeps the
// answers v0.2.36 gave. The fixture was recorded from v0.2.36's own
// cliUsageLimit.ts over the readings and sentences in usageLimitCases.ts.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { detectUsageLimit, loopEstimate, usageResumeAt } from '../cliUsageLimit'
import { LOOP_ESTIMATE_WINDOW_MS } from '../loopPrompt'
import { __resetUsageForTest, absentSessionNote, initUsage, usageFor } from '../../composables/useUsage'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { cases, NOW } from './usageLimitCases'

const baseline = JSON.parse(readFileSync('tests/fixtures/usage-limit-baseline-v0.2.36.json', 'utf8'))

function seed(snapshot: object): void {
  const handlers = new Map<string, (raw: unknown) => void>()
  initUsage({
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: {} })),
    on: vi.fn((type: string, cb: (raw: unknown) => void) => {
      handlers.set(type, cb)
      return () => handlers.delete(type)
    }),
  } as never)
  handlers.get('usage.changed')?.({
    providers: {
      claude: { provider: 'claude', status: 'ok', planType: null, windows: [], fetchedAt: '2026-11-01T07:50:00Z', error: null, ...snapshot },
    },
  })
}

describe('accounts not confirmed to have no session window', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    __resetUsageForTest()
  })

  it('covers the whole fixture', () => {
    expect(Object.keys(baseline).sort()).toEqual(cases().map((c) => c.name).sort())
  })

  it.each(cases().map((c) => [c.name, c] as const))('%s', (name, c) => {
    seed(c.snapshot)
    expect({
      hit: JSON.parse(JSON.stringify(detectUsageLimit('claude', c.message, NOW))),
      resume: usageResumeAt('claude', NOW),
    }).toEqual(baseline[name])
    expect(loopEstimate(usageFor('claude'), NOW)).toEqual({ at: NOW + LOOP_ESTIMATE_WINDOW_MS, weekly: false })
    expect(absentSessionNote(usageFor('claude'))).toBeNull()
  })
})
