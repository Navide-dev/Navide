/** Exponential backoff with full jitter: 1s, 2s, 4s ... capped at 30s. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
  return Math.round(500 + random() * (ceiling - 500))
}
