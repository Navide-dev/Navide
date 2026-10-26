import { describe, expect, it, vi } from 'vitest'
import { refreshTrustThenUpdates, publishRescanNotices } from './pluginUpdateReminder'

const update = {
  id: 'acme.demo',
  namespace: 'acme',
  name: 'demo',
  installedVersion: '1.0.0',
  latestVersion: '1.1.0',
}

describe('refreshTrustThenUpdates', () => {
  it('checks updates only after the trust refresh settled and publishes the result', async () => {
    const order: string[] = []
    const publish = vi.fn(() => order.push('publish'))
    await refreshTrustThenUpdates({
      refreshTrust: async () => {
        order.push('trust')
      },
      checkUpdates: async () => {
        order.push('check')
        return [update]
      },
      publish,
      warn: vi.fn(),
    })
    expect(order).toEqual(['trust', 'check', 'publish'])
    expect(publish).toHaveBeenCalledWith([update])
  })

  it('contains a failed update check: no throw, no publish, trust refresh already done', async () => {
    const refreshTrust = vi.fn(async () => {})
    const publish = vi.fn()
    const warn = vi.fn()
    await expect(
      refreshTrustThenUpdates({
        refreshTrust,
        checkUpdates: async () => {
          throw new Error('registry offline')
        },
        publish,
        warn,
      })
    ).resolves.toBeUndefined()
    expect(refreshTrust).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry offline'))
  })

  it('still checks updates when the trust refresh fails, and keeps the trust error', async () => {
    const checkUpdates = vi.fn(async () => [])
    await expect(
      refreshTrustThenUpdates({
        refreshTrust: async () => {
          throw new Error('trust failed')
        },
        checkUpdates,
        publish: vi.fn(),
        warn: vi.fn(),
      })
    ).rejects.toThrow('trust failed')
    expect(checkUpdates).toHaveBeenCalledOnce()
  })
})

// Review L1 on #371: a rescan notice is cleared only once it reached a window.
describe('publishRescanNotices', () => {
  const notice = { id: 'acme.demo', version: '1.0.0', added: [{ kind: 'shell', key: 'git push' }] }

  it('sends the notices to every open window and keeps nothing', () => {
    const restore = vi.fn()
    const sent: unknown[] = []
    publishRescanNotices({ take: () => [notice], restore, send: (notices) => { sent.push(notices); return 2 } })
    expect(sent).toEqual([[notice]])
    expect(restore).not.toHaveBeenCalled()
  })

  it('puts the notices back when no window received them', () => {
    const restore = vi.fn()
    publishRescanNotices({ take: () => [notice], restore, send: () => 0 })
    expect(restore).toHaveBeenCalledWith([notice])
  })

  it('does nothing when there is nothing to send', () => {
    const send = vi.fn(() => 1)
    const restore = vi.fn()
    publishRescanNotices({ take: () => [], restore, send })
    expect(send).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
})
