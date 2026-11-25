// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Pins how an SSH Remote pane's target travels through App.vue (0.2.48): the
// dialog's folder and CLI → spawnPane → terminal.create, recorded on the
// backend's pane record so a restart restores it, its remote session id kept
// so a reconnect, rebuild or restore resumes that conversation, and kept out
// of account switching. Source-read like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('App – SSH Remote panes', () => {
  it('opens a terminal or a CLI pane and records it', () => {
    const body = functionBody('onSshRemoteConnected')
    expect(body).toContain("const agentKey = cli === SSH_TERMINAL ? 'terminal' : REMOTE_AGENT_KEY")
    // Claude gets its remote session id now; Codex reports the one it picks.
    expect(body).toContain("sessionId: cli === 'claude' ? crypto.randomUUID() : ''")
    expect(body).toContain('if (paneId) await recordSshPane(workspacePath, paneId, agentKey, spawnGroupId, sshRemote)')
    expect(body).not.toContain('sshResume')
    const record = functionBody('recordSshPane')
    expect(record).toContain("'manual_pane.spawn'")
    expect(record).toContain("remote: { kind: 'ssh', ...target },")
    // The id lives in the spec, never in the local-session field.
    expect(record).toContain("session_id: '',")
  })

  it('a rebuild or reconnect resumes the same host and session and keeps the record', () => {
    const clean = functionBody('rebuildPaneClean')
    expect(clean).toContain('sshRemote: pane.sshRemote ? { ...pane.sshRemote } : undefined,')
    expect(clean).toContain('sshResume: !!snap.sshRemote,')
    expect(clean).toContain("await recordSshPane(snap.workspacePath, newId, snap.agentKey, snap.runGroupId || '', snap.sshRemote, paneId)")
    expect(functionBody('rebuildPaneViaResume')).toMatch(/if \(pane\.remote \|\| pane\.sshRemote\) \{\s*await rebuildPaneClean\(paneId\)/)
    expect(functionBody('spawnPane')).toContain("remote: { kind: 'ssh' as const, ...opts.sshRemote, resume: !!opts.sshResume }")
  })

  it('a restore reconnects to the saved target and resumes', () => {
    const restore = functionBody('spawnRestoredPane')
    expect(restore).toContain('sshRemote: savedSshTarget(saved),')
    expect(restore).toContain('sshResume: !!savedSshTarget(saved),')
    const saved = functionBody('savedSshTarget')
    expect(saved).toContain("if (!r || r.kind !== 'ssh') return undefined")
    expect(saved).toContain('sshTargetFields(r)')
  })

  it('keeps the session id a Codex pane reports, and says when a resume missed', () => {
    expect(appSource).toMatch(/backend\.on\('remote_ssh\.session'[\s\S]*?pane\.sshRemote = \{ \.\.\.pane\.sshRemote, sessionId: ev\.session_id \}[\s\S]*?'remote_ssh\.set_session'/)
    expect(appSource).toMatch(/backend\.on\('remote_ssh\.resume_missed'[\s\S]*?pane\.sshResumeMissed = true/)
    expect(appSource).toContain(':ssh-resume-missed="!!p.sshResumeMissed"')
  })

  it('account switching leaves SSH panes alone', () => {
    expect(functionBody('onQuotaSwitchAccount')).toContain('if (quotaPane?.remote || quotaPane?.sshRemote) return')
    expect(functionBody('moveFixedAccountPane')).toContain('if (pane?.remote || pane?.sshRemote) return')
    expect(functionBody('agentPaneAccountSwitch')).toContain("if (switchPane?.remote || switchPane?.sshRemote) return { status: 'refused', code: 'REMOTE_PANE' }")
  })

  it('records the name the pane opened under, so a restart shows it again', () => {
    // manual_pane.spawn carries no name: without this the placeholder fell
    // back to the agent label ("Terminal", "remote") after a restart.
    const record = functionBody('recordSshPane')
    expect(record).toContain("'project.set_pane_auto_name'")
    expect(record).toContain('auto_name: pane.autoName,')
  })

  it('runs each pane in its own tmux session, kept across reconnects and ended on close', () => {
    // Chosen once when the pane opens; the rebuild and restore paths copy the
    // whole spec, so they attach to the same session.
    expect(functionBody('onSshRemoteConnected')).toContain('tmuxSession: newSshTmuxSession(),')
    expect(functionBody('savedSshTarget')).toContain('tmuxSession: sshTmuxSessionField(r.tmuxSession),')
    // Only a real close ends it; a rebuild (markRemoved: false, keepInList)
    // or a workspace close keeps it for the reconnect.
    const kill = functionBody('onKill')
    expect(kill).toMatch(/if \(markRemoved && !keepInList && pane\?\.sshRemote\?\.tmuxSession\) \{\s*void sendQuiet\('remote_ssh\.end_session', \{ remote: \{ kind: 'ssh', \.\.\.pane\.sshRemote \} \}\)/)
  })

  it('a restore never opens an SSH pane by itself', () => {
    // Scope, interrupted-at-launch and fresh batches all skip it; the user
    // opens it, as with a local terminal pane.
    const advance = appSource.slice(appSource.indexOf('async function advanceRestoreSession('))
    expect(advance.slice(0, advance.indexOf('\n}'))).toContain('.filter((id) => !restoreOpensOnlyOnRequest(id))')
    expect(functionBody('restoreOpensOnlyOnRequest')).toContain('opensOnlyOnRequest(pane.deferredRestore.saved)')
  })
})
