// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Starting a workspace fresh was the one restore batch nothing capped.
//
// Three ceilings exist and all three missed it at once: the scope setting is
// skipped for a fresh start (it takes the whole pending list), the
// all-scope concurrency limit is conditioned on the decision being 'resume',
// and the resume semaphore in useTerminal only engages when isResume is true —
// which a fresh spawn, by definition, is not. A twenty-pane workspace opened
// with "Never" sent twenty terminal.create at once.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const terminalSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/platform/terminal/composables/useTerminal.ts'),
  'utf8'
)

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

const advance = body(appSource, 'advanceRestoreSession')

describe('a fresh restore batch has a ceiling', () => {
  it('runs a cold fresh batch through the concurrency limiter', () => {
    expect(advance).toContain("const unthrottledBatch = decision === 'fresh' && trigger === 'cold'")
    expect(advance).toContain(
      "if (unthrottledBatch || (decision === 'resume' && session.scope === 'all'))"
    )
  })

  it('keeps the all-scope resume ceiling it already had', () => {
    // The fix adds a case; it must not replace one. (The ceiling itself became
    // the prep-settled cold restore limit — App.coldRestoreStartingLimit.test.ts.)
    expect(advance).toContain(
      'await runWithConcurrency(ids, COLD_RESTORE_STARTING_LIMIT, realizeRestoredPaneSettled)'
    )
  })

  it('leaves a UI-triggered restore unbounded, as before', () => {
    // A resume under 'single'/'page'/'tab' is already capped by the semaphore at
    // whatever the user configured, so a restore the user triggers still goes
    // straight through. Only a cold one is held to the starting limit.
    expect(advance).toContain("} else if (trigger !== 'cold') {")
    expect(advance).toContain('await Promise.all(ids.map((paneId) => realizeRestoredPane(paneId, true)))')
  })

  it('is the batch the semaphore cannot see', () => {
    // Why this needed its own ceiling rather than the existing one: the
    // semaphore keys off isResume, and a fresh start never sets it.
    expect(terminalSource).toContain('const throttled = !!opts.isResume')
    expect(body(appSource, 'performRealizeRestoredPane')).toContain(
      "const forceFresh = decision === 'fresh'"
    )
    expect(body(appSource, 'performRealizeRestoredPane')).toContain(
      'const attemptResume = !forceFresh && shouldAttemptResume(canResume)'
    )
  })

  it('still takes the whole pending list when starting fresh', () => {
    // The scope setting does not apply to a fresh start — that is existing
    // behaviour, and the ceiling is what makes it survivable rather than a
    // reason to change what gets started.
    expect(advance).toContain('pendingRestorePaneIds(panes.value, session.workspacePath)')
  })
})
