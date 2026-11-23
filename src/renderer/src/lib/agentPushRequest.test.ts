import { describe, expect, it, vi } from 'vitest'
import { requestAgentPush } from './agentPushRequest'

describe('requestAgentPush', () => {
  it('asks again under the same push_id when the answer is lost', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('WebSocket closed'))
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } })
    const answer = await requestAgentPush(send, 'pane-1', 'hello', 'push-1')
    expect(answer).toEqual({ ok: true, payload: { ok: true } })
    expect(send).toHaveBeenCalledTimes(2)
    for (const call of send.mock.calls) {
      expect(call[1]).toEqual({ pane_id: 'pane-1', text: 'hello', push_id: 'push-1' })
    }
  })

  it('returns null, not a refusal, when no answer ever comes back', async () => {
    const send = vi.fn().mockRejectedValue(new Error('request agent_msg.push timeout'))
    expect(await requestAgentPush(send, 'pane-1', 'hello', 'push-1', 2)).toBeNull()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('asks once when the first answer arrives', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, payload: { ok: false, reason: 'no-channel' } })
    await requestAgentPush(send, 'pane-1', 'hello', 'push-1')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
