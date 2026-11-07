// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of "cli_open_agent(session_id=…) opens a pane that RESUMES".
//
// The backend verifies the id against the vendor's session store and then
// broadcasts it; from there it crosses four re-shapings before it becomes a
// launch command, and a field left out of any one of them is dropped for good.
// That failure is silent in the worst possible way: the pane opens, the tool
// has already answered `resumed_session_id`, and the CLI starts an EMPTY
// conversation — indistinguishable from a successful resume until somebody
// reads the transcript. So each station is pinned here.
//
// App.vue cannot be mounted by this suite (see App.spawnAdvisories.test.ts),
// so these assert the WIRING against the source text. The executable proof of
// the resulting command string lives in lib/resume-command.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('cli_open_agent(session_id) — the MCP resume path, station by station', () => {
  it('the agent_spawn.request handler reads session_id off the event', () => {
    const start = appSource.indexOf("backend.on('agent_spawn.request'")
    expect(start).toBeGreaterThan(-1)
    const handler = appSource.slice(start, appSource.indexOf('\n})\n', start))
    // Declared on the event shape...
    expect(handler).toContain('session_id?: string')
    // ...and actually forwarded. The backend omits the key entirely for an
    // ordinary spawn, so the default has to be '' not undefined.
    expect(handler).toContain("session_id: ev.session_id ?? ''")
  })

  it('handleMcpSpawnRequest carries it alongside the gate, not through it', () => {
    const body = fn('handleMcpSpawnRequest')
    expect(body).toContain('session_id?: string')
    // The gate decides identity (name collisions, model/effort capability);
    // which conversation to resume is not its business, so it rides next to
    // the gate result rather than being threaded through it.
    expect(body).toContain("const spawnReq = { ...gate, sessionId: (ev.session_id ?? '').trim(),")
    expect(body).toContain('createRequestedPane(parent, spawnReq)')
    expect(body).toContain('createStandaloneRequestedPane(ev.target_workspace as string, spawnReq)')
  })

  it('both spawn paths turn it into a commandOverride instead of launching fresh', () => {
    // commandOverride: '' is what a fresh pane gets. If either path still
    // hardcoded that, the session id would arrive and do nothing at all.
    for (const name of ['createRequestedPane', 'createStandaloneRequestedPane']) {
      expect(fn(name), name).toContain('const mcpCommand = mcpSpawnCommandOverride(req)')
      expect(fn(name), name).toContain('commandOverride: mcpCommand')
      expect(fn(name), name).toContain('sessionId?: string')
      // A resumed pane must SAY it is a resume, or spawnPane pins a fresh
      // Claude --session-id on top of the --resume the override already
      // carries and the CLI refuses both, exiting ~2s after spawn.
      expect(fn(name), name).toContain('isResume: !!mcpResumeId')
    }
  })

  it('the override is built by the shared resume builder, not an inlined flag', () => {
    const body = fn('mcpSpawnCommandOverride')
    // One builder owns every vendor's resume syntax — `claude --resume <id>`,
    // `codex resume <id>`, `opencode --session <id>`. Inlining one here would
    // be correct for exactly one CLI.
    expect(body).toContain('buildResumeCommand(')
    expect(body).toContain('skipFlagFor(req.agentKey, spec)')
    // A custom binary override still survives a resume: terminal.create swaps
    // it in on the backend for every spawn, so the command goes out as built.
    expect(body).toMatch(/\n  return resume$/)
    // No session asked for = an ordinary fresh spawn, byte for byte.
    expect(body).toContain("if (!sessionId) return ''")
  })

  it('refuses a session id that is not shell-safe before building any command', () => {
    // Second layer of the backend's _SAFE_SESSION_ID check: the id goes into a
    // shell command string. A caller supplying `abc; rm -rf ~` must get a
    // fresh pane and a diagnostic, never that string on a command line.
    const body = fn('mcpSpawnCommandOverride')
    const guardAt = body.indexOf('if (!isShellSafeSessionId(sessionId))')
    const buildAt = body.indexOf('buildResumeCommand(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(guardAt)
    expect(body).toContain("code: 'spawn.resume-unsafe-id'")
    // The refusal returns '' — an ordinary fresh spawn, byte for byte.
    const refusal = body.slice(guardAt, buildAt)
    expect(refusal).toContain("return ''")
  })

  it('a vendor that cannot resume by id is recorded, never silently opened fresh', () => {
    const body = fn('mcpSpawnCommandOverride')
    // The tool refuses aider upstream, so this is a spec that changed under
    // us. Fresh is the only thing left to open, but the caller has to be able
    // to find out — ui_diagnostics is the one channel that still reaches them.
    expect(body).toContain("code: 'spawn.resume-unavailable'")
    expect(body).toContain('recordDiagnostic(')
  })

  it('puts the conversation back where it was, not under whoever asked', () => {
    // A resume is not a new child pane. The pane record outlives its pane, so
    // the backend reads the parent and tab group the conversation last sat in
    // and sends them along; the window applies them instead of parenting the
    // pane onto the caller.
    const body = fn('createRequestedPane')
    expect(body).toContain("const resumeSpawnedBy = mcpResumeId ? (req.resumeSpawnedBy ?? '') : parent.id")
    expect(body).toContain('spawnedBy: resumeSpawnedBy')
    expect(body).toContain('runGroupId: resumeRunGroupId')
    // An EMPTY parent is a real answer — that pane was a root — so it must not
    // fall through to parent.id. `?? ''` keeps it; `||` would not.
    expect(body).not.toMatch(/resumeSpawnedBy \|\| parent\.id/)
    // Keyed off the resolved command, not the raw argument: a vendor that fell
    // back to a fresh spawn is an ordinary child of the caller again.
    expect(body).toContain('mcpResumeId ?')
  })

  it('the standalone path (host / external caller) restores lineage too', () => {
    // No requesting pane here, so a fresh spawn is a root in the active tab —
    // but a resumed one must go back where it was, or every resume from an
    // external client strands the conversation as an orphan at the root.
    const body = fn('createStandaloneRequestedPane')
    expect(body).toContain("const resumeSpawnedBy = mcpResumeId ? (req.resumeSpawnedBy ?? '') : ''")
    expect(body).toContain('spawnedBy: resumeSpawnedBy || undefined')
    expect(body).toContain('spawned_by: resumeSpawnedBy')
    expect(body).toContain('resumableGroupId(req.resumeRunGroupId, workspacePath)')
    // And its caller tells the injector this is a resume, so it waits for the
    // reload. The task is typed after the pane is reported (Windows VM 0.2.38).
    expect(body).not.toContain('injectStandaloneTask(')
    expect(fn('handleMcpSpawnRequest')).toContain("resume: !!(ev.session_id ?? '').trim(),\n        evidence: standaloneEvidence,")
  })

  it('records the restored lineage, so the next restore keeps the position', () => {
    // The pane record has to agree with where the pane was actually placed. If
    // it kept the caller as parent, a restart would quietly pull the resumed
    // conversation back under them.
    const body = fn('createRequestedPane')
    expect(body).toContain('spawned_by: resumeSpawnedBy')
    expect(body).toContain("run_group_id: resumeRunGroupId ?? ''")
  })

  it('carries the lineage across every station of the event', () => {
    const start = appSource.indexOf("backend.on('agent_spawn.request'")
    const handler = appSource.slice(start, appSource.indexOf('\n})\n', start))
    expect(handler).toContain('resume_spawned_by?: string')
    expect(handler).toContain("resume_spawned_by: ev.resume_spawned_by ?? ''")
    expect(handler).toContain("resume_run_group_id: ev.resume_run_group_id ?? ''")
    const body = fn('handleMcpSpawnRequest')
    expect(body).toContain('resume_spawned_by?: string')
    expect(body).toContain("resumeSpawnedBy: ev.resume_spawned_by ?? ''")
  })

  it('does not put a resumed pane into a tab that no longer exists', () => {
    // closeRunGroup drops the group but leaves run_group_id on every pane
    // record, so the recorded position can name a tab nobody has. A pane
    // placed there is shown on neither 手動 nor any tab until the next
    // restart. Both paths check the id against the workspace's live tabs and
    // fall back when it is gone.
    for (const name of ['createRequestedPane', 'createStandaloneRequestedPane']) {
      expect(fn(name), name).toContain('resumableGroupId(req.resumeRunGroupId')
    }
    const helper = fn('resumableGroupId')
    expect(helper).toContain("runGroupsOf(workspacePath).some((g) => g.id === id) ? id : ''")
  })

  it('a resume with no task sends no kickoff into the conversation', () => {
    // renderSpawnKickoff('') is a bare report-back instruction; typing it
    // into a conversation that was asked nothing is wrong, and the tool would
    // then block on a verdict for a task that does not exist. The verdict is
    // answered at once instead.
    const body = fn('kickoffRequestedPane')
    expect(body).toContain('if (!task) {')
    expect(body).toContain("emitKickoffVerdict('sent', 'no task — the pane was left as it was')")
    expect(body).toContain("pane.kickoffStatus = 'none'")
  })

  it('the parent path waits longer for a resumed CLI, like the standalone one', () => {
    const body = fn('kickoffRequestedPane')
    expect(body).toContain('opts.resume')
    expect(body).toContain('KICKOFF_PROMPT_READY_TIMEOUT_RESUME_MS')
    expect(appSource).toContain('const KICKOFF_PROMPT_READY_TIMEOUT_RESUME_MS = 90_000')
    // And the call site passes the flag.
    const h = fn('handleMcpSpawnRequest')
    expect(h).toContain("resume: !!(ev.session_id ?? '').trim()")
  })

  it('the launched id is persisted so a restart does not lose the conversation', () => {
    // pinnedSessionId is only set once the CLI announces itself, which is
    // AFTER the pane record is written on this path. Without the fallback the
    // record keeps '' and the next restore reopens the pane empty — losing the
    // very conversation it was opened to continue.
    for (const name of ['createRequestedPane', 'createStandaloneRequestedPane']) {
      expect(fn(name), name).toContain(
        "panes.value.find((p) => p.id === paneId)?.pinnedSessionId || (req.sessionId ?? '')",
      )
    }
  })
})
