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
    expect(fn).toContain('await rebuildPaneViaResume(paneId, { freshWhenNoTranscript: true })')
    // Never opens the interactive /mcp menu: only its non-interactive form.
    expect(fn).not.toMatch(/sendInput/)
  })

  it('reconnects an idle claude pane in place before falling back to the rebuild', () => {
    // 2026-11-15: the in-place reconnect keeps the conversation and the CLI's
    // background processes, which a rebuild ends.
    expect(appSource).toContain("const MCP_RECONNECT_COMMAND = '/mcp reconnect navide'")
    const at = appSource.indexOf('async function reconnectPaneMcp(')
    const fn = appSource.slice(at, appSource.indexOf('\n}\n', at))
    const inPlace = fn.indexOf("if (pane?.agentKey === 'claude' && messagingHoldKey(paneId) === null)")
    expect(inPlace).toBeGreaterThan(fn.indexOf("displayStatus !== 'idle'"))
    expect(fn).toContain("if (await injectPane(paneId, MCP_RECONNECT_COMMAND, 'mcp-reconnect', true)) return")
    expect(fn.indexOf('rebuildPaneViaResume')).toBeGreaterThan(inPlace)
  })

  it('reopens a pane nobody typed in fresh and still reports a failed rebuild', () => {
    // 2026-11-14: a never-prompted claude pane has no jsonl, so the resume
    // preflight misses; with suppressBusyToast the not-resumable / probe-failed
    // toasts were silenced too and Reconnect did nothing visible.
    const at = appSource.indexOf('async function reconnectPaneMcp(')
    const fn = appSource.slice(at, appSource.indexOf('\n}\n', at))
    expect(fn).toContain('freshWhenNoTranscript: true')
    expect(fn).not.toContain('suppressBusyToast')
  })
})

describe('a pane whose Navide tools were connected and dropped', () => {
  it('badges the pane, tells the user and offers Reconnect', () => {
    const body = handler('mcp.disconnected')
    expect(body).toContain('pane.mcpNeverConnected = true')
    expect(body).toContain("'pane.terminal.mcp-disconnected-title'")
    expect(body).toContain("'pane.terminal.mcp-disconnected-body'")
    expect(body).toContain('sysNotify.notifyPaneState(')
    expect(body).toContain('run: () => { void reconnectPaneMcp(paneId) }')
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

describe('reconnecting a pane without the user (ui.pane.reconnectMcp)', () => {
  // 2026-11-22: a pane's navide MCP dropped; neither the pane nor its
  // commander could type /mcp reconnect navide (cli_send adds a sender line),
  // so only the user's Reconnect click brought it back. The backend's
  // automatic retry and a commander's ui_invoke both come through here.
  function command(): string {
    const at = appSource.indexOf("registerCommand('ui.pane.reconnectMcp', async (args) => {")
    expect(at).toBeGreaterThan(-1)
    return appSource.slice(at, appSource.indexOf('\n})\n', at))
  }
  function inPlace(): string {
    const at = appSource.indexOf('async function reconnectPaneMcpInPlace(')
    expect(at).toBeGreaterThan(-1)
    return appSource.slice(at, appSource.indexOf('\n}\n', at))
  }

  it('is registered and documented in the action catalog', () => {
    const catalog = readFileSync(resolve(process.cwd(), 'src/renderer/src/composables/uiActionCatalog.ts'), 'utf8')
    expect(catalog).toContain("'ui.pane.reconnectMcp': { args: '{paneId}'")
    expect(command()).toContain('if (!paneId) throw new Error(`ui.pane.reconnectMcp requires ${PANE_ID_HINT}`)')
    expect(command()).toContain('return reconnectPaneMcpInPlace(paneId)')
  })

  it('only types the non-interactive command into an idle, unheld claude pane', () => {
    const fn = inPlace()
    expect(fn).toContain("if (status !== 'idle') return { sent: false, reason: 'busy', status }")
    expect(fn).toContain("if (pane.agentKey !== 'claude') return { sent: false, reason: 'unsupported-cli' }")
    expect(fn).toContain("if (hold !== null) return { sent: false, reason: 'held', hold }")
    expect(fn).toContain("await injectPane(paneId, MCP_RECONNECT_COMMAND, 'mcp-reconnect', true)")
  })

  it('never rebuilds: that ends background work and stays the user\'s click', () => {
    const fn = inPlace()
    expect(fn).not.toContain('rebuildPaneViaResume')
    expect(fn).not.toContain('rebuildPaneClean')
    expect(command()).not.toContain('rebuildPane')
  })
})
