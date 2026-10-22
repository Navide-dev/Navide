import { describe, expect, it } from 'vitest'
import {
  ACP_PART_MAX,
  acpDisplayStatus,
  acpMessagingHoldKey,
  acpTerminalStatus,
  applyAcpUpdate,
  permissionFromEvent,
  transcriptText,
  type TranscriptEntry,
} from '../acpPane'

describe('acpDisplayStatus', () => {
  it('maps the agent states onto the badge words', () => {
    expect(acpDisplayStatus('none', 0)).toBe('starting')
    expect(acpDisplayStatus('starting', 0)).toBe('starting')
    expect(acpDisplayStatus('idle', 0)).toBe('idle')
    expect(acpDisplayStatus('running', 0)).toBe('running')
    expect(acpDisplayStatus('exited', 0)).toBe('exited')
    expect(acpDisplayStatus('failed', 0)).toBe('error')
  })

  it('reads cancelling as running: still busy, no status of its own (decided 2026-10-23)', () => {
    expect(acpDisplayStatus('cancelling', 0)).toBe('running')
  })

  it('parks the pane on the user while a permission request is open', () => {
    expect(acpDisplayStatus('running', 1)).toBe('awaiting')
    expect(acpDisplayStatus('cancelling', 2)).toBe('awaiting')
    // A process that is gone is not waiting on anyone.
    expect(acpDisplayStatus('exited', 1)).toBe('exited')
  })
})

describe('acpTerminalStatus', () => {
  it('is running for as long as the agent process is up, turn or not', () => {
    expect(acpTerminalStatus('idle')).toBe('running')
    expect(acpTerminalStatus('running')).toBe('running')
    expect(acpTerminalStatus('cancelling')).toBe('running')
    expect(acpTerminalStatus('starting')).toBe('starting')
    expect(acpTerminalStatus('exited')).toBe('exited')
    expect(acpTerminalStatus('failed')).toBe('error')
  })
})

describe('acpMessagingHoldKey (risk 2: an ACP pane must not read busy forever)', () => {
  it('lets an idle ACP pane take messages', () => {
    expect(acpMessagingHoldKey('idle')).toBeNull()
  })

  it('holds while a turn runs, while starting, and while parked or gone', () => {
    expect(acpMessagingHoldKey('running')).toBe('mid-turn')
    expect(acpMessagingHoldKey('starting')).toBe('starting')
    expect(acpMessagingHoldKey(undefined)).toBe('starting')
    expect(acpMessagingHoldKey('awaiting')).toBe('not-ready')
    expect(acpMessagingHoldKey('exited')).toBe('not-ready')
  })
})

describe('applyAcpUpdate / transcriptText', () => {
  it('joins consecutive chunks of one role and counts the text added', () => {
    const entries: TranscriptEntry[] = []
    expect(applyAcpUpdate(entries, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } })).toBe(2)
    applyAcpUpdate(entries, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } })
    applyAcpUpdate(entries, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ', world' } })

    // Chunks join the last part while it stays under ACP_PART_MAX.
    expect(entries).toEqual([{ role: 'user', parts: ['hi'] }, { role: 'agent', parts: ['Hello, world'] }])
    expect(transcriptText(entries)).toBe('> hi\nHello, world')
  })

  it('starts a new part once the last one would pass ACP_PART_MAX', () => {
    const entries: TranscriptEntry[] = []
    applyAcpUpdate(entries, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a'.repeat(ACP_PART_MAX - 1) } })
    applyAcpUpdate(entries, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } })
    applyAcpUpdate(entries, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } })

    expect(entries[0].parts.map((p) => p.length)).toEqual([ACP_PART_MAX, 1])
  })

  it('keeps an unconfirmed prompt in the pane text (the agent may have it), and a refused one out', () => {
    const entries: TranscriptEntry[] = [
      { role: 'user', parts: ['maybe'], delivery: 'unconfirmed' },
      { role: 'user', parts: ['lost'], delivery: 'unsent' },
    ]
    applyAcpUpdate(entries, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'again' } })

    expect(entries).toHaveLength(3)
    expect(transcriptText(entries)).toBe('> maybe\n> again')
  })

  it('keeps one entry per tool call, updated in place', () => {
    const entries: TranscriptEntry[] = []
    applyAcpUpdate(entries, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read notes.md', status: 'pending' })
    applyAcpUpdate(entries, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })

    expect(entries).toEqual([{ role: 'tool', parts: ['Read notes.md'], toolCallId: 't1', status: 'completed' }])
  })

  it('leaves thoughts out of the text other features read, and ignores what it does not know', () => {
    const entries: TranscriptEntry[] = []
    applyAcpUpdate(entries, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } })
    expect(applyAcpUpdate(entries, { sessionUpdate: 'plan', entries: [] })).toBe(0)
    expect(applyAcpUpdate(entries, null)).toBe(0)

    expect(entries).toHaveLength(1)
    expect(transcriptText(entries)).toBe('')
  })
})

describe('permissionFromEvent', () => {
  it('keeps the agent options as given, with their ids', () => {
    expect(permissionFromEvent({
      request_id: 'r1',
      toolCall: { title: 'Write notes.md' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { name: 'no id' }],
    })).toEqual({
      requestId: 'r1',
      title: 'Write notes.md',
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
    })
    expect(permissionFromEvent({ options: [] })).toBeNull()
  })
})
