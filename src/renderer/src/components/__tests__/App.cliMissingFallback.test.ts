// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so these tests parse
// the source text instead (see App.spawnAdvisories.test.ts for the pattern).
//
// What they guard: the backend no longer sends cli.missing for a spawn it let
// through on a probe miss — the CLI may run under the pane's login shell, and
// cli.missing opens the install wizard unconditionally. A CLI that really is
// absent exits 127 instead. Panes are covered by the 127 check that was always
// there; an embedded CLI dock (the Pipeline Manager's) owns no pane entry, so
// without the branch below its missing CLI would get no install prompt at all.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = appSource.indexOf(startMarker, fromIndex)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('terminal.exit offers the install for a dock that has no pane', () => {
  const listener = block("backend.on('terminal.exit', (raw) => {", "backend.on('terminal.input_blocked'")
  const noPaneStart = listener.indexOf('if (!pane) {')
  const noPaneEnd = listener.indexOf('\n  }\n', noPaneStart)
  const noPane = listener.slice(noPaneStart, noPaneEnd)

  it('has a branch for an exit that matches no pane', () => {
    expect(noPaneStart).toBeGreaterThan(-1)
    expect(noPaneEnd).toBeGreaterThan(noPaneStart)
  })

  it('prompts only when the shell confirmed a probe miss (127 + not_found)', () => {
    expect(noPane).toContain("ev.exit_code === 127 && ev.startup_probe?.reason === 'not_found'")
  })

  it('takes the agent key from the probe, and never prompts for a plain terminal', () => {
    expect(noPane).toContain('const agentKey = ev.startup_probe?.agent_key')
    expect(noPane).toContain("agentKey && agentKey !== 'terminal'")
  })

  it("passes the event's pane id, so the dock's don't-ask-again opt-out still applies", () => {
    expect(noPane).toContain('promptCliInstall(agentKey, agentKey, ev.pane_id)')
  })

  it('prompts before it returns — a return first would make the branch dead', () => {
    const promptIdx = noPane.indexOf('promptCliInstall(')
    const returnIdx = noPane.lastIndexOf('return')
    expect(promptIdx).toBeGreaterThan(-1)
    expect(returnIdx).toBeGreaterThan(promptIdx)
  })

  it('reads startup_probe off the event, which the backend puts on terminal.exit', () => {
    expect(listener).toContain('startup_probe?: { agent_key?: string; reason?: string } | null')
  })

  it("leaves the pane's own 127 prompt in place, after the no-pane branch", () => {
    const paneCheckIdx = listener.indexOf("if (ev.exit_code === 127 && pane.agentKey !== 'terminal') {")
    expect(paneCheckIdx).toBeGreaterThan(noPaneEnd)
    expect(listener).toContain('promptCliInstall(pane.agentKey, pane.agentLabel, pane.id)')
  })
})

describe('cli.missing is still handled for a spawn the probe blocks', () => {
  // A spawn that execs the CLI directly (the plugin ai.cli.start path, a
  // Windows agent pane) never gets a PTY, so no 127 arrives — cli.missing is
  // its only route to the install prompt.
  it('keeps the listener that opens the install wizard', () => {
    const listener = block("backend.on('cli.missing', (raw) => {", '\n})\n')
    expect(listener).toContain('promptCliInstall(ev.agent_key, pane?.agentLabel || ev.label || ev.agent_key, paneId)')
  })

  // promptCliInstall reads a falsy pane id as "no pane at all", which is the
  // branch that skips the don't-ask-again opt-out. An empty string is falsy
  // and used to arrive here, so a spawn that named no pane opted the user's
  // choice out of the decision. The backend no longer sends one; this
  // normalizes whatever still does.
  it('normalizes an empty pane id, so it cannot bypass the opt-out', () => {
    const listener = block("backend.on('cli.missing', (raw) => {", '\n})\n')
    expect(listener).toContain('const paneId = ev.pane_id || undefined')
  })
})

// The opt-out used to be skipped whenever no pane id came along, so whether an
// automatic prompt respected "don't ask again" hung on a field that only says
// which pane to relaunch. Only the spawn dropdown — the user asking for the
// CLI — may skip it, and it says so explicitly.
describe('promptCliInstall decides the opt-out by who asked, not by the pane id', () => {
  const fn = block('async function promptCliInstall(', '\nfunction closeCliInstall(')

  it('takes an explicit requested flag', () => {
    expect(fn).toContain('async function promptCliInstall(agentKey: string, agentLabel: string, paneId?: string, requested = false)')
  })

  it('checks the opt-out for every prompt the user did not ask for', () => {
    expect(fn).toContain('if (!requested) {')
    expect(fn).not.toContain('if (paneId) {')
  })

  it('marks only the spawn dropdown as requested', () => {
    expect(appSource).toContain('@install-cli="(p) => void promptCliInstall(p.agentKey, p.label, undefined, true)"')
    expect(appSource.match(/promptCliInstall\([^)]*, true\)/g)).toHaveLength(1)
  })
})
