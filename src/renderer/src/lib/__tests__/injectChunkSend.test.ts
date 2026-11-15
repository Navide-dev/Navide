import { describe, expect, it, vi } from 'vitest'
import { CHUNK_SEND_ATTEMPTS, isRequestTimeout, sendChunkWithRetry } from '../injectChunkSend'

const timeout = (): Error => new Error('request terminal.input timeout')

describe('sendChunkWithRetry', () => {
  it('resends a chunk whose request timed out, and reports the answer that came', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ payload: { ok: true, pending: 0, duplicate: true } })
    const res = await sendChunkWithRetry(send)
    expect(send).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ ok: true, resp: { payload: { ok: true, pending: 0, duplicate: true } } })
  })

  it('gives up after the attempt budget and says the chunk may still be written', async () => {
    const send = vi.fn().mockRejectedValue(timeout())
    const res = await sendChunkWithRetry(send)
    expect(send).toHaveBeenCalledTimes(CHUNK_SEND_ATTEMPTS)
    expect(res).toMatchObject({ ok: false, timedOut: true })
  })

  it('does not resend anything but a timeout', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ws not open'))
    const res = await sendChunkWithRetry(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ ok: false, timedOut: false })
  })

  it('stops resending once the injection is aborted', async () => {
    const send = vi.fn().mockRejectedValue(timeout())
    const res = await sendChunkWithRetry(send, { aborted: () => true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ ok: false, timedOut: true })
  })
})

describe('isRequestTimeout', () => {
  it('matches only wsClient request timeouts', () => {
    expect(isRequestTimeout(timeout())).toBe(true)
    expect(isRequestTimeout(new Error('ws not open'))).toBe(false)
    expect(isRequestTimeout('request terminal.input timeout')).toBe(false)
  })
})
