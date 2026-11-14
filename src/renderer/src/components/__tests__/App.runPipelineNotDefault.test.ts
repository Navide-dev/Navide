// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// PR-E E4 and the E1 window side. App.vue cannot be mounted by this suite, so
// the wiring is asserted against the source:
// - running a pipeline (from the editor, the scheduler or MCP) never calls
//   setActivePipeline — the run carries its own id (runPipelineId) into the
//   graph, the backend record, Start Over, resume and a sub-pipeline's parent;
// - a pipeline.start the backend refuses rolls the window back instead of
//   spawning panes for a run that was not recorded, and names
//   PIPELINE_ALREADY_RUNNING as its own refusal.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`async function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('E4 – running a pipeline does not change the default', () => {
  it('onPipelineStart runs the requested pipeline under its own id', () => {
    const body = fn('onPipelineStart')
    expect(body).not.toContain('setActivePipeline')
    expect(body).toContain('runPipelineId.value = pid')
    expect(body).toContain('pipelineDag.begin(pid,')
    expect(body).toContain('pipeline_id: pid,')
    expect(body).not.toContain('pipelinesApi.activePipelineId.value,')
  })

  it('resume, Start Over and a sub-pipeline parent use the run’s pipeline', () => {
    expect(fn('runPipelineResume')).not.toContain('setActivePipeline')
    expect(fn('runPipelineResume')).toContain('runPipelineId.value = resumePipelineId')
    expect(fn('onPipelineRestart')).toContain('onPipelineStart({ ...payload, pipelineId })')
    expect(fn('startChildRun')).toContain('const parentId = runPipelineId.value ||')
  })

  it('the stage cache, the canvas lock and the sidebar follow the run', () => {
    expect(appSource).toContain('useStages(backend, () => runPipelineId.value || pipelinesApi.activePipelineId.value)')
    expect(appSource).toContain("pipelineId: pipeline.state === 'running' ? runPipelineId.value : ''")
    expect(appSource).toContain(':run-pipeline-id="runPipelineId"')
  })
})

describe('E1 – a start the backend refuses is rolled back', () => {
  it('stops before spawning and names PIPELINE_ALREADY_RUNNING', () => {
    const body = fn('onPipelineStart')
    const sent = body.indexOf("sendQuiet<ProjectPayload>('pipeline.start'")
    const check = body.indexOf('if (refused.code !== undefined) {')
    const group = body.indexOf('createRunGroup(')
    const spawn = body.indexOf('preSpawnStage(')
    expect(sent).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(sent)
    expect(group).toBeGreaterThan(check)
    expect(spawn).toBeGreaterThan(check)
    const rollback = body.slice(check, group)
    for (const line of ['pipeline.state = stateBefore', 'runPipelineId.value = runBefore', 'pipelineRunWorkspace = before.runWorkspace']) {
      expect(rollback).toContain(line)
    }
    expect(rollback).toContain("refused.code === 'PIPELINE_ALREADY_RUNNING'")
    expect(rollback).toContain("'already-running'")
  })
})
