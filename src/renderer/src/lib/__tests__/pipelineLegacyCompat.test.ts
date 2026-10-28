// R8: a pipeline without branch or error edges must run exactly as it did
// before those edges existed. The expected trace was recorded by running
// pipelineLegacyTrace.ts against the engine of origin/main ce05b98c8 (before
// the change) and is compared here with the current engine: kickoff texts,
// gate holds, reject loops, pins, restart-from, resume, node states, outputs
// and every report the backend receives.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as graphs from '../pipelineGraph'
import { usePipelineDag } from '../../composables/usePipelineDag'
import { legacyTrace } from './pipelineLegacyTrace'

const expected = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/renderer/src/lib/__tests__/pipelineLegacyCompat.expected.json'), 'utf8'),
)

describe('legacy pipelines run unchanged (R8)', async () => {
  const actual = await legacyTrace(graphs as never, usePipelineDag)

  it('covers every recorded scenario', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  })

  for (const key of Object.keys(expected)) {
    it(key, () => {
      expect(actual[key]).toEqual(expected[key])
    })
  }
})
