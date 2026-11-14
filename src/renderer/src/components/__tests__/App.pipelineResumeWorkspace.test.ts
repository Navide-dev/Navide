// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so these tests parse
// the source text instead (see App.spawnAdvisories.test.ts for the pattern).
//
// The bug they guard: resuming a pipeline run derived the workspace by
// stripping `/.agent-team/project.json` off `projectFile`. Since the SQLite
// migration that file is `.agent-team/navide.db`, the strip matched nothing and
// the database FILE became the workspace — every pane the resumed stage spawned
// failed with "cwd does not exist: …/.agent-team/navide.db". The backend's half
// of the contract is pinned in backend/tests/test_project_payload_workspace_path.py.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('resuming a pipeline run spawns into the workspace directory', () => {
  const resume = block('async function runPipelineResume(', '\nasync function ')

  it('takes the workspace from the backend record', () => {
    expect(resume).toContain('const resumeWorkspacePath = info.workspacePath')
  })

  it('never derives the workspace from projectFile, a file inside it', () => {
    // Code, not prose: the comment above the assignment names projectFile to
    // explain the bug, and that must stay allowed.
    expect(resume).not.toContain('info.projectFile')
    expect(resume).not.toMatch(/\.replace\([^)]*agent-team/)
  })

  it('feeds that workspace to every place the resumed run reads it from', () => {
    // Resuming loads the run's own pipeline without making it the default
    // (PR-E E4), so the workspace no longer goes to setActivePipeline.
    expect(resume).not.toContain('setActivePipeline')
    expect(resume).toContain('pipeline.workspacePath = resumeWorkspacePath')
    expect(resume).toContain('pipelineRunWorkspace = resumeWorkspacePath')
  })
})

describe('a resume the backend refuses stops before spawning anything', () => {
  // sendQuiet returns null when the backend errors or never answers. The
  // function used to carry on regardless: activateStage spawned the next
  // stage into a run the backend never resumed.
  const resume = block('async function runPipelineResume(', '\nasync function ')
  const at = (needle: string): number => {
    const i = resume.indexOf(needle)
    expect(i, `${needle} should be in onPipelineResume`).toBeGreaterThan(-1)
    return i
  }

  it('snapshots the pipeline before flipping it to running', () => {
    expect(at('const before = {')).toBeLessThan(at("pipeline.state = 'running'"))
  })

  it('checks the backend answer right after the call, before any use of it', () => {
    const call = at("sendQuiet<ProjectPayload>('pipeline.resume'")
    const guard = at('if (!resp) {')
    expect(guard).toBeGreaterThan(call)
    expect(guard).toBeLessThan(at('applyProjectPaths(resp)'))
  })

  it('returns before the banner is cleared, panes are realized or a stage is activated', () => {
    const guard = at('if (!resp) {')
    const bail = resume.indexOf('return', guard)
    expect(bail).toBeGreaterThan(guard)
    expect(bail).toBeLessThan(at('existingProject.value = null'))
    expect(bail).toBeLessThan(at('realizeRestoredPane'))
    expect(bail).toBeLessThan(at('await activateStage(info.nextStageIndex)'))
  })

  it('puts back exactly what it overwrote — no field may be added without one', () => {
    // Set equality, not a fixed list: an overwrite added later with no matching
    // restore is precisely how a resumed run kept a value it should not have.
    const attempt = resume.slice(at('const before = {'), at("sendQuiet<ProjectPayload>('pipeline.resume'"))
    const branch = resume.slice(at('if (!resp) {'), resume.indexOf('return', at('if (!resp) {')))
    const names = (text: string, rhs: RegExp): string[] =>
      [...text.matchAll(new RegExp(String.raw`(?:^|\n)\s*(pipeline\.\w+|pipelineRunWorkspace) = ${rhs.source}`, 'g'))]
        .map((m) => m[1]).sort()
    const overwritten = [...new Set(names(attempt, /(?!before\.)/))]
    const restored = [...new Set(names(branch, /before\./))]
    expect(overwritten.length).toBeGreaterThan(0)
    // pipeline.log is overwritten on purpose and deliberately NOT restored: it
    // carries the reason the resume failed (see the comment on `before`).
    expect(restored).toEqual(overwritten.filter((n) => n !== 'pipeline.log'))
  })

  it('serializes resumes, since the button is still clickable during the switch', () => {
    const wrapper = block('async function onPipelineResume(', 'async function runPipelineResume(')
    expect(wrapper).toContain('if (pipelineResumeInFlight) return')
    expect(wrapper).toContain('pipelineResumeInFlight = true')
    expect(wrapper).toContain('} finally {')
    expect(wrapper).toContain('pipelineResumeInFlight = false')
  })

  it('logs why it aborted while the workspace still routes the log to disk', () => {
    const branch = resume.slice(at('if (!resp) {'), resume.indexOf('return', at('if (!resp) {')))
    expect(branch.indexOf('pipelineLog(')).toBeLessThan(branch.indexOf('pipeline.workspacePath = before.workspacePath'))
    expect(branch).not.toContain('backend.log')
  })
})

describe('the resume banner carries the workspace the backend resolved', () => {
  it("maps the payload's project.workspace_path, not a path cut out of project_file", () => {
    const build = block('function buildExistingProjectInfo(', '\n}\n')
    expect(build).toContain('workspacePath: proj.workspace_path,')
  })
})
