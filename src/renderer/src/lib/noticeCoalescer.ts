/** D5 "do not ask twice": the same notice shown again within an hour is merged
 *  into the one already shown (not repeated). Keys are chosen by the caller. */
export const NOTICE_COALESCE_MS = 60 * 60 * 1000

export function createNoticeCoalescer(windowMs = NOTICE_COALESCE_MS) {
  const shownAt = new Map<string, number>()
  return {
    /** True when `key` was not shown within the window; records it as shown. */
    shouldShow(key: string, now: number = Date.now()): boolean {
      const last = shownAt.get(key)
      if (last !== undefined && now - last < windowMs) return false
      shownAt.set(key, now)
      return true
    },
  }
}
