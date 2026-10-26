import { describe, expect, it } from 'vitest'
import { createMockBackend } from './mockBackend'
import { renderEnvelope } from '../../lib/agentMessaging'
import { pinFreshSessionAtLaunch } from '../../lib/sessionHeal'

// The host terminal port is what lets an embedded AI panel (AiCliDock) in a
// host window take messages: it hears the backend's agent_msg.deliver
// broadcast, renders the same envelope the main window injects into a pane,
// and reports the outcome the same way the main window does.
describe('Host terminal dock adapter — agent message delivery', () => {
  const deliver = {
    msg_key: 'k-1',
    target_pane_id: 'ab12cd34-plans-ai-terminal',
    from_pane_id: 'p-1',
    from_display: 'reviewer',
    content: 'please look at the plan',
  }

  it('hands every delivery to the subscriber with the main window envelope', () => {
    const { terminalPort, emit } = createMockBackend()
    const got: unknown[] = []
    const off = terminalPort.onAgentMessage!((m) => got.push(m))
    emit('agent_msg.deliver', deliver)
    expect(got).toEqual([{
      msgKey: 'k-1',
      targetPaneId: 'ab12cd34-plans-ai-terminal',
      fromDisplay: 'reviewer',
      text: renderEnvelope('reviewer', 'please look at the plan', { correlationId: 'k-1', external: false }),
    }])
    off()
    emit('agent_msg.deliver', { ...deliver, msg_key: 'k-2' })
    expect(got).toHaveLength(1)
  })

  it('fences a chat-channel message as external content', () => {
    const { terminalPort, emit } = createMockBackend()
    const got: Array<{ text: string }> = []
    terminalPort.onAgentMessage!((m) => got.push(m))
    emit('agent_msg.deliver', { ...deliver, from_pane_id: '', from_display: 'telegram:alice', origin: 'channel' })
    expect(got[0].text).toBe(
      renderEnvelope('telegram:alice', 'please look at the plan', { correlationId: 'k-1', external: true }),
    )
  })

  it('asks a host caller with no reply route for its answer in the final output', () => {
    const { terminalPort, emit } = createMockBackend()
    const got: Array<{ text: string }> = []
    terminalPort.onAgentMessage!((m) => got.push(m))
    emit('agent_msg.deliver', { ...deliver, from_pane_id: '', from_display: 'a host client' })
    expect(got[0].text).toBe(
      renderEnvelope('a host client', 'please look at the plan', { correlationId: 'k-1', external: false, noReplyRoute: true }),
    )
    expect(got[0].text).not.toContain('to: a host client')
  })

  it('marks an ack so it is reported, never typed', () => {
    const { terminalPort, emit } = createMockBackend()
    const got: Array<{ kind?: string }> = []
    terminalPort.onAgentMessage!((m) => got.push(m))
    emit('agent_msg.deliver', { ...deliver, kind: 'ack' })
    expect(got[0].kind).toBe('ack')
  })

  it('ignores a malformed delivery', () => {
    const { terminalPort, emit } = createMockBackend()
    const got: unknown[] = []
    terminalPort.onAgentMessage!((m) => got.push(m))
    emit('agent_msg.deliver', { ...deliver, content: '' })
    emit('agent_msg.deliver', { ...deliver, target_pane_id: '' })
    expect(got).toEqual([])
  })

  it('reports the outcome as agent_msg.delivered with an encoded reason', async () => {
    const { terminalPort, sent } = createMockBackend()
    await terminalPort.reportAgentDelivery!('k-1', true)
    await terminalPort.reportAgentDelivery!('k-2', false, 'pane-closed')
    expect(sent).toEqual([
      { type: 'agent_msg.delivered', payload: { msg_key: 'k-1', ok: true, reason: '' }, timeoutMs: undefined },
      {
        type: 'agent_msg.delivered',
        payload: { msg_key: 'k-2', ok: false, reason: JSON.stringify({ key: 'pane-closed' }) },
        timeoutMs: undefined,
      },
    ])
  })

  it('pins fresh sessions with the same function the main window spawns with', () => {
    const { terminalPort } = createMockBackend()
    expect(terminalPort.pinFreshSessionAtLaunch).toBe(pinFreshSessionAtLaunch)
  })
})
