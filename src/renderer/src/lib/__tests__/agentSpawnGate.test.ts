import { describe, it, expect } from 'vitest'
import {
  SPAWN_ADVISORY_CHILDREN_PER_PARENT,
  SPAWN_ADVISORY_CLI_PANES,
  SPAWN_ADVISORY_DEPTH,
  assertAgentKeyAllowed,
  evaluateSpawnRequest,
  evaluateTurnSpawns,
  computeSpawnDepth,
  spawnAdvisoriesFor,
  type SpawnGateContext,
} from '../agentSpawnGate'
import type { CliModelCapability } from '@navide/plugin-shell'

/** Synthetic capabilities covering the three shapes AgentSpec can take: both
 *  flags, model only (the vendor encodes effort in the model id), and neither.
 *
 *  The keys are real agent names so the gate's own key whitelist accepts them,
 *  but the SHAPES are not those vendors' — the real codex declares no
 *  effortArgs at all, because it takes effort as a config override rather than
 *  a flag. Read these as fixtures, not as a mirror of the registry; the
 *  frontend/backend registry pair is what test_cli_vendors_registry.py
 *  compares. */
const CAPABILITIES: Record<string, CliModelCapability> = {
  claude: { modelArgs: (m) => `--model ${m}` },
  codex: {
    modelArgs: (m) => `--model ${m}`,
    effortArgs: (e) => `-c model_reasoning_effort="${e}"`,
    knownEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  cursor: { modelArgs: (m) => `--model ${m}` },
  droid: {},
}

function ctx(overrides: Partial<SpawnGateContext> = {}): SpawnGateContext {
  return {
    validAgentKeys: ['claude', 'codex', 'cursor', 'droid'],
    isNameTaken: () => false,
    parentDepth: 0,
    parentChildCount: 0,
    cliPaneCount: 1,
    modelCapabilityFor: (key) => CAPABILITIES[key],
    launchCommandOverridden: () => false,
    ...overrides,
  }
}

const goodReq = { agent: 'claude', name: 'worker-2', task: 'do the thing' }

describe('evaluateSpawnRequest', () => {
  it('passes a valid request and returns normalized fields', () => {
    const res = evaluateSpawnRequest({ ...goodReq, name: '  worker-2  ' }, ctx())
    expect(res).toEqual({ ok: true, agentKey: 'claude', name: 'worker-2', task: 'do the thing' })
  })

  it('rejects a missing or non-whitelisted agent', () => {
    for (const agent of ['', 'gpt']) {
      const res = evaluateSpawnRequest({ ...goodReq, agent }, ctx())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('agent')
    }
  })

  it('rejects a missing or invalid name', () => {
    for (const name of ['', '   ']) {
      const res = evaluateSpawnRequest({ ...goodReq, name }, ctx())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('name')
    }
  })

  it('rejects a name holding "/", the separator of <folder>/<pane> addresses', () => {
    const res = evaluateSpawnRequest({ ...goodReq, name: 'other-project/lead' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('/')
  })

  it('rejects an empty task on a fresh spawn', () => {
    const res = evaluateSpawnRequest({ ...goodReq, task: '' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('task')
  })

  it('accepts an empty task when the request resumes a conversation', () => {
    // A resumed conversation already has its own context; the caller may only
    // want it back on screen and talk to it later with cli_send. A fresh pane
    // with nothing to do is still refused above — this flag is the only thing
    // that changes the answer.
    const res = evaluateSpawnRequest({ ...goodReq, task: '', resumesSession: true }, ctx())
    expect(res).toEqual({ ok: true, agentKey: 'claude', name: 'worker-2', task: '' })
  })

  it('accepts a terminal with an empty task — a bare shell prompt is a pane', () => {
    const res = evaluateSpawnRequest(
      { ...goodReq, agent: 'terminal', task: '' },
      ctx({ validAgentKeys: ['claude', 'terminal'] }),
    )
    expect(res).toEqual({ ok: true, agentKey: 'terminal', name: 'worker-2', task: '' })
  })

  it('refuses a model or effort for a terminal — a shell takes neither', () => {
    const terminalCtx = ctx({ validAgentKeys: ['terminal'] })
    for (const extra of [{ model: 'sonnet' }, { effort: 'high' }]) {
      const res = evaluateSpawnRequest({ ...goodReq, agent: 'terminal', ...extra }, terminalCtx)
      expect(res.ok).toBe(false)
    }
  })

  it('rejects a name collision without renaming', () => {
    const res = evaluateSpawnRequest(goodReq, ctx({ isNameTaken: (n) => n === 'worker-2' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('worker-2')
  })

  it('rejects an empty task', () => {
    const res = evaluateSpawnRequest({ ...goodReq, task: '' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('task')
  })

  it('never rejects on volume: depth past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_ADVISORY_DEPTH - 1 }))
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(goodReq, ctx({ parentDepth: SPAWN_ADVISORY_DEPTH }))
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('深度'))).toBe(true)
    }
  })

  it('never rejects on volume: child count past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(
      goodReq,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT - 1 }),
    )
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(
      goodReq,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT }),
    )
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('子 pane'))).toBe(true)
    }
  })

  it('never rejects on volume: workspace CLI pane count past the advisory threshold still spawns, with a note', () => {
    const below = evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_ADVISORY_CLI_PANES - 1 }))
    expect(below.ok).toBe(true)
    if (below.ok) expect(below.advisories).toBeUndefined()

    const above = evaluateSpawnRequest(goodReq, ctx({ cliPaneCount: SPAWN_ADVISORY_CLI_PANES }))
    expect(above.ok).toBe(true)
    if (above.ok) {
      expect(above.advisories?.length).toBeGreaterThan(0)
      expect(above.advisories?.some((a) => a.includes('CLI pane'))).toBe(true)
    }
  })

  it('combines advisories when multiple thresholds are crossed at once', () => {
    const res = evaluateSpawnRequest(
      goodReq,
      ctx({
        parentDepth: SPAWN_ADVISORY_DEPTH,
        parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT,
        cliPaneCount: SPAWN_ADVISORY_CLI_PANES,
      }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advisories?.length).toBe(3)
  })
})

describe('spawnAdvisoriesFor', () => {
  it('returns the same notes evaluateSpawnRequest would attach, given the same counts', () => {
    const c = { parentDepth: SPAWN_ADVISORY_DEPTH, parentChildCount: 0, cliPaneCount: 0 }
    const direct = spawnAdvisoriesFor(c)
    const viaGate = evaluateSpawnRequest(goodReq, ctx(c))
    expect(viaGate.ok).toBe(true)
    if (viaGate.ok) expect(direct).toEqual(viaGate.advisories)
  })

  it('returns an empty array when nothing crosses a threshold', () => {
    expect(spawnAdvisoriesFor({ parentDepth: 0, parentChildCount: 0, cliPaneCount: 0 })).toEqual([])
  })
})

describe('evaluateTurnSpawns', () => {
  it('evaluates every block in the turn, not just the first', () => {
    const requests = [
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'codex', name: 'worker-b', task: 'b' },
      { agent: 'claude', name: 'worker-c', task: 'c' },
    ]
    const results = evaluateTurnSpawns(requests, ctx())
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('rejects each invalid block independently, without short-circuiting the rest', () => {
    const requests = [
      { agent: 'gpt', name: 'bad-agent', task: 'x' },
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'claude', name: '', task: 'x' },
    ]
    const results = evaluateTurnSpawns(requests, ctx())
    expect(results.map((r) => r.ok)).toEqual([false, true, false])
  })

  it('returns empty for no requests', () => {
    expect(evaluateTurnSpawns([], ctx())).toEqual([])
  })

  it('accumulates parentChildCount and cliPaneCount across the turn, so an advisory appears once the running count crosses the threshold', () => {
    // Starting one below both thresholds: the first two requests should stay
    // clean, and only the third (which pushes the running counts to the
    // threshold) should carry an advisory.
    const requests = [
      { agent: 'claude', name: 'worker-a', task: 'a' },
      { agent: 'claude', name: 'worker-b', task: 'b' },
      { agent: 'claude', name: 'worker-c', task: 'c' },
    ]
    const results = evaluateTurnSpawns(
      requests,
      ctx({
        parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT - 2,
        cliPaneCount: SPAWN_ADVISORY_CLI_PANES - 2,
      }),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const [first, second, third] = results
    if (first.ok) expect(first.advisories).toBeUndefined()
    if (second.ok) expect(second.advisories).toBeUndefined()
    if (third.ok) {
      expect(third.advisories?.length).toBeGreaterThan(0)
      expect(third.advisories?.some((a) => a.includes('子 pane'))).toBe(true)
      expect(third.advisories?.some((a) => a.includes('CLI pane'))).toBe(true)
    }
  })

  it('does not bump the running counts for a rejected request', () => {
    const requests = [
      { agent: 'gpt', name: 'bad-agent', task: 'x' }, // rejected: bad agent key
      { agent: 'claude', name: 'worker-a', task: 'a' },
    ]
    const results = evaluateTurnSpawns(
      requests,
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT }),
    )
    expect(results[0].ok).toBe(false)
    // The second request still sees the un-bumped starting count (already at
    // threshold from ctx, not threshold+1) — proves the rejection above did
    // not advance the running counter.
    expect(results[1].ok).toBe(true)
    if (results[1].ok) {
      expect(
        results[1].advisories?.some((a) => a.includes(`第 ${SPAWN_ADVISORY_CHILDREN_PER_PARENT + 1} 個子 pane`)),
      ).toBe(true)
    }
  })
})

describe('computeSpawnDepth', () => {
  const chain: Record<string, string | undefined> = { c: 'b', b: 'a', a: undefined }
  const parentOf = (id: string): string | undefined => chain[id]

  it('counts walkable spawnedBy links (root = 0)', () => {
    expect(computeSpawnDepth('a', parentOf)).toBe(0)
    expect(computeSpawnDepth('b', parentOf)).toBe(1)
    expect(computeSpawnDepth('c', parentOf)).toBe(2)
  })

  it('stops at a missing ancestor (restart resets depth — accepted MVP)', () => {
    expect(computeSpawnDepth('x', () => undefined)).toBe(0)
  })

  it('guards against cycles', () => {
    const loop: Record<string, string> = { a: 'b', b: 'a' }
    expect(computeSpawnDepth('a', (id) => loop[id])).toBe(1)
  })
})

describe('evaluateTurnSpawns — names claimed within the turn', () => {
  it('rejects a second block asking for a name the first already claimed', () => {
    // isNameTaken only knows about panes that already exist, so without the
    // turn-local claim set both would pass and the second would be silently
    // renamed downstream.
    const gateCtx = ctx()

    const results = evaluateTurnSpawns(
      [
        { agent: 'claude', name: 'worker', task: 'first' },
        { agent: 'claude', name: 'worker', task: 'second' },
      ],
      gateCtx,
    )

    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[1].ok === false && results[1].reason).toContain('已被其他 pane 使用')
  })

  it('a rejected block does not claim its name', () => {
    const gateCtx = ctx()

    const results = evaluateTurnSpawns(
      [
        { agent: 'nope', name: 'worker', task: 'rejected for a bad agent key' },
        { agent: 'claude', name: 'worker', task: 'should still get the name' },
      ],
      gateCtx,
    )

    expect(results[0].ok).toBe(false)
    expect(results[1].ok).toBe(true)
  })
})

describe('evaluateSpawnRequest — model / effort capability', () => {
  // The renderer's AgentSpec is what actually assembles argv, so this gate is
  // the authoritative refusal even though the MCP tool also checks: the
  // backend's capability table is a mirror and can drift from it.

  it('is byte-for-byte unchanged when neither field is asked for (regression guard)', () => {
    // The whole feature must be invisible to every caller that predates it —
    // SPAWN blocks have no model field at all, so they land here as undefined.
    expect(evaluateSpawnRequest(goodReq, ctx())).toEqual({
      ok: true,
      agentKey: 'claude',
      name: 'worker-2',
      task: 'do the thing',
    })
    expect(evaluateSpawnRequest({ ...goodReq, model: '', effort: '' }, ctx())).toEqual({
      ok: true,
      agentKey: 'claude',
      name: 'worker-2',
      task: 'do the thing',
    })
    // Whitespace is "not requested" too, not a model literally named " ".
    expect(evaluateSpawnRequest({ ...goodReq, model: '  ' }, ctx())).toEqual({
      ok: true,
      agentKey: 'claude',
      name: 'worker-2',
      task: 'do the thing',
    })
  })

  it('carries a supported model through to the result, trimmed', () => {
    const res = evaluateSpawnRequest({ ...goodReq, model: '  opus  ' }, ctx())
    expect(res).toEqual({
      ok: true,
      agentKey: 'claude',
      name: 'worker-2',
      task: 'do the thing',
      model: 'opus',
    })
  })

  it('carries a supported model + effort pair through to the result', () => {
    const res = evaluateSpawnRequest(
      { ...goodReq, agent: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      ctx(),
    )
    expect(res).toEqual({
      ok: true,
      agentKey: 'codex',
      name: 'worker-2',
      task: 'do the thing',
      model: 'gpt-5.3-codex',
      effort: 'high',
    })
  })

  it('rejects a model for a vendor that cannot be told one, naming the vendor', () => {
    // droid accepts an unknown --model and ignores it, so a dropped flag would
    // look like success until someone read the transcript.
    const res = evaluateSpawnRequest({ ...goodReq, agent: 'droid', model: 'opus' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toContain('droid')
      expect(res.reason).toContain('model')
      expect(res.reason).toContain('預設模型')
    }
  })

  it('rejects effort for a vendor that has no separate effort flag, pointing at model', () => {
    // cursor encodes effort in the model id (gpt-5.3-codex-high); the refusal
    // has to say so or the caller retries with the same shape.
    const res = evaluateSpawnRequest({ ...goodReq, agent: 'cursor', effort: 'high' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toContain('cursor')
      expect(res.reason).toContain('effort')
      expect(res.reason).toContain('model')
    }
  })

  it('rejects an effort value outside the vendor vocabulary and lists what is accepted', () => {
    const res = evaluateSpawnRequest({ ...goodReq, agent: 'codex', effort: 'extreme' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toContain('extreme')
      for (const accepted of ['minimal', 'low', 'medium', 'high']) {
        expect(res.reason).toContain(accepted)
      }
    }
  })

  it('accepts every value the vendor declares', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high']) {
      const res = evaluateSpawnRequest({ ...goodReq, agent: 'codex', effort }, ctx())
      expect(res.ok, effort).toBe(true)
      if (res.ok) expect(res.effort).toBe(effort)
    }
  })

  it('checks the agent key before the model, so a bad key is not masked', () => {
    const res = evaluateSpawnRequest({ ...goodReq, agent: 'gpt', model: 'opus' }, ctx())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('agent')
  })

  it('refuses rather than dropping when the key has no spec at all', () => {
    // A key on the whitelist whose spec lookup returns undefined would silently
    // launch on the default if the refusal were skipped.
    const res = evaluateSpawnRequest(
      { ...goodReq, model: 'opus' },
      ctx({ modelCapabilityFor: () => undefined }),
    )
    expect(res.ok).toBe(false)
  })

  it('still reports advisories alongside an accepted model', () => {
    const res = evaluateSpawnRequest(
      { ...goodReq, model: 'opus' },
      ctx({ cliPaneCount: SPAWN_ADVISORY_CLI_PANES }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.model).toBe('opus')
      expect(res.advisories).toHaveLength(1)
    }
  })

  it('propagates the refusal through evaluateTurnSpawns without bumping counts', () => {
    const results = evaluateTurnSpawns(
      [
        { agent: 'droid', name: 'a', task: 't', model: 'opus' },
        { agent: 'claude', name: 'b', task: 't' },
      ],
      ctx({ parentChildCount: SPAWN_ADVISORY_CHILDREN_PER_PARENT - 1 }),
    )
    expect(results[0].ok).toBe(false)
    expect(results[1].ok).toBe(true)
    // The rejected request must not have consumed a child slot.
    if (results[1].ok) expect(results[1].advisories).toBeUndefined()
  })
})

describe('evaluateSpawnRequest — a stored launch command', () => {
  // The stored command runs verbatim, so a model the caller named could not
  // reach argv. Accepting it would answer ok for a pane on the vendor default.
  // codex: the fixture shape with both flags, so effort alone is a valid ask.
  const overridden = ctx({ launchCommandOverridden: (key) => key === 'codex' })
  const codexReq = { ...goodReq, agent: 'codex' }

  it('refuses an explicit model or effort for that agent, naming the setting', () => {
    for (const extra of [{ model: 'gpt-5' }, { effort: 'high' }]) {
      const res = evaluateSpawnRequest({ ...codexReq, ...extra }, overridden)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain('啟動指令')
    }
  })

  it('accepts the same request with no model — the override itself is fine', () => {
    expect(evaluateSpawnRequest(codexReq, overridden).ok).toBe(true)
  })

  it('accepts a model for an agent without an override', () => {
    expect(evaluateSpawnRequest({ ...goodReq, model: 'opus-5' }, overridden).ok).toBe(true)
  })

  it('accepts a model on a resume, whose command never reads the setting', () => {
    const res = evaluateSpawnRequest({ ...codexReq, model: 'gpt-5', resumesSession: true }, overridden)
    expect(res.ok).toBe(true)
  })

  it('applies to every SPAWN block in a turn too', () => {
    const [res] = evaluateTurnSpawns([{ ...codexReq, model: 'gpt-5' }], overridden)
    expect(res.ok).toBe(false)
  })
})

describe('assertAgentKeyAllowed', () => {
  const validAgentKeys = ['claude', 'codex', 'cursor', 'droid']

  it('rejects a key that is not in the whitelist', () => {
    expect(() => assertAgentKeyAllowed('terminal', validAgentKeys)).toThrow()
  })

  it('accepts "terminal" when the whitelist lists it, as App.vue\'s does', () => {
    expect(assertAgentKeyAllowed('terminal', [...validAgentKeys, 'terminal'])).toBe('terminal')
  })

  it('returns the key when it is in the whitelist', () => {
    expect(assertAgentKeyAllowed('claude', validAgentKeys)).toBe('claude')
  })

  it('rejects a non-string agent value', () => {
    expect(() => assertAgentKeyAllowed(undefined, validAgentKeys)).toThrow()
    expect(() => assertAgentKeyAllowed(123, validAgentKeys)).toThrow()
  })
})
