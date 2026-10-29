// Sub-pipeline calls reach App.vue's run machine at the hand-offs and at the
// ends of a run; the logic is in usePipelineDag / pipelineDagRun
// (lib/__tests__/pipelineSubpipelineRun.test.ts) and projects.py run_stack.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(start: string, end: string): string {
  const i = app.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  const j = app.indexOf(end, i + start.length)
  expect(j, end).toBeGreaterThan(-1)
  return app.slice(i, j)
}

describe('sub-pipeline seams in App.vue', () => {
  it('every hand-off asks for a call after the gate check', () => {
    const next = body('async function onPipelineNext(', '\n/**')
    expect(next.indexOf('pipelineDag.nextCall(nextIndex)')).toBeGreaterThan(next.indexOf('pipelineDag.holdBeforeStage(nextIndex)'))
    const start = body('async function onPipelineStart(', '\n/** ControlPane')
    expect(start.indexOf('pipelineDag.nextCall(startIndex)')).toBeGreaterThan(start.indexOf('pipelineDag.holdBeforeStage(startIndex)'))
    const resume = body('async function runPipelineResume(', '\n// Orders every project.set_ui_state')
    expect(resume.indexOf('pipelineDag.nextCall(info.nextStageIndex)')).toBeLessThan(resume.indexOf('await activateStage(info.nextStageIndex)'))
    expect(resume).toContain('pipelineDag.adoptCallOutputs(info.nodeOutputs)')
  })

  it('an unrelated start is refused while a parent waits, by name, before anything changes', () => {
    const start = body('async function onPipelineStart(', '\n/** ControlPane')
    const refuse = start.indexOf("i18n.global.t('error.pipeline-parent-suspended'")
    expect(refuse).toBeGreaterThan(-1)
    // Before the first thing a start changes: the run's pipeline id (PR-E E4).
    expect(refuse).toBeLessThan(start.indexOf('runPipelineId.value = pid'))
    expect(start).toContain('payload.childOf ? undefined')
    expect(start).toContain('...(payload.childOf ? { child_of: payload.childOf } : {})')
  })

  it('a child run hands back on completion and on failure; a top-level run never asks', () => {
    const next = body('async function onPipelineNext(', '\n/**')
    expect(next).toContain('if (pipelineDag.isChildRun()) {')
    expect(next).toContain("await returnToParent('completed', result)")
    const fail = body('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')
    expect(fail).toContain("pipelineDag.isChildRun() && await returnToParent('failed'")
    const reject = body('async function onPipelineGateReject(', '\nasync function ')
    expect(reject).toContain("pipelineDag.isChildRun() && await returnToParent('failed'")
    const back = body('async function returnToParent(', '\nasync function onPipelineReset(')
    expect(back).toContain("if (!pipelineDag.isChildRun()) return false")
    expect(back).toContain('pipelineDag.expectCallResult(')
    expect(back).toContain('await runPipelineResume()')
  })

  it('a call suspends the run first, keeps its panes, and starts the child as its own run', () => {
    const call = body('async function startChildRun(', '\n/** This run is a sub-pipeline')
    expect(call.indexOf("sendQuiet<ProjectPayload & { frame_id?: string }>('pipeline.suspend'")).toBeLessThan(call.indexOf('onPipelineStart({'))
    expect(call).toContain('tearDownPipelineOrchestration()')
    expect(call).not.toContain('onKill')
    expect(call).toContain('childOf: resp.frame_id')
  })
})
