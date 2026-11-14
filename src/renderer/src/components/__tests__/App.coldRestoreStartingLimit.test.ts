// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-scanned like the other App.*.test.ts files: App.vue cannot be mounted.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

describe('cold restore holds a slot until the pane is ready', () => {
  it('waits for the realized pane prep to settle, bounded', () => {
    const settled = body('realizeRestoredPaneSettled')
    expect(settled).toContain('await realizeRestoredPane(paneId, true)')
    expect(settled).toContain('realizedPaneIds.get(paneId)')
    expect(settled).toMatch(/preparationStatus === 'ready'/)
    expect(settled).toMatch(/preparationStatus === 'failed'/)
    expect(settled).toContain('COLD_RESTORE_SETTLE_TIMEOUT_MS')
  })

  it('records which pane a placeholder became', () => {
    expect(body('performRealizeRestoredPane')).toContain('realizedPaneIds.set(paneId, newId)')
  })

  it('runs every throttled restore batch through the settled limit', () => {
    const advance = body('advanceRestoreSession')
    const limited = advance.match(
      /runWithConcurrency\(ids, COLD_RESTORE_STARTING_LIMIT, realizeRestoredPaneSettled\)/g,
    ) ?? []
    // all/fresh, auto, interrupted, and a cold restore under the remaining scopes.
    expect(limited.length).toBe(4)
    expect(advance).not.toContain('ALL_SCOPE_RESTORE_CONCURRENCY')
  })

  it('leaves a restore the user triggers from the UI unthrottled', () => {
    expect(body('advanceRestoreSession')).toContain(
      "} else if (trigger !== 'cold') {\n      await Promise.all(ids.map((paneId) => realizeRestoredPane(paneId, true)))",
    )
  })
})
