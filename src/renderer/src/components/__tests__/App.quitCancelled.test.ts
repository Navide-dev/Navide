import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — this asserts against the source text.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('a quit cancelled after the shutdown screen went up', () => {
  it('takes the shutdown screen down again', () => {
    // Main restarts the backend it stopped and then reports 'cancelled'; the
    // window stays, so the overlay must not.
    const start = appSource.indexOf('onQuitProgress?.((stage)')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, start + 300)
    expect(block).toMatch(/if \(stage === 'cancelled'\) \{\s*quitStage\.value = null\s*return\s*\}/)
  })
})
