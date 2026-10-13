// Navide's Settings → Resource limits can cap test-runner workers for new
// panes by setting NAVIDE_TEST_MAX_WORKERS (backend resource_limits.py).
// Unset or unparseable means "no cap": vitest sizes its pool as it always did.

const MAX = 64

export function testWorkerCap(env: Record<string, string | undefined>): { maxWorkers?: number; minWorkers?: number } {
  const raw = env.NAVIDE_TEST_MAX_WORKERS?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return {}
  const n = Number(raw)
  if (n < 1 || n > MAX) return {}
  // minWorkers must not exceed maxWorkers, and vitest's default floor can.
  return { maxWorkers: n, minWorkers: 1 }
}
