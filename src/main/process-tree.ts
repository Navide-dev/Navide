/**
 * Signalling a spawned process and everything it spawned.
 *
 * The backend we spawn is not the backend. In a packaged build it is a
 * PyInstaller onefile bootloader that unpacks itself and forks the real Python
 * process; in dev it is `uv`, which forks python the same way. Under that real
 * process sit the PTY children, each in its own session (see terminals.py).
 *
 * SIGTERM is fine to send to the handle alone — the bootloader forwards it, and
 * the backend's shutdown sweep takes the PTY tree down. SIGKILL is not: it
 * cannot be caught, so nothing forwards it. Killing the handle leaves the real
 * backend running, still holding the port and the shared app-data state, with
 * its PTY children reparented to init. Every SIGKILL therefore has to name each
 * process itself, which is what this module is for.
 */

import { execFileSync } from 'node:child_process'

import { isWindows } from '../shared/osplat'

/**
 * `pid` and all of its descendants, deepest first. Parses the two-column
 * `pid ppid` snapshot `ps` produces; unparsable lines are ignored.
 */
export function descendantsFirst(pid: number, psSnapshot: string): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const line of psSnapshot.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const child = Number(m[1])
    const parent = Number(m[2])
    if (child === parent) continue // pid 0 parents itself on some systems
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(child)
    else childrenOf.set(parent, [child])
  }

  const ordered: number[] = []
  const visited = new Set<number>()
  const walk = (current: number): void => {
    if (visited.has(current)) return // a corrupt snapshot must not loop forever
    visited.add(current)
    for (const child of childrenOf.get(current) ?? []) walk(child)
    ordered.push(current) // post-order: children before the parent that forked them
  }
  walk(pid)
  return ordered
}

/**
 * Send `signal` to `pid` and every process descended from it, children first.
 * Best-effort throughout: a process that died between the snapshot and the
 * signal is the normal case, not an error.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number' || pid <= 1) return

  if (isWindows()) {
    // No `ps` and no signals: taskkill walks the tree itself (`/T`), and `/F`
    // is the only form that reliably ends a console process — without it
    // taskkill posts WM_CLOSE, which a windowless backend never sees. So on
    // Windows `signal` is always the forceful one; the Windows arm of the
    // backend's stop path relies on exactly that (see backend.ts).
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5_000,
        windowsHide: true
      })
    } catch (err) {
      // Already gone (taskkill exits non-zero for that too), part of the tree
      // missed, or taskkill unavailable — nothing else can be named. Say so: a
      // tree this missed is left running with nothing in the log.
      console.warn(`[process-tree] taskkill /PID ${pid} /T /F did not succeed: ${(err as Error).message}`)
    }
    return
  }

  let targets = [pid]
  try {
    // `ps` by name, not `/bin/ps`: NixOS and Guix have no /bin beyond sh, and
    // the absolute path there meant no snapshot — so a SIGKILL took only the
    // bootloader and left the Python backend and its PTYs running.
    const snapshot = execFileSync('ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000
    })
    targets = descendantsFirst(pid, snapshot)
  } catch {
    /* no snapshot (no ps, timed out) — still take down what we can name */
  }

  for (const target of targets) {
    if (target <= 1) continue
    try {
      process.kill(target, signal)
    } catch {
      /* already gone */
    }
  }
}
