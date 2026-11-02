// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runPipelineKickoff } from '../../lib/cliCoordination'
import { matchAwaitingInput } from '../../lib/cliAwaitingInput'

// 0.2.37 VM round: a duplicate window reloaded while a webhook run's L1 pane
// sat on Claude's permission box for `touch RAN.txt`. pipeline_resume then
// pasted the 3092-char kickoff into that pane; the paste's Enter landed on
// "❯ 1. Yes", the command ran without anyone approving it, and the old turn's
// turn_complete closed the stage as if the kickoff had been done.

// The box as Claude Code draws it for a shell command, read off the screen tail.
const PERMISSION_BOX = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   touch RAN.txt                                              │',
  '│   Create the file the webhook asked for                      │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  "│   2. Yes, and don't ask again for touch commands in /ws      │",
  '│   3. No, and tell Claude what to do differently (esc)        │',
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n')

describe('a kickoff never types into a pane parked on a CLI prompt', () => {
  const base = { sleep: async () => {}, paneAlive: () => true }

  it('the screen read used for the guard sees Claude\'s permission box', () => {
    expect(matchAwaitingInput('claude', PERMISSION_BOX)).toBe(true)
  })

  it('types nothing and says the pane is parked', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const r = await runPipelineKickoff({
      ...base,
      inject,
      parkedOnPrompt: () => matchAwaitingInput('claude', PERMISSION_BOX),
    })
    expect(inject).not.toHaveBeenCalled()
    expect(r).toEqual({ sent: false, cancelled: false, parked: true })
  })

  it('does not press Enter on a held copy either', async () => {
    const submit = vi.fn(async () => true)
    const inject = vi.fn(async () => ({ injected: true }))
    const r = await runPipelineKickoff({
      ...base,
      inject,
      heldCopy: { holds: () => true, submit },
      parkedOnPrompt: () => true,
    })
    expect(submit).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    expect(r.parked).toBe(true)
  })

  it('stops retrying once a prompt comes up between attempts', async () => {
    let parked = false
    const inject = vi.fn(async () => {
      parked = true
      return { injected: false, echo: null }
    })
    const r = await runPipelineKickoff({ ...base, inject, parkedOnPrompt: () => parked })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ sent: false, cancelled: false, parked: true })
  })

  it('an idle pane still gets its kickoff', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const r = await runPipelineKickoff({ ...base, inject, parkedOnPrompt: () => false })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(r.sent).toBe(true)
  })
})

// App.vue mounts backend/terminal lifecycles, so its wiring is read from source
// (same pattern as App.pipelineResumeWorkspace.test.ts).
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('every pipeline kickoff path asks whether the pane is parked', () => {
  it('reads the awaiting badge, the startup dialog and the vendor box', () => {
    const guard = block('function paneParkedOnPrompt(', '\n}\n')
    expect(guard).toContain("=== 'awaiting'")
    expect(guard).toContain('paneScreenBlocked(paneId)')
    expect(guard).toContain('matchAwaitingInput(agentKey')
  })

  it('activateStage (the resume path) checks before the role and the kickoff', () => {
    const activate = block('async function activateStage(', '\nasync function ')
    const check = activate.indexOf("if (turnWait === 'parked' || paneParkedOnPrompt(pane.id))")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(activate.indexOf('`role:${role.label}`'))
    expect(check).toBeLessThan(activate.indexOf('runPipelineKickoff({'))
    expect(activate).toContain('parkedOnPrompt: () => paneParkedOnPrompt(pane.id)')
    expect(activate).toContain('failRunOnKickoff(index, slot.label, PARKED_ON_PROMPT_REASON, false, false, true)')
  })

  it('scheduleInjection (a spawned or reattached pane) checks before the role and the kickoff', () => {
    const schedule = block('function scheduleInjection(', '\ninterface SpawnInternal')
    const check = schedule.indexOf('if (paneParkedOnPrompt(pane.id))')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(schedule.indexOf('if (pane.roleKey && !(await injectRole())) return'))
    expect(schedule).toContain('parkedOnPrompt: () => paneParkedOnPrompt(pane.id)')
  })

  it('a parked slot neither retries nor takes an error edge: the run stops for a resume', () => {
    const fail = block('async function failRunOnKickoff(', '\nasync function ')
    expect(fail).toContain('needsUser = false')
    expect(fail).toContain("pipeline.state === 'running' && !needsUser) {")
    expect(fail).toContain('!needsUser && pipelineDag.routeFailure(')
  })
})
