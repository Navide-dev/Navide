// A slot with no role (every step of an imported n8n workflow) that is spawned
// at activation, behind a gate or a branch, carries its kickoff on the pane.
// scheduleInjection used to return at "no role selected", so the kickoff was
// never sent and the run stayed Running. App.vue is source-scanned (too large
// to mount, like the other App.*.test.ts files); the decision itself is in
// spawnKickoff.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function scheduleInjection(): string {
  const at = appSource.indexOf('function scheduleInjection(pane: ActivePane)')
  expect(at).toBeGreaterThan(-1)
  const end = appSource.indexOf('interface SpawnInternal', at)
  expect(end).toBeGreaterThan(at)
  return appSource.slice(at, end)
}

describe('scheduleInjection without a role', () => {
  it('stops only when no kickoff is due', () => {
    const body = scheduleInjection()
    const branch = body.slice(body.indexOf('if (!pane.roleKey) {'), body.indexOf('if (pane.skipRoleInjection)'))
    expect(branch).toContain('if (!rolelessPaneAwaitsKickoff(pane)) return')
    expect(branch).not.toMatch(/\n\s+return\n/)
  })

  it('injects a role only for a pane that has one', () => {
    const body = scheduleInjection()
    expect(body).toContain('if (pane.roleKey && !(await injectRole())) return')
    expect(body.indexOf('const role = rolesApi.find(pane.roleKey)')).toBeLessThan(body.indexOf('if (pane.roleKey && !(await injectRole())) return'))
  })

  it('still passes the injection guards before the kickoff', () => {
    const body = scheduleInjection()
    const guards = body.indexOf('MIN_INJECTION_LEAD_MS - lead')
    expect(guards).toBeGreaterThan(body.indexOf('if (!pane.roleKey) {'))
    expect(guards).toBeLessThan(body.indexOf('injecting kickoff ('))
  })

  it('does not wait for an acknowledgement of a role that was never sent', () => {
    const body = scheduleInjection()
    const step = body.slice(body.indexOf('// 4. Inject kickoff prompt'), body.indexOf('injecting kickoff ('))
    expect(step).toMatch(/if \(pane\.roleKey\) \{[\s\S]*waitForActivityThenSettle/)
  })
})

describe('activateStage without a role', () => {
  it('sends a pre-spawned slot its kickoff instead of looking up a role it does not have', () => {
    const at = appSource.indexOf('async function activateStage(')
    const body = appSource.slice(at, appSource.indexOf("pipelineLog(`${tag} ➜ injecting role '${role.label}' (${retry", at))
    expect(body).toContain("if (pane.roleKey && (pane.injectionStatus === 'skipped' || pane.injectionStatus === 'failed')) {")
  })
})

describe('scheduleInjection with a role', () => {
  it('keeps the role failure that fails the run before the kickoff (#448)', () => {
    const body = scheduleInjection()
    expect(body).toContain("await failRunOnKickoff(roleStageIndex, pane.slotLabel ?? '', 'role prompt never reached the agent')")
    expect(body.indexOf('role prompt never reached the agent')).toBeLessThan(body.indexOf('// 4. Inject kickoff prompt'))
  })
})
