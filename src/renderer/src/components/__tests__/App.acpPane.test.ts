// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ACP panes in App.vue. App.vue is not practical to mount (see
// App.logPreview.test.ts); the host is lib/acpHost.ts (tested in
// lib/__tests__/acpHost.test.ts) and App.tuiUnchanged.test.ts proves every
// hooked function is otherwise main's. What this file pins is that each hook
// sits where it must — ahead of the terminal-only code that would otherwise
// see an ACP pane as "no terminal session" — for the three risks the
// 2026-10-23 inventory ranked highest:
//   1. closing a pane must stop its ACP agent (it has no terminal session id),
//   2. the messaging gate must not hold an ACP pane as 'starting' forever,
//   3. a message to an ACP pane is never typed into a terminal.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}\n', start))
}

describe('ACP hooks in App.vue', () => {
  it('ACP panes have their own registry, never paneRefs', () => {
    expect(appSource).toContain('const paneRefs = reactive<Record<string, InstanceType<typeof TerminalPane> | null>>({})')
    expect(appSource).toContain('const acp = createAcpHost({')
    expect(appSource).toContain(':ref="(el) => acp.setRef(p.id, el)"')
  })

  it('risk 1: onKill stops an ACP pane before the terminal-session check', () => {
    const onKill = fn('onKill')
    const hook = onKill.indexOf('if (acp.owns(paneId)) await acp.kill(paneId, { force })')
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(onKill.indexOf('if (ref?.sessionId) {'))
    // Nothing may bail out on a missing terminal session before the hook.
    expect(onKill.slice(0, hook)).not.toMatch(/if \(!ref\?\.sessionId\)[^\n]*return/)
  })

  it('risk 2: the messaging gate answers an ACP pane first, before any PTY gate', () => {
    const gate = fn('messagingHoldKey')
    const hook = gate.indexOf('if (acp.owns(paneId)) return acp.holdKey(paneId)')
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(gate.indexOf('resumeBootHold({'))
    expect(hook).toBeLessThan(gate.indexOf("return 'gone'"))
  })

  it('risk 3: a message to an ACP pane goes to the host, never to the typing path or a push', () => {
    const deliver = fn('deliverAgentMessage')
    const hook = deliver.indexOf('if (acp.owns(paneId)) return acp.deliver(paneId, text)')
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(deliver.indexOf('injectPane('))
    expect(hook).toBeLessThan(deliver.indexOf('markDeliveredPending'))
    const push = fn('pushTargetForMessaging')
    expect(push.indexOf('if (acp.owns(paneId)) return null')).toBeLessThan(push.indexOf('pushReadyPanes.get(paneId)'))
  })

  it('interrupts an ACP pane through the host, before the terminal-session check', () => {
    const onInterrupt = fn('onInterrupt')
    const hook = onInterrupt.indexOf('if (acp.owns(paneId)) return acp.interrupt(paneId, opts)')
    expect(hook).toBeGreaterThan(-1)
    expect(hook).toBeLessThan(onInterrupt.indexOf('if (!ref?.sessionId) return false'))
  })

  it('claims an ACP pane before it is mounted and starts it before the terminal spawn', () => {
    const spawn = fn('spawnPane')
    const claim = spawn.indexOf('acp.claim(id, opts)')
    const start = spawn.indexOf('if (acp.owns(id)) return acp.start(id, opts)')
    expect(claim).toBeGreaterThan(-1)
    // Before the record is listed (and so mounted), after it exists.
    expect(claim).toBeGreaterThan(spawn.indexOf('const pane: ActivePane = {'))
    expect(claim).toBeLessThan(spawn.indexOf('panes.value.push(pane)'))
    expect(start).toBeLessThan(spawn.indexOf('const ref = paneRefs[id]'))
    expect(start).toBeLessThan(spawn.indexOf('command: shellCommandArgv('))
  })

  it('mounts AcpPane only for an ACP pane, and the TerminalPane block unchanged otherwise', () => {
    const acpBlock = appSource.indexOf('<template v-if="acp.owns(p.id)">')
    const terminal = appSource.indexOf('<TerminalPane')
    expect(acpBlock).toBeGreaterThan(-1)
    expect(appSource.slice(acpBlock, terminal)).toContain('<template v-else>')
    expect(appSource.slice(terminal, terminal + 60)).toMatch(/<TerminalPane\s+v-if="p.realized"/)
  })
})
