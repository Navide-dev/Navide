// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The backend's mcp_connect_watch reports a pane whose CLI never reached
// /plan-mcp (2026-11-12: thirteen panes sat without Navide tools for a day).
// Source-scanned like the other App.*.test.ts files: App.vue cannot be mounted.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function handler(event: string): string {
  const at = appSource.indexOf(`backend.on('${event}', `)
  expect(at).toBeGreaterThan(-1)
  return appSource.slice(at, appSource.indexOf('\n})\n', at))
}

describe('a pane whose Navide tools never connected', () => {
  it('badges the pane this window holds and tells the user', () => {
    const body = handler('mcp.never_connected')
    expect(body).toContain('pane.mcpNeverConnected = true')
    expect(body).toContain("'pane.terminal.mcp-never-connected-title'")
    expect(body).toContain('notifyRestore.toast(')
    expect(body).toContain('sysNotify.notifyPaneState(')
  })

  it('drops the badge when the pane connects after all', () => {
    expect(handler('mcp.connected')).toContain('pane.mcpNeverConnected = false')
  })

  it('passes the flag to the pane', () => {
    expect(appSource).toContain(':mcp-never-connected="p.mcpNeverConnected"')
  })

  it('offers Reconnect on the toast and the badge, through the idle-only rebuild', () => {
    const body = handler('mcp.never_connected')
    expect(body).toContain("label: i18n.global.t('pane.terminal.mcp-reconnect')")
    expect(body).toContain('run: () => { void reconnectPaneMcp(paneId) }')
    expect(appSource).toContain(':reconnect-mcp="() => reconnectPaneMcp(p.id)"')
    const at = appSource.indexOf('async function reconnectPaneMcp(')
    const fn = appSource.slice(at, appSource.indexOf('\n}\n', at))
    expect(fn).toContain("if (paneRefs[paneId]?.displayStatus !== 'idle')")
    expect(fn).toContain("'pane.terminal.mcp-reconnect-busy'")
    expect(fn).toContain('await rebuildPaneViaResume(paneId, { suppressBusyToast: true })')
    // Never types into the pane: /mcp is an interactive menu.
    expect(fn).not.toMatch(/sendInput|\/mcp/)
  })
})

describe('a message parked on an unopened pane for ten minutes', () => {
  it('tells the user and offers to open the pane, from the window that holds it', () => {
    const body = handler('agent_msg.parked_overdue')
    expect(body).toContain('!p.realized && p.messagingName === name')
    expect(body).toContain("'pane.terminal.parked-overdue-body'")
    expect(body).toContain("label: i18n.global.t('pane.terminal.parked-overdue-open')")
    expect(body).toContain('void realizeRestoredPane(paneId, false, { explicit: true })')
  })
})
