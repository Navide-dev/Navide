// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Pins how a remote container pane's `remote` object travels through App.vue:
// the dialog's choice → spawnPane → the pane → terminal.create, kept across a
// rebuild / reconnect and a restore, and kept out of every account switch and
// quota failover path. Source-read like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('App – remote container panes', () => {
  it('the ＋ menu entry opens the dialog, whose choice spawns a remote pane', () => {
    expect(appSource).toContain('@spawn-remote="openRemoteDialog"')
    expect(appSource).toMatch(/<RemoteDevcontainerDialog[\s\S]*?@open="onRemoteDialogOpen"/)
    const body = functionBody('onRemoteDialogOpen')
    expect(body).toContain('remote: req.remote')
    expect(body).toContain("'manual_pane.spawn'")
    // The backend's pane record keeps the target; nothing goes to localStorage.
    expect(body.split('remote: req.remote').length - 1).toBe(3) // trust, spawnPane, manual_pane.spawn
    expect(appSource).not.toContain('agentTeam.remotePanes')
    // Trusted app-wide before anything spawns; a refusal opens nothing.
    expect(body).toContain("if (!await sendQuiet('remote_devcontainer.trust', { remote: req.remote })) return")
    expect(body.indexOf('remote_devcontainer.trust')).toBeLessThan(body.indexOf('spawnPane('))
    // Its own agent key, never the CLI's: the CLI travels in remote.cli.
    expect(body.match(/agentKey: REMOTE_AGENT_KEY,/g)).toHaveLength(1)
    expect(body.match(/agent: REMOTE_AGENT_KEY,/g)).toHaveLength(1)
    expect(body).not.toContain('req.agentKey')
  })

  it('resolves the remote stub spec for the spawn and the delivery gate only', () => {
    const lookup = functionBody('paneAgentSpec')
    expect(lookup).toContain('agentSpecs.find((s) => s.agentKey === agentKey)')
    expect(lookup).toContain('agentKey === REMOTE_AGENT_KEY ? REMOTE_AGENT_SPEC : undefined')
    expect(functionBody('spawnPane')).toContain('const spec = paneAgentSpec(opts.agentKey)')
    expect(functionBody('deliveryHoldKey')).toContain('const spec = paneAgentSpec(agentKey)')
    // The menus and the MCP spawn gate keep reading the vendor list alone.
    expect(appSource).not.toMatch(/validAgentKeys: .*REMOTE/)
  })

  it('reads the screen guards of the CLI the container runs', () => {
    // A container pane's CLI first, then an SSH pane's (not its terminal), then the key.
    expect(functionBody('paneScreenAgentKey')).toContain("return pane?.remote?.cli ?? (sshCli && sshCli !== SSH_TERMINAL ? sshCli : undefined) ?? pane?.agentKey")
    const poll = functionBody('pollAwaitingPanes')
    expect(poll).toContain('hasAwaitingPattern(screenKey)')
    expect(poll).toContain('matchAwaitingInput(screenKey, screen)')
    expect(poll).toContain('updatePromptHolds(pane.id, screenKey)')
    expect(poll).toContain('applyScreenWatch(ref, screenKey, boxOnScreen)')
    for (const name of ['updatePromptOnScreen', 'paneClearUpdatePrompt', 'paneParkedOnPrompt']) {
      expect(functionBody(name), name).toContain('paneScreenAgentKey(panes.value.find((p) => p.id === paneId))')
    }
  })

  it('spawnPane records the target on the pane and hands it to the terminal', () => {
    const body = functionBody('spawnPane')
    expect(body).toContain('remote: opts.remote,')
    // A local spawn adds nothing: the field is only set when there is a target.
    expect(body).toContain('...(opts.remote ? { remote: opts.remote } : {}),')
    // No session marker and no account following for a remote pane.
    expect(body).toMatch(/!opts\.isLogin && !opts\.remote && SESSION_MARKER_AGENTS/)
    expect(body).toMatch(/!opts\.isLogin &&\s*!opts\.remote &&/)
  })

  it('a restore reads the target back from the backend pane record', () => {
    expect(functionBody('spawnRestoredPane')).toContain('remote: savedRemoteTarget(saved),')
    const read = functionBody('savedRemoteTarget')
    // A local record ({} or absent) restores as a local pane.
    expect(read).toContain('r.host && typeof r.container')
    // The CLI comes back with it; a record without one is not a remote target.
    expect(read).toContain("(r.cli === 'claude' || r.cli === 'codex')")
    expect(read).toContain('cli: r.cli')
  })

  it('rebuild and reconnect respawn against the same container', () => {
    expect(functionBody('rebuildPaneViaResume')).toMatch(/if \(pane\.remote \|\| pane\.sshRemote\) \{\s*await rebuildPaneClean\(paneId\)/)
    const clean = functionBody('rebuildPaneClean')
    expect(clean).toContain('remote: pane.remote,')
    expect(clean).toContain('remote: snap.remote,')
    expect(appSource).toContain(':remote="p.remote"')
    expect(appSource).toContain(':remote-reconnect="() => rebuildPaneClean(p.id)"')
    expect(appSource).toContain(':remote-close-pane="() => onKill(p.id)"')
  })

  it('account switching and quota failover leave remote panes alone', () => {
    expect(functionBody('onQuotaSwitchAccount')).toContain('if (quotaPane?.remote || quotaPane?.sshRemote) return')
    expect(functionBody('toggleAccountPin')).toContain('if (!pane || pane.agentKey !== FOLLOW_SWITCH_AGENT || pane.remote) return')
    expect(functionBody('moveFixedAccountPane')).toContain('if (pane?.remote || pane?.sshRemote) return')
    expect(functionBody('agentPaneAccountSwitch')).toContain("return { status: 'refused', code: 'REMOTE_PANE' }")
    const reports = appSource.split('void quotaFailover.report({').length - 1
    expect(reports).toBe(3)
    expect(appSource.match(/if \(!pane\.remote\) void quotaFailover\.report\(\{/g)).toHaveLength(2)
    expect(appSource).toContain('if (turnPane && turnDetail && ev.detail === turnDetail && !turnPane.remote) {')
  })
})
