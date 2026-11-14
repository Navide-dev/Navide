import { describe, expect, it } from 'vitest'
import { curlExample, formUrl, minutesLeft, outcomeKey, refusalKey, triggerState, triggerUrl, type WebhookStatus, type WebhookTrigger } from '../webhookTriggers'

const trigger = { id: 't', enabled: true } as WebhookTrigger
const status = (over: Partial<WebhookStatus> = {}): WebhookStatus =>
  ({ listening: true, runs: [], port: 4000, settings: { enabled: true, port: 4000, public_host: '' }, ...over }) as WebhookStatus

describe('triggerUrl', () => {
  it('is loopback until a public host is declared', () => {
    expect(triggerUrl(status(), 'abc')).toBe('http://127.0.0.1:4000/webhook/abc')
  })
  it('is the public host once there is one', () => {
    expect(triggerUrl(status({ settings: { enabled: true, port: 4000, public_host: 'hook.example.com' } }), 'abc'))
      .toBe('https://hook.example.com/webhook/abc')
  })
  it('falls back to the stored port while nothing listens', () => {
    expect(triggerUrl(status({ port: 0 }), 'abc')).toContain(':4000/')
  })
})

describe('formUrl', () => {
  const pub = status({ settings: { enabled: true, port: 4000, public_host: 'form.example.com' } })
  it('stays on loopback until the form is public', () => {
    expect(formUrl(pub, 'tok', false)).toBe('http://127.0.0.1:4000/form/tok')
    expect(formUrl(pub, 'tok', true)).toBe('https://form.example.com/form/tok')
  })
  it('stays on loopback with no host to publish it on', () => {
    expect(formUrl(status(), 'tok', true)).toBe('http://127.0.0.1:4000/form/tok')
  })
})

describe('triggerState', () => {
  it('reads the trigger, the listener and the run', () => {
    expect(triggerState({ ...trigger, enabled: false }, status())).toBe('off')
    expect(triggerState(trigger, status({ listening: false }))).toBe('listener-off')
    expect(triggerState(trigger, status())).toBe('ready')
  })
  it('a run outranks the rest, and a run that waits says so', () => {
    const run = { trigger_id: 't', workspace: '/w', started_at: 1, unattended: false, waiting_since: null, stops_at: null }
    expect(triggerState(trigger, status({ runs: [run] }))).toBe('running')
    expect(triggerState(trigger, status({ runs: [{ ...run, waiting_since: 1, stops_at: 2 }] }))).toBe('waiting')
  })
})

describe('minutesLeft', () => {
  it('rounds up and never goes below zero', () => {
    expect(minutesLeft(120, 60_000)).toBe(1)
    expect(minutesLeft(121, 60_000)).toBe(2)
    expect(minutesLeft(10, 60_000)).toBe(0)
  })
})

describe('words for what the backend says', () => {
  it('knows its refusals, and only those', () => {
    expect(refusalKey('vendor-refused')).toBe('webhooks.refused.vendor-refused')
    expect(refusalKey('')).toBe('')
    expect(refusalKey('other')).toBe('')
  })
  it('leaves an outcome it has no words for as it is', () => {
    expect(outcomeKey('started')).toBe('webhooks.outcome.started')
    expect(outcomeKey('something-new')).toBe('')
  })
})

it('curlExample carries the url and the key', () => {
  const out = curlExample('http://x/webhook/1', 'nv' + 'wh_abc')
  expect(out).toContain('http://x/webhook/1')
  expect(out).toContain('Bearer nvwh_abc')
})
