// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ACP panes (no PTY) in App.vue. App.vue is not practical to mount (see
// App.logPreview.test.ts); the pane itself is tested in AcpPane.test.ts and the
// decisions in lib/__tests__/acpPane.test.ts. What this file guards is the
// wiring of the three risks the 2026-10-23 inventory ranked highest
// (navide-devmap-mockups/planb/0229/INVENTORY-acp-pty-assumptions.md):
//   1. closing a pane must stop its ACP agent (it has no terminal session id),
//   2. the messaging gate must not hold an ACP pane as 'starting' forever,
//   3. a message to an ACP pane is never typed: the messaging layer's last
//      step hands it to the backend as a prompt (decided 2026-10-23, option B).
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('ACP panes in App.vue', () => {
  it('risk 1: onKill stops an ACP pane even though it has no terminal session id', () => {
    const onKill = block('async function onKill(', '\n}\n')
    expect(onKill).toContain("if (ref?.sessionId || (ref && pane?.display === 'acp')) {")
    expect(onKill).toContain('await ref.kill({ force: force })')
  })

  it('risk 2: the messaging gate answers an ACP pane from its own state, before any PTY gate', () => {
    const gate = block('function messagingHoldKey(', '\n}\n')
    const acp = gate.indexOf("if (pane.display === 'acp') return acpMessagingHoldKey(")
    expect(acp).toBeGreaterThan(-1)
    expect(acp).toBeLessThan(gate.indexOf('resumeBootHold({'))
    expect(acp).toBeLessThan(gate.indexOf("return 'not-ready'"))
  })

  it('risk 3: a message to an ACP pane goes to the agent as a prompt, before any typing path', () => {
    const deliver = block('async function deliverAgentMessage(', '\n}\n')
    const acp = deliver.indexOf("if (panes.value.find((p) => p.id === paneId)?.display === 'acp') {")
    expect(acp).toBeGreaterThan(-1)
    expect(deliver).toContain('const sent = await paneRefs[paneId]?.sendPrompt?.(text)')
    // No session yet (or no pane) puts the message back at the head of the queue.
    expect(deliver).toContain('return sent === undefined ? null : sent')
    expect(acp).toBeLessThan(deliver.indexOf('injectPane('))
    expect(acp).toBeLessThan(deliver.indexOf('markDeliveredPending'))
    // It is delivered, not refused, and still offered no push into a TUI composer.
    const deps = block('messaging.configureMessaging({', 'persistAppend:')
    expect(deps).not.toContain('ACP_PANE_DELIVERY_REFUSAL')
    expect(deps).toMatch(/target\?\.isLogin \|\| target\?\.display === 'acp' \? null : pushTargetForMessaging\(paneId\)/)
  })

  it('interrupts an ACP pane through its own interrupt (session/cancel)', () => {
    const onInterrupt = block('async function onInterrupt(', '\n}\n')
    expect(onInterrupt).toContain("if (!ref || (!ref.sessionId && ref.display !== 'acp')) return false")
  })

  it('starts an ACP pane through acp.create, never a shell command or session marker', () => {
    const spawn = block('async function spawnPane(', '\nasync function onManualSpawn(')
    expect(spawn).toContain("const acpDisplay = opts.display === 'acp' && opts.agentKey !== 'terminal' && !opts.isLogin && !opts.loginProfileId")
    expect(spawn).toContain('!acpDisplay && SESSION_MARKER_AGENTS.has(opts.agentKey)')
    const branch = spawn.indexOf("if (pane.display === 'acp') {")
    expect(branch).toBeGreaterThan(-1)
    // Taken before the terminal spawn, after the output log path it shares
    // with a PTY pane (the backend appends the transcript there).
    expect(branch).toBeLessThan(spawn.indexOf('command: shellCommandArgv('))
    expect(branch).toBeGreaterThan(spawn.indexOf('const outputLogFile ='))
    expect(spawn).toContain("await ref.spawn({ command: [], cwd: opts.workspacePath ?? '', agentKey: opts.agentKey, outputLogFile })")
    expect(spawn.slice(branch)).toMatch(/historyEntry\.outputLogFile = outputLogFile/)
  })

  it('mounts an AcpPane for an ACP pane and a TerminalPane otherwise, both kept alive off screen', () => {
    const acp = appSource.indexOf('<AcpPane')
    const terminal = appSource.indexOf('<TerminalPane')
    expect(acp).toBeGreaterThan(-1)
    expect(acp).toBeLessThan(terminal)
    const acpTag = appSource.slice(acp, appSource.indexOf('/>', acp))
    expect(acpTag).toContain(`v-if="p.realized && p.display === 'acp'"`)
    expect(acpTag).toContain('v-show="onScreenPaneIds.has(p.id)"')
    expect(acpTag).toContain(':acp-port="acpPort"')
    expect(appSource.slice(terminal, terminal + 80)).toMatch(/<TerminalPane\s+v-else-if="p.realized"/)
  })

  it('holds pane refs as the shared PaneHandle shape', () => {
    expect(appSource).toContain('const paneRefs = reactive<Record<string, PaneHandle | null>>({})')
  })
})
