import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The first-run tour moved to coach marks (CoachMark.vue). The card walker is
// the release tour's alone again, with none of the interactive mode it carried
// for a while: no action cards, no blockers, no keys let through.
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

describe('GuidedTour is the release tour’s card walker only', () => {
  it('has no interactive mode in the component or its step type', () => {
    const tour = read('src/renderer/src/components/GuidedTour.vue')
    for (const gone of ['interactive', 'isComplete', 'shouldSkip', 'suspended', 'tour--pass', 'tour-blocker', 'waitFor']) {
      expect(tour, gone).not.toContain(gone)
    }
    const tours = read('src/renderer/src/lib/tours.ts')
    for (const gone of ['waitFor', 'skipIfMissing', 'TOUR_DONE_ADVANCE_MS', 'TOUR_STUCK_HINT_MS']) {
      expect(tours, gone).not.toContain(gone)
    }
    expect(read('src/renderer/src/composables/useReleaseTour.ts')).not.toContain('interactive')
  })

  // Named tours, a part that keeps Skip on its last step, a step that names
  // its own button: all of it existed only for the first-run tour's cards.
  it('has nothing left from the first-run tour riding it', () => {
    expect(read('src/renderer/src/components/GuidedTour.vue')).not.toMatch(/skipOnLast|primaryKey/)
    expect(read('src/renderer/src/lib/tours.ts')).not.toContain('primaryKey')
    expect(read('src/renderer/src/composables/useReleaseTour.ts')).not.toMatch(/startNamed|skipOnLast/)
  })

  it('leaves no strings behind for it', () => {
    for (const code of ['en-US', 'zh-TW', 'ja-JP']) {
      const tour = JSON.parse(read(`packages/plugin-ui/src/foundation/i18n/locales/${code}.json`)).tour
      for (const gone of ['waiting', 'done-feedback', 'skip-step']) expect(tour[gone], `${code} tour.${gone}`).toBeUndefined()
    }
  })
})
