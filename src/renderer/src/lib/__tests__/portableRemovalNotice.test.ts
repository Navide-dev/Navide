import { describe, expect, it, vi } from 'vitest'
import { showPortableRemovalNotice } from '../portableRemovalNotice'

type Backend = Parameters<typeof showPortableRemovalNotice>[0]

function backend(reply: { ok: boolean; payload?: { show?: boolean } | null } | Error) {
  const send = vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return reply
  })
  return { send, backend: { send } as unknown as Backend }
}

const t = (key: string) => `t:${key}`

describe('showPortableRemovalNotice', () => {
  it('shows a sticky info toast when the backend says this machine was cleaned', async () => {
    const b = backend({ ok: true, payload: { show: true } })
    const toast = vi.fn()
    expect(await showPortableRemovalNotice(b.backend, toast, t)).toBe(true)
    expect(b.send).toHaveBeenCalledWith('cli_profiles.portable_removal_notice', {})
    expect(toast).toHaveBeenCalledWith('t:settings.accounts.cli.portable-removed-text', {
      type: 'info',
      duration: 0,
      title: 't:settings.accounts.cli.portable-removed-title',
    })
  })

  it.each([
    ['nothing to say', { ok: true, payload: { show: false } }],
    ['an error reply', { ok: false, payload: null }],
    ['a failed request', new Error('closed')],
  ] as const)('shows nothing on %s', async (_label, reply) => {
    const toast = vi.fn()
    expect(await showPortableRemovalNotice(backend(reply).backend, toast, t)).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })
})
