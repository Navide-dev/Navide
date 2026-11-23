import { describe, it, expect } from 'vitest'
import { effortSuffixConflict, modelArgsFor, supportsModel, supportsEffort } from './cliModel'

/** A vendor that takes both, with a closed effort vocabulary. */
const full = {
  modelArgs: (m: string) => `--model ${m}`,
  effortArgs: (e: string) => `--reasoning-effort ${e}`,
  knownEfforts: ['low', 'medium', 'high'] as const,
}
/** A vendor that selects a model but has no separate effort flag — effort
 *  lives in the model id instead. */
const modelOnly = { modelArgs: (m: string) => `--model ${m}` }
/** A vendor that cannot be told anything at launch. */
const neither = {}

const req = (model = '', effort = '') => ({ model, effort })

describe('modelArgsFor', () => {
  it('asks for nothing and gets nothing, for every vendor', () => {
    // The pre-existing behaviour of every caller that passes no model: no
    // arguments, no refusal, whatever the vendor supports.
    for (const spec of [full, modelOnly, neither, undefined]) {
      expect(modelArgsFor({ spec, request: req() })).toEqual({ ok: true, args: '' })
    }
  })

  it('builds the vendor flag for a supported model', () => {
    expect(modelArgsFor({ spec: full, request: req('gpt-5.6-sol') })).toEqual({
      ok: true,
      args: '--model gpt-5.6-sol',
    })
  })

  it('REFUSES a model the vendor cannot select, rather than dropping it', () => {
    // The whole point: a swallowed flag is indistinguishable from a working
    // one until someone reads the transcript.
    const result = modelArgsFor({ spec: neither, request: req('gpt-5.6-sol') })
    expect(result).toEqual({ ok: false, refusal: { kind: 'model-unsupported' } })
  })

  it('refuses a model when there is no spec at all', () => {
    expect(modelArgsFor({ spec: undefined, request: req('anything') })).toEqual({
      ok: false,
      refusal: { kind: 'model-unsupported' },
    })
  })

  it('refuses effort for a vendor that encodes it in the model id', () => {
    const result = modelArgsFor({ spec: modelOnly, request: req('gpt-5.3-codex', 'high') })
    expect(result).toEqual({ ok: false, refusal: { kind: 'effort-unsupported' } })
  })

  it('refuses an effort value outside the vendor vocabulary, and says which are accepted', () => {
    const result = modelArgsFor({ spec: full, request: req('', 'extreme') })
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'effort-invalid', accepted: ['low', 'medium', 'high'] },
    })
  })

  it('accepts any effort when the vendor declares no vocabulary', () => {
    const open = { modelArgs: modelOnly.modelArgs, effortArgs: (e: string) => `--effort ${e}` }
    expect(modelArgsFor({ spec: open, request: req('', 'whatever') })).toEqual({
      ok: true,
      args: '--effort whatever',
    })
  })

  it('does not validate model ids — they change every release', () => {
    // A model id nobody has heard of must still launch: rejecting it here
    // would break the day a vendor ships a new name.
    expect(modelArgsFor({ spec: full, request: req('model-from-the-future') })).toEqual({
      ok: true,
      args: '--model model-from-the-future',
    })
  })

  it('emits model before effort when both are asked for', () => {
    expect(modelArgsFor({ spec: full, request: req('gpt-5.6-sol', 'high') })).toEqual({
      ok: true,
      args: '--model gpt-5.6-sol --reasoning-effort high',
    })
  })

  it('treats whitespace-only input as not requested', () => {
    expect(modelArgsFor({ spec: neither, request: req('   ', '  ') })).toEqual({
      ok: true,
      args: '',
    })
  })

  it('trims the values it passes to the vendor', () => {
    expect(modelArgsFor({ spec: full, request: req('  gpt-5.6-sol  ', ' high ') })).toEqual({
      ok: true,
      args: '--model gpt-5.6-sol --reasoning-effort high',
    })
  })

  it('refuses effort before building anything, so a bad request yields no argv', () => {
    const result = modelArgsFor({ spec: full, request: req('gpt-5.6-sol', 'extreme') })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('args')
  })

  it('drops an argument the vendor builds as empty rather than emitting a stray space', () => {
    const quiet = { modelArgs: () => '' }
    expect(modelArgsFor({ spec: quiet, request: req('x') })).toEqual({ ok: true, args: '' })
  })
})

describe('argument-shape guard', () => {
  // A model id is data placed after a flag. If it can carry whitespace or
  // start with a dash, anyone who can call the spawn tool — including a remote
  // agent reached through cli_send — can append flags to a local process.
  it('refuses a model that would split into extra arguments', () => {
    const result = modelArgsFor({
      spec: full,
      request: req('sonnet --dangerously-skip-permissions'),
    })
    expect(result).toEqual({ ok: false, refusal: { kind: 'model-malformed' } })
  })

  it('refuses a model that is itself a flag', () => {
    for (const attack of ['--dangerously-skip-permissions', '-r', '--model']) {
      expect(modelArgsFor({ spec: full, request: req(attack) }), attack).toEqual({
        ok: false,
        refusal: { kind: 'model-malformed' },
      })
    }
  })

  it('trims surrounding whitespace instead of refusing it, as the backend does', () => {
    // The backend helper trims too, so both sides answer the same for this.
    // An interior newline is a different matter and is refused below.
    expect(modelArgsFor({ spec: full, request: req('  sonnet\n') })).toEqual({
      ok: true,
      args: '--model sonnet',
    })
  })

  it('refuses shell metacharacters and separators', () => {
    for (const attack of ['a;b', 'a|b', 'a&b', '$(whoami)', '`id`', 'a>b', "a'b", 'a\nb']) {
      expect(modelArgsFor({ spec: full, request: req(attack) }), attack).toEqual({
        ok: false,
        refusal: { kind: 'model-malformed' },
      })
    }
  })

  it('refuses the same shapes in effort, where a vendor declares no vocabulary', () => {
    // knownEfforts already bounds the five vendors that have one; this covers
    // the combination the type system permits but no vendor uses yet.
    const open = { modelArgs: (m: string) => `--model ${m}`, effortArgs: (e: string) => `-e ${e}` }
    expect(modelArgsFor({ spec: open, request: req('', '--yolo') })).toEqual({
      ok: false,
      refusal: { kind: 'effort-malformed' },
    })
  })

  it('distinguishes malformed from unsupported', () => {
    // Reporting a malformed value as "unsupported" would send the caller to
    // try another CLI with the same injected string.
    const malformed = modelArgsFor({ spec: full, request: req('a b') })
    const unsupported = modelArgsFor({ spec: neither, request: req('sonnet') })
    expect(malformed).not.toEqual(unsupported)
  })

  it('still accepts every real model id shape', () => {
    // The guard must not become an identity check: these are the four shapes
    // vendors actually ship.
    for (const id of [
      'sonnet',
      'openai/gpt-5.6-sol',
      'gpt-5.3-codex-high',
      'anthropic/claude:thinking',
      'model-from-the-future-2099.1',
    ]) {
      expect(modelArgsFor({ spec: full, request: req(id) }).ok, id).toBe(true)
    }
  })
})

describe('capability predicates', () => {
  it('reports what each vendor shape supports', () => {
    expect(supportsModel(full)).toBe(true)
    expect(supportsEffort(full)).toBe(true)
    expect(supportsModel(modelOnly)).toBe(true)
    expect(supportsEffort(modelOnly)).toBe(false)
    expect(supportsModel(neither)).toBe(false)
    expect(supportsEffort(neither)).toBe(false)
    expect(supportsModel(undefined)).toBe(false)
    expect(supportsEffort(undefined)).toBe(false)
  })
})

describe('effortSuffixConflict', () => {
  const ask = (model: string, effort: string, spec: Parameters<typeof effortSuffixConflict>[0]['spec'] = full) =>
    effortSuffixConflict({ spec, request: { model, effort } })

  it('names the suffix when the id carries a different level than the picked effort', () => {
    expect(ask('gemini-4-neon-low', 'high')).toBe('low')
    expect(ask(' gemini-4-neon-medium ', ' low ')).toBe('medium')
  })

  it('stays quiet when the levels agree, either side is empty, or the suffix is not a level', () => {
    expect(ask('gemini-4-neon-low', 'low')).toBe('')
    expect(ask('gemini-4-neon', 'high')).toBe('')
    expect(ask('gemini-4-neon-low', '')).toBe('')
    expect(ask('', 'high')).toBe('')
    expect(ask('high', 'low')).toBe('')
    expect(ask('gemini-4-neon-xhigh', 'low')).toBe('')
  })

  it('needs a known vocabulary to recognise a suffix', () => {
    expect(ask('gemini-4-neon-low', 'high', modelOnly)).toBe('')
    expect(effortSuffixConflict({ spec: undefined, request: { model: 'gemini-4-neon-low', effort: 'high' } })).toBe('')
  })

  it('never turns a conflicting pick into a refusal', () => {
    expect(modelArgsFor({ spec: full, request: { model: 'gemini-4-neon-low', effort: 'high' } })).toEqual({
      ok: true,
      args: '--model gemini-4-neon-low --reasoning-effort high',
    })
  })
})
