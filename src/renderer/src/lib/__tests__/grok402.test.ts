import { describe, expect, it, vi } from 'vitest'
import { AGENT_SPECS } from '@navide/plugin-shell'
import { hasAwaitingPattern, matchAwaitingInput } from '../cliAwaitingInput'
import { resolveAnswerKeys, type PaneAnswer } from '../paneAnswerKeys'
import { pinFreshSessionAtLaunch } from '../sessionHeal'
import { acceptStartupTrust, startupTrustKeys } from '../startupTrust'

// Issue #402: the official Grok Build CLI (1.0.62) inside Navide panes.

// Grok Build's folder-trust prompt as the pane renders it (issue #402 log).
const TRUST_SCREEN = [
  'Do you trust the contents of this directory?',
  '/Users/someone/workspace',
  'Grok Build may run or modify contents in this directory, posing security risks.',
  '  Yes, proceed   y',
  '  No, quit       n',
].join('\n')

const COMPOSER = '> \n  grok-build · ctrl+c to quit'

describe('the trust prompt is an answerable wait', () => {
  it('reads Grok Build trust prompt as awaiting, and its composer as not', () => {
    expect(hasAwaitingPattern('grok')).toBe(true)
    expect(matchAwaitingInput('grok', TRUST_SCREEN)).toBe(true)
    expect(matchAwaitingInput('grok', COMPOSER)).toBe(false)
  })

  it('answers it with the keys the prompt names', () => {
    const resolve = (answer: PaneAnswer) =>
      resolveAnswerKeys({
        agentKey: 'grok', displayStatus: 'awaiting', awaitingKind: 'permission', screen: TRUST_SCREEN, answer,
      })
    expect(resolve({ kind: 'permission', choice: 'allow' })).toEqual({ ok: true, keys: 'y' })
    expect(resolve({ kind: 'permission', choice: 'deny' })).toEqual({ ok: true, keys: 'n' })
    expect(resolve({ kind: 'question', option: 1 })).toEqual({ ok: false, error: 'unsupported for grok' })
  })
})

describe('Grok panes accept the trust prompt at launch, fresh or resumed', () => {
  it('names the keys only while the prompt is on screen', () => {
    expect(startupTrustKeys('grok', TRUST_SCREEN)).toBe('y')
    expect(startupTrustKeys('grok', COMPOSER)).toBeNull()
    expect(startupTrustKeys('claude', TRUST_SCREEN)).toBeNull()
  })

  function harness(screens: string[]) {
    let t = 0
    let i = 0
    let bytes = 0
    const send = vi.fn(async () => {})
    const deps = {
      readScreen: () => screens[Math.min(i, screens.length - 1)],
      outputBytes: () => bytes,
      alive: () => true,
      send,
      sleep: async (ms: number) => {
        t += ms
        i += 1
        if (i < screens.length) bytes += 10
      },
      now: () => t,
      timeoutMs: 8000,
      quietMs: 1500,
    }
    return { deps, send }
  }

  it('presses the accept key once when the prompt shows up', async () => {
    const { deps, send } = harness(['', 'loading…', TRUST_SCREEN])
    await expect(acceptStartupTrust('grok', deps)).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('y')
  })

  it('types nothing into a pane that never asks', async () => {
    const { deps, send } = harness(['banner', COMPOSER])
    await expect(acceptStartupTrust('grok', deps)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Grok pins its session id at launch instead of typing a marker', () => {
  const grok = AGENT_SPECS.find((s) => s.agentKey === 'grok')

  it('sends no session marker turn', () => {
    expect(grok?.needsSessionMarker).toBeFalsy()
  })

  it('starts a fresh pane with --session-id and a UUIDv7', () => {
    const res = pinFreshSessionAtLaunch('grok', false, 'grok', undefined, () => 'not-used')
    expect(res.explicitSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(res.command).toBe(`grok --session-id ${res.explicitSessionId}`)
  })

  it('leaves a resume and a hand-written id alone', () => {
    expect(pinFreshSessionAtLaunch('grok', true, 'grok -r x', undefined, () => 'g'))
      .toEqual({ command: 'grok -r x', explicitSessionId: '' })
    const id = '0199f3a2-1b2c-7d3e-8f40-0123456789ab'
    expect(pinFreshSessionAtLaunch('grok', false, `grok --session-id ${id}`, undefined, () => 'g'))
      .toEqual({ command: `grok --session-id ${id}`, explicitSessionId: id })
  })

  it('reuses a requested id for a fresh rebuild', () => {
    const id = '0199f3a2-1b2c-7d3e-8f40-0123456789ab'
    expect(pinFreshSessionAtLaunch('grok', false, 'grok', id, () => 'g'))
      .toEqual({ command: `grok --session-id ${id}`, explicitSessionId: id })
  })
})
