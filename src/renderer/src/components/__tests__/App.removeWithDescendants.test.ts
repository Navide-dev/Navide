// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { withDescendants } from '../../lib/paneLineage'

// Like App.removeDescendants.test.ts: mounting App starts backend/terminal
// lifecycles, so the wiring is asserted against the source text, and the scope
// rule is exercised through the pure helper the menu item ends up calling.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const enLocale = readFileSync(
  resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/en-US.json'),
  'utf8'
)
const zhLocale = readFileSync(
  resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'),
  'utf8'
)

describe('App pane context menu — Remove with sub-panes', () => {
  it('closes the descendants first, then the pane itself', () => {
    expect(appSource).toContain(
      'async function killWithDescendants(paneId: string): Promise<void> {\n' +
        '  await killDescendants(paneId)\n' +
        '  await onKill(paneId)\n' +
        '}'
    )
  })

  it('shows the item only when the right-clicked pane has descendants', () => {
    expect(appSource).toContain(
      '@click="killWithDescendants(paneCtxMenu!.paneId); closePaneCtxMenu()"'
    )
    expect(appSource).toContain(
      "$t('action.remove-with-children', { count: ctxDescendantIds.length + 1 })"
    )
    expect(appSource).toContain("$t('action.remove-with-children-title')")
    expect(enLocale).toContain('"remove-with-children": "Remove All {count} Panes"')
    expect(zhLocale).toContain('"remove-with-children": "移除全部 {count} 個面板"')
    expect(enLocale).toContain('"remove-with-children-title"')
    expect(zhLocale).toContain('"remove-with-children-title"')
  })

  it('leaves the existing single-pane Remove item untouched', () => {
    expect(appSource).toContain(
      '<div class="pane-ctx-item danger" @click="onKill(paneCtxMenu!.paneId); closePaneCtxMenu()">'
    )
    expect(appSource).toContain('for (const id of descendantPaneIds(paneId)) await onKill(id)')
  })

  it('the scope rule: the target plus its whole subtree, nothing outside it', () => {
    const panes = [
      { id: 'root-a' },
      { id: 'a1', spawnedBy: 'root-a' },
      { id: 'a1x', spawnedBy: 'a1' },
      { id: 'a2', spawnedBy: 'root-a' },
      { id: 'root-b' },
      { id: 'b1', spawnedBy: 'root-b' },
    ]
    // What the item closes = descendants (killDescendants) + the pane itself.
    const descendants = withDescendants(['root-a'], panes).filter((id) => id !== 'root-a')
    expect([...descendants, 'root-a']).toEqual(['a1', 'a1x', 'a2', 'root-a'])
    // A mid-tree pane takes only its own branch with it.
    const mid = withDescendants(['a1'], panes).filter((id) => id !== 'a1')
    expect([...mid, 'a1']).toEqual(['a1x', 'a1'])
    // The other root tree is never touched.
    expect(descendants).not.toContain('root-b')
    expect(descendants).not.toContain('b1')
  })

  it('the count in the label matches what gets closed', () => {
    const panes = [
      { id: 'p' },
      { id: 'c1', spawnedBy: 'p' },
      { id: 'c2', spawnedBy: 'c1' },
    ]
    const descendantCount = withDescendants(['p'], panes).filter((id) => id !== 'p').length
    expect(descendantCount + 1).toBe(3)
  })
})
