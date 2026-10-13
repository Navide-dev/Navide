// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// useTerminal.kill rejects a refused kill (TERMINAL_NOT_OWNED) instead of
// resolving it as done. onKill catches that — and for the callers that keep the
// pane record (idle reclaim, kill-all) no unspawn follows to sweep what the kill
// missed, so the PTY ran on with nothing pointing at it. The catch has to ask
// the backend for the same sweep a kept-record workspace close asks for.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

describe('onKill when the terminal kill is refused', () => {
  const fn = body(appSource, 'onKill')
  const killStep = fn.slice(fn.indexOf('await ref.kill('), fn.indexOf("pane?.origin === 'pipeline'"))

  it('sweeps the pane\'s PTY when no unspawn will follow', () => {
    expect(killStep).toContain('catch (err)')
    expect(killStep).toContain("'manual_pane.release_pty'")
    expect(killStep).toMatch(/if \(!markRemoved\)/)
  })
})
