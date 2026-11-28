// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The pane right-click menu offers "Upgrade to commander" (0.2.51), the same
// entry the sidebar row's action bar has. App.vue is not mountable here (see
// App.fitWidthMenu.test.ts), so this guards the wiring; the dialog it opens is
// covered by the commander store and component tests.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('Upgrade to commander in the pane context menu', () => {
  const item = block('data-testid="ctx-commander-upgrade"', '</div>')

  it('opens the create dialog on the right-clicked pane and closes the menu', () => {
    expect(item).toContain('commanders.openCreate(paneCtxMenu!.paneId); closePaneCtxMenu()')
    expect(item).toContain("$t('commander.action.upgrade')")
  })

  it('is left out for a terminal and for a pane that is already a commander', () => {
    const tag = appSource.slice(appSource.lastIndexOf('<div', appSource.indexOf('data-testid="ctx-commander-upgrade"')),
      appSource.indexOf('data-testid="ctx-commander-upgrade"'))
    expect(tag).toContain("paneCtxView.agentKey !== 'terminal'")
    expect(tag).toContain('!commanders.bodyPanes.value.has(paneCtxView.id)')
  })

  it('belongs to the single-pane menu, not the batch one', () => {
    const batch = block('<template v-if="ctxIsBatch">', '<template v-else>')
    expect(batch).not.toContain('ctx-commander-upgrade')
  })
})
