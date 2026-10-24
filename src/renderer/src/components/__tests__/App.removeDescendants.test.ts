// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { withDescendants } from '../../lib/paneLineage'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — the wiring is asserted against the source text. The
// scope rule itself (children only, never the parent, never a sibling tree) is
// exercised through the pure helper the menu item calls.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const enLocale = readFileSync(
  resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/en-US.json'),
  'utf8'
)
const zhLocale = readFileSync(
  resolve(process.cwd(), 'packages/plugin-ui/src/foundation/i18n/locales/zh-TW.json'),
  'utf8'
)

describe('App pane context menu — Remove sub-panes', () => {
  it('closes only the spawned descendants, keeping the pane itself', () => {
    expect(appSource).toContain(
      'return withDescendants([paneId], panes.value).filter((id) => id !== paneId)'
    )
    expect(appSource).toContain('for (const id of descendantPaneIds(paneId)) await onKill(id)')
  })

  it('shows the item only when the right-clicked pane has descendants', () => {
    expect(appSource).toContain('v-if="ctxDescendantIds.length"')
    expect(appSource).toContain('@click="killDescendants(paneCtxMenu!.paneId); closePaneCtxMenu()"')
    expect(appSource).toContain("$t('action.remove-children', { count: ctxDescendantIds.length })")
    expect(enLocale).toContain('"remove-children": "Remove {count} Sub-panes"')
    expect(zhLocale).toContain('"remove-children": "移除旗下 {count} 個子面板"')
  })

  it('the scope rule: the whole subtree of the target, nothing outside it', () => {
    const panes = [
      { id: 'root-a' },
      { id: 'a1', spawnedBy: 'root-a' },
      { id: 'a1x', spawnedBy: 'a1' },
      { id: 'a2', spawnedBy: 'root-a' },
      { id: 'root-b' },
      { id: 'b1', spawnedBy: 'root-b' },
    ]
    const targets = withDescendants(['root-a'], panes).filter((id) => id !== 'root-a')
    expect(targets).toEqual(['a1', 'a1x', 'a2'])
    // A mid-tree pane removes only its own branch.
    expect(withDescendants(['a1'], panes).filter((id) => id !== 'a1')).toEqual(['a1x'])
    // A leaf has nothing to remove — the item is hidden for it.
    expect(withDescendants(['b1'], panes).filter((id) => id !== 'b1')).toEqual([])
  })
})
