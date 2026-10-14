// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Phase 4 of folding the embedded AI panel (AiCliDock) into the pane system:
// the main window names the window a panel lives in wherever a panel can show
// up next to its panes. Every one of these is a branch that only a panel
// (a roster entry or history entry with a non-main surface) can take.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')

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

const locales = ['en-US', 'zh-TW', 'ja-JP'].map((l) =>
  JSON.parse(read(`packages/plugin-ui/src/foundation/i18n/locales/${l}.json`)),
)

describe('the @-mention menu names a panel\'s window', () => {
  it('carries the roster entry\'s surface into the remote targets', () => {
    const fn = body(appSource, 'refreshRemoteMessagingTargets')
    expect(fn).toContain('surface?: string')
    expect(fn).toContain("...(p.surface ? { surface: p.surface } : {})")
  })

  it('adds a window label only to a panel row', () => {
    const fn = body(appSource, 'mentionCandidatesFor')
    expect(fn).toContain('const windowKey = dockWindowLabelKey(t.surface)')
    expect(fn).toContain('...(windowKey ? { windowLabel: i18n.global.t(windowKey) } : {})')
  })
})

describe('closing the workspace says its Pipeline Manager panel ends too', () => {
  it('appends the line only when the roster holds that workspace\'s pm panel', () => {
    expect(appSource).toContain(
      'workspaceHasPmPanel(remoteMessagingTargets.value, currentWorkspace.value, normWs)'
    )
    const dialog = appSource.slice(appSource.indexOf('<Teleport v-if="confirmCloseWorkspace"'))
    const close = dialog.slice(0, dialog.indexOf('</Teleport>'))
    expect(close).toContain(`v-if="closingWorkspaceHasPmPanel"`)
    expect(close).toContain(`$t('confirm-close.ws-pm-panel-extra')`)
  })
})

describe('Agent History opens a pm panel\'s window instead of resuming it here', () => {
  it('wires open-in-window to the Pipeline Manager', () => {
    expect(appSource).toContain('@open-in-window="onOpenHistoryPanelWindow"')
    const fn = body(appSource, 'onOpenHistoryPanelWindow')
    expect(fn).toContain("if (entry.surface !== 'pm') return")
    expect(fn).toContain('showHistory.value = false')
    expect(fn).toContain('openPipelineManager()')
  })
})

describe('the dock window keys exist in every locale', () => {
  it.each(['pm', 'plans', 'git', 'editor', 'open-in', 'resumes-in', 'resumes-in-window', 'address-title'])(
    'dockWindow.%s',
    (key) => {
      for (const l of locales) expect(typeof l.dockWindow?.[key]).toBe('string')
    },
  )
  it('confirm-close.ws-pm-panel-extra', () => {
    for (const l of locales) expect(typeof l['confirm-close']['ws-pm-panel-extra']).toBe('string')
  })
})

describe('a live embedded panel is not stamped removed', () => {
  it('reconciles history liveness through historyEntryIsLive, with the roster for panels', () => {
    const fn = body(appSource, 'reconcileSpawnHistoryLiveness')
    expect(fn).toContain('const rosterPaneIds = new Set(remoteTargetByPane.keys())')
    expect(fn).toContain('if (!isHistoryEntryRemoved(e) && !historyEntryIsLive(e, livePaneIds, rosterPaneIds)) e.removedAt = reconciledAt')
    // Everything else about it is as it was.
    expect(fn).toContain('if (isDetachedWindow) return')
    expect(fn).toContain('const livePaneIds = new Set(panes.value.map((p) => p.id))')
  })
})
