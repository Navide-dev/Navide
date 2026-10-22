import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../../../..')

// A source guard rather than a fake-timer test: the timer lives inline in
// App.vue's setup, and mounting App.vue (~20K lines, the whole host) to drive
// it is out of proportion for a one-line delay.
describe('boot overlay safety net', () => {
  const src = readFileSync(join(root, 'src/renderer/src/App.vue'), 'utf-8')

  // useBackend gives up at the health-check timeout + 5s. A fixed safety net
  // (it was 52s) tore the overlay down mid-startup on Linux and Windows, whose
  // default timeout is 120s, leaving a bare dark shell instead of the spinner
  // or the error + Retry.
  it('follows the configured health-check timeout instead of a fixed delay', () => {
    const start = src.indexOf('function armBootTimeout(): void {')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).toContain('(settingsApi.healthCheckTimeoutSec.value + 7) * 1000')
    expect(body).not.toMatch(/\b52_000\b/)
  })

  it('re-arms with the saved timeout once it has loaded, only while still booting without an error', () => {
    expect(src).toMatch(
      /settingsApi\.loadHealthCheckTimeoutSec\(\)\.then\(\(\) => \{\s*if \(booting\.value && !bootError\.value\) armBootTimeout\(\)/
    )
  })
})
