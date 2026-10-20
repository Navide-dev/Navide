import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import type { EchoEvidence } from '../../lib/injectEcho'

// The shared retry contract is in tests/cli/coordination.test.ts. Execute both
// real App call sites as well: the coordinator cannot prevent a duplicate if
// App drops the injection's evidence on either side of its callback.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const kickoffSites = [...source.matchAll(/const kickoffResult = await runPipelineKickoff\(\{[\s\S]*?\n {4,6}\}\)/g)]
  .map((match) => match[0])

async function runKickoffSite(site: string, echo: EchoEvidence | null) {
  const injectPane = vi.fn(async (
    _paneId: string, _prompt: string, _tag: string, _paste: boolean,
    _options: unknown, evidence?: { echo?: EchoEvidence | null },
  ) => {
    if (evidence) evidence.echo = echo
    return false
  })
  const sleep = vi.fn(async () => {})
  const { code } = await transformWithEsbuild(
    `return async () => { ${site}; return kickoffResult }`,
    'AppKickoffCallSite.ts', { loader: 'ts' },
  )
  const run = new Function(
    'runPipelineKickoff', 'injectPane', 'sleep', 'paneAlive', 'pipelineLog',
    'pane', 'stage', 'kickoff', 'tag', 'MAX_KICKOFF_ATTEMPTS', 'heldKickoffCopy', code,
  )(
    runPipelineKickoff, injectPane, sleep, () => true, () => {},
    { id: 'pane', stageId: 'stage', kickoffPrompt: 'kickoff' }, { id: 'stage' },
    'kickoff', 'test', MAX_KICKOFF_ATTEMPTS, () => undefined,
  ) as () => ReturnType<typeof runPipelineKickoff>
  const result = await run()
  return { result, injectPane, sleep }
}

async function assertHeldKickoff(site: string) {
  const { result, injectPane, sleep } = await runKickoffSite(site, 'growth')
  expect(result).toEqual({ sent: false, cancelled: false })
  expect(injectPane).toHaveBeenCalledOnce()
  expect(sleep).not.toHaveBeenCalled()
}

describe('App uses the executable CLI coordination seams', () => {
  it('routes both pipeline kickoff sites through the retry coordinator', () => {
    expect(kickoffSites).toHaveLength(2)
  })

  it('uses the coordinator retry limit for both kickoff log messages', () => {
    expect(source).toMatch(/import \{[^}]*\bMAX_KICKOFF_ATTEMPTS\b[^}]*\} from '\.\/lib\/cliCoordination'/)
    expect(source).not.toContain('const MAX_KICKOFF_ATTEMPTS =')
  })

  describe.each([0, 1])('kickoff call site %i', (index) => {
    it('passes observed echo through the actual callback and never resends a held kickoff', async () => {
      await assertHeldKickoff(kickoffSites[index])
    })

    it('still retries an empty failed injection up to three times', async () => {
      const { result, injectPane, sleep } = await runKickoffSite(kickoffSites[index], null)
      expect(result).toEqual({ sent: false, cancelled: false })
      expect(injectPane).toHaveBeenCalledTimes(3)
      expect(sleep.mock.calls).toEqual([[3000], [3000]])
    })

    it.each([
      ['missing evidence out-parameter', ', undefined, evidence)', ', undefined)'],
      ['missing returned echo', 'echo: evidence.echo', 'echo: undefined'],
    ])('detects a %s regression', async (_name, before, after) => {
      const mutant = kickoffSites[index].replace(before, after)
      expect(mutant).not.toBe(kickoffSites[index])
      await expect(assertHeldKickoff(mutant)).rejects.toThrow()
    })
  })

  it('accepts turn text before dispatch and releases deduplication state on teardown', () => {
    const start = source.indexOf('function onTurnCompleteForMessaging(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body.indexOf('turnTextGate.accept(paneId, text, timestamp)')).toBeGreaterThan(-1)
    expect(body.indexOf('turnTextGate.accept(')).toBeLessThan(body.indexOf('const parsed = parseMessages(text)'))
    expect(source).toContain('turnTextGate.delete(paneId)')
  })

  it('routes normalized pane sessions through the bounded persistence coordinator', () => {
    const start = source.indexOf('async function persistPaneSession(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('normalizeResumeSessionId(pane.agentKey, sessionId)')
    expect(body).toContain('await persistSessionOnce(`${pane.id}:${id}`')
  })
})
