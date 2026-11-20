// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// App.vue cannot be mounted here (see App.spawnAdvisories.test.ts), so these
// parse the source to guard the wiring that opens plain terminal panes to MCP:
// addressable, spawnable, and never typed anything but the command itself.
// The pieces with logic of their own are unit tested directly —
// useAgentMessagingTerminal.test.ts, spawnKickoff.test.ts, agentSpawnGate.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('plain terminal panes over MCP', () => {
  it('registers terminals in the messaging registry like any other pane', () => {
    const fn = block('function registerPaneMessaging(', '\n}\n')
    expect(fn).not.toContain("'terminal'")
    expect(fn).toContain('messaging.registerPane(pane.id, pane.agentKey, preferred)')
  })

  it('whitelists terminal for both spawn gates but counts agent panes only', () => {
    for (const marker of ['function spawnGateContextFor(', 'function standaloneSpawnGateContext(']) {
      const fn = block(marker, '\n}\n')
      expect(fn).toContain('validAgentKeys: agentSpecs.map((s) => s.agentKey)')
      expect(fn).toContain("cliPaneCount: panes.value.filter((p) => p.realized && p.agentKey !== 'terminal').length")
    }
  })

  it('types a terminal kickoff bare and once, never the report-back kickoff', () => {
    const fn = block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane')
    const branch = fn.indexOf('if (pane.agentKey === TERMINAL_AGENT_KEY) {')
    const rendered = fn.indexOf('renderSpawnKickoff(task, parentName)')
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(rendered)
    const terminalBranch = fn.slice(branch, rendered)
    expect(terminalBranch).toContain(
      "injectPane(paneId, task, 'agent-spawn', true, undefined, seen, undefined, undefined, opts.prefill === true)",
    )
    expect(terminalBranch).not.toContain('runKickoffAttempts')
    expect(terminalBranch).not.toContain('spawnReportPending')
  })

  it('holds a message while a terminal is printing', () => {
    const fn = block('function messagingHoldKey(', '\n}\n')
    expect(fn).toContain("if (pane.agentKey === TERMINAL_AGENT_KEY && status === 'running') return 'mid-turn'")
  })

  it('does not mark a terminal delivery pending — a shell writes no user record to release it', () => {
    const fn = block('async function deliverAgentMessage(', '\n}\n')
    expect(fn).toContain('?.agentKey !== TERMINAL_AGENT_KEY')
  })

  it('leaves terminals out of a group broadcast', () => {
    const cmd = block("registerCommand('ui.groupPeers'", "\nregisterCommand('ui.pane.getStatus'")
    expect(cmd).toContain('.filter((p) => p.agentKey !== TERMINAL_AGENT_KEY)')
  })

  it('holds a terminal whose shell is not in front of its tty (a quiet program)', () => {
    const fn = block('function messagingHoldKey(', '\n}\n')
    expect(fn).toContain("pane.agentKey === TERMINAL_AGENT_KEY && terminalAtPrompt.get(paneId) === false) return 'foreground'")
    expect(fn).toContain('pane.agentKey === TERMINAL_AGENT_KEY ? TERMINAL_TYPING_HOLD_MS : TYPING_HOLD_MS')
    expect(appSource).toContain('const TERMINAL_TYPING_HOLD_MS = 60_000')
    // Polled on the pump tick, which is what re-opens the gate.
    expect(block('_msgPumpTimer = window.setInterval(() => {', '})')).toContain('void refreshTerminalPrompts()')
  })

  it('asks the backend to refuse every write unless the shell is at its prompt, and requeues on refusal', () => {
    const fn = block('async function injectText(', '\n}\n')
    expect(fn).toContain(
      'const shellGuard = shellTarget ? { require_shell_prompt: true, ...(prefill ? { prefill: true } : {}) } : {}',
    )
    expect(fn.match(/\.\.\.shellGuard/g)?.length).toBe(2) // content chunks and the Enter
    const deliver = block('async function deliverAgentMessage(', '\n}\n')
    expect(deliver).toContain('if (!ok && outcome.foregroundBusy) {')
    expect(deliver).toContain('return null')
  })

  it('a prefill (submit: false) goes to a shell only, is flagged on every write and stops before Enter', () => {
    const fn = block('async function injectText(', '\n}\n')
    expect(fn).toContain('if (prefill && !shellTarget) return false')
    const stop = fn.indexOf('if (prefill) return true')
    expect(stop).toBeGreaterThan(-1)
    expect(stop).toBeLessThan(fn.indexOf("data: '\\r'"))
    const deliver = block('async function deliverTerminalPrefill(', '\n}\n')
    expect(deliver).toContain('undefined, true,')
    expect(deliver).toContain('if (outcome.commandRefused) return { failed: rawReason(outcome.commandRefused) }')
    expect(appSource).toContain('? deliverTerminalPrefill(paneId, text, shouldAbort)')
  })

  it('presses Enter once for a shell and reports it typed, never resending Enter', () => {
    const fn = block('async function injectText(', '\n}\n')
    const branch = fn.slice(fn.indexOf('if (shellTarget) {\n    // One Enter'), fn.indexOf('const MAX_SUBMITS = 3'))
    expect(branch.match(/data: '\\r'/g)?.length).toBe(1)
    expect(branch).toContain('shellSubmitEvidence(')
    expect(branch).toContain('return true')
  })

  it('refuses a multi-line command for a shell without bracketed paste on every path', () => {
    expect(block('refuseDelivery: (paneId, envelope) => {', '},')).toContain('paneMultilineRefusal(paneId, envelope)')
    const kickoff = block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane')
    expect(kickoff).toContain('const multiline = paneMultilineRefusal(paneId, task)')
    const inject = block('async function injectText(', '\n}\n')
    expect(inject).toContain('if (shellTarget && paneMultilineRefusal(paneId as string, body)) return false')
    // Paste guards for a shell only when it turned mode 2004 on.
    expect(inject).toContain("? paneRefs[paneId as string]?.isBracketedPasteActive?.() === true")
  })

  it('reads a guarded write refusal from the payload, where the backend puts it', () => {
    const fn = block('async function injectText(', '\n}\n')
    // make_response always answers ok at the envelope; the refusal is payload.ok.
    expect(fn.match(/resp\.payload\?\.ok === false/g)?.length).toBe(2)
    expect(fn).not.toMatch(/if \(!resp\.ok\) \{\n\s*noteShellRefusal/)
    expect(fn).toContain("if (payload?.error === 'command-refused') {")
  })

  it('fails a refused command for good and says why, on the message and the kickoff paths', () => {
    const deliver = block('async function deliverAgentMessage(', '\n}\n')
    expect(deliver).toContain('if (!ok && outcome.commandRefused) return { failed: rawReason(outcome.commandRefused) }')
    const kickoff = block('async function kickoffRequestedPane(', '\n/** Spawn + kick off a pane')
    expect(kickoff).toContain('seen.commandRefused ?? TERMINAL_KICKOFF_REASON[outcome]')
  })
})

// 0.2.46: a terminal opened over MCP landed on a tab the user was not looking
// at, and read as "it never opened". Agent panes keep their placement and get
// no note; a terminal off screen comes back with where it is and how to show it.
describe('terminalPlacementNote', () => {
  function note(opts: {
    pane: Record<string, unknown>
    onScreen?: boolean
    pluginTab?: string | null
    workspace?: string
  }): string | null {
    const fn = block('function terminalPlacementNote(', '\n}\n') + '\n}'
    const deps = {
      panes: { value: [{ id: 'p1', agentKey: 'terminal', workspacePath: '/w', messagingName: 'shell', ...opts.pane }] },
      TERMINAL_AGENT_KEY: 'terminal',
      normWs: (p: string) => p.replace(/\/+$/, ''),
      currentWorkspace: { value: opts.workspace ?? '/w' },
      activePluginMainKey: { value: opts.pluginTab ?? null },
      tabFilteredPaneIds: { value: new Set(opts.onScreen === false ? [] : ['p1']) },
      runGroups: { value: [{ id: 'rg-1', name: 'Run 1' }] },
    }
    const js = ts.transpileModule(`${fn}\nreturn terminalPlacementNote('p1')`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    return new Function(...Object.keys(deps), js)(...Object.values(deps)) as string | null
  }

  it('says nothing for a terminal on screen, or for an agent pane anywhere', () => {
    expect(note({ pane: {} })).toBeNull()
    expect(note({ pane: { agentKey: 'claude' }, onScreen: false })).toBeNull()
  })

  it('names the tab and the focus call for a terminal on another tab', () => {
    const text = note({ pane: { runGroupId: 'rg-1' }, onScreen: false })
    expect(text).toContain('tab "Run 1", which is not the tab on screen')
    expect(text).toContain('ui.pane.focus {"paneId": "p1"}')
  })

  it('reports a terminal hidden behind a plugin tab, and one in a background workspace', () => {
    expect(note({ pane: {}, pluginTab: 'plans' })).toContain('tab "manual", which a plugin tab is covering')
    expect(note({ pane: { workspacePath: '/other' } })).toContain('workspace /other, which is not the one on screen')
  })
})
