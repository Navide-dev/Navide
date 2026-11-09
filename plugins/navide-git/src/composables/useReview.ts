import { ref, onScopeDispose } from 'vue'
import type { GitReviewPort, GitReviewResult } from '../ports/gitSurface'

export interface ReviewOptions {
  mode: 'working' | 'branch'
  base?: string
  compare?: string
}

/** One AI review at a time for the surface that owns it. The Host mints the
 *  review id when the review starts, so events that arrive before
 *  `start()` resolves are held and replayed once the id is known. */
export function useReview(port: GitReviewPort) {
  const isReviewing = ref(false)
  const reviewResult = ref<GitReviewResult | null>(null)
  const reviewError = ref('')
  const reviewElapsed = ref(0)
  let reviewId: string | null = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let early: Array<{ id: string; apply: () => void }> = []

  function finish(): void {
    isReviewing.value = false
    reviewId = null
    early = []
    if (elapsedTimer !== null) { clearInterval(elapsedTimer); elapsedTimer = null }
  }

  function route(id: string, apply: () => void): void {
    if (!isReviewing.value) return
    if (reviewId === null) { early.push({ id, apply }); return }
    if (id === reviewId) apply()
  }

  const offs = [
    port.onResult((id, result) => route(id, () => { reviewResult.value = result })),
    port.onEnd((id) => route(id, () => {
      if (!reviewResult.value) reviewError.value = 'Could not parse review output. Try again.'
      finish()
    })),
    port.onError((id, message) => route(id, () => {
      reviewError.value = message
      finish()
    })),
  ]

  async function startReview(options: ReviewOptions): Promise<void> {
    reviewResult.value = null
    reviewError.value = ''
    reviewElapsed.value = 0
    reviewId = null
    early = []
    isReviewing.value = true
    elapsedTimer = setInterval(() => { reviewElapsed.value++ }, 1000)
    try {
      const id = await port.start(options)
      // Stopped while the Host was still starting it: stop the review it began.
      if (!isReviewing.value) {
        void port.stop(id).catch(() => { /* the Host ends it with the view anyway */ })
        return
      }
      reviewId = id
      const held = early
      early = []
      for (const event of held) if (event.id === id) event.apply()
    } catch (error) {
      reviewError.value = error instanceof Error ? error.message : String(error)
      finish()
    }
  }

  function stopReview(): void {
    if (reviewId) void port.stop(reviewId).catch(() => { /* the Host ends it with the view anyway */ })
    finish()
  }

  onScopeDispose(() => {
    if (isReviewing.value) stopReview()
    for (const off of offs) off()
  })

  return { isReviewing, reviewResult, reviewError, reviewElapsed, startReview, stopReview }
}
