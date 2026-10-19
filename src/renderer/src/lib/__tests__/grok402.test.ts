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
const WORKSPACE = '/Users/someone/workspace'

// A resumed pane replaying a conversation that quotes the prompt: the words
// are on screen, but the live screen below them is the composer.
const QUOTED = [
  'user: Grok kept asking me this:',
  TRUST_SCREEN,
  'grok: That is the folder-trust prompt; answer y once.',
  COMPOSER,
].join('\n')

// The same live prompt, for a folder that is not the pane's workspace.
const OTHER_FOLDER = TRUST_SCREEN.replace(WORKSPACE, '/etc')

describe('the trust prompt is an answerable wait', () => {
  it('reads Grok Build trust prompt as awaiting, and its composer as not', () => {
    expect(hasAwaitingPattern('grok')).toBe(true)
    expect(matchAwaitingInput('grok', TRUST_SCREEN)).toBe(true)
    expect(matchAwaitingInput('grok', COMPOSER)).toBe(false)
  })

  it('does not read a quoted prompt above the composer as a wait', () => {
    expect(matchAwaitingInput('grok', QUOTED)).toBe(false)
  })

  it('answers it with the keys the prompt names', () => {
    const resolve = (answer: PaneAnswer) =>
      resolveAnswerKeys({
        agentKey: 'grok', displayStatus: 'awaiting', awaitingKind: 'permission', screen: TRUST_SCREEN, answer,
      })
    // Trusting a folder lasts and is shared by every Grok pane: a permanent
    // allow, which only the user gives (#442's rule).
    expect(resolve({ kind: 'permission', choice: 'allow' })).toMatchObject({ ok: false })
    expect(resolve({ kind: 'permission', choice: 'deny' })).toEqual({ ok: true, keys: 'n' })
    expect(resolve({ kind: 'question', option: 1 })).toEqual({ ok: false, error: 'unsupported for grok' })
  })
})

describe('Grok panes accept the trust prompt at launch, fresh or resumed', () => {
  it('names the keys only while the prompt is on screen', () => {
    expect(startupTrustKeys('grok', TRUST_SCREEN, WORKSPACE)).toBe('y')
    expect(startupTrustKeys('grok', TRUST_SCREEN, `${WORKSPACE}/`)).toBe('y')
    expect(startupTrustKeys('grok', COMPOSER, WORKSPACE)).toBeNull()
    expect(startupTrustKeys('claude', TRUST_SCREEN, WORKSPACE)).toBeNull()
  })

  it('never accepts a quoted prompt', () => {
    expect(startupTrustKeys('grok', QUOTED, WORKSPACE)).toBeNull()
  })

  it('accepts only the pane\'s own workspace', () => {
    expect(startupTrustKeys('grok', OTHER_FOLDER, WORKSPACE)).toBeNull()
    expect(startupTrustKeys('grok', OTHER_FOLDER, '/etc/x')).toBeNull()
    expect(startupTrustKeys('grok', TRUST_SCREEN, '')).toBeNull()
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
      folder: WORKSPACE,
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
