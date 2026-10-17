// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createNoticeCoalescer, NOTICE_COALESCE_MS } from '../../lib/noticeCoalescer'
import { usePluginRescanNotices } from '../usePluginRescanNotices'

describe('createNoticeCoalescer (D5: same notice merged within an hour)', () => {
  it('shows a key once per hour and again after', () => {
    const coalescer = createNoticeCoalescer()
    expect(coalescer.shouldShow('a', 0)).toBe(true)
    expect(coalescer.shouldShow('a', NOTICE_COALESCE_MS - 1)).toBe(false)
    expect(coalescer.shouldShow('b', 1)).toBe(true)
    expect(coalescer.shouldShow('a', NOTICE_COALESCE_MS)).toBe(true)
  })
})

describe('usePluginRescanNotices', () => {
  let saved: typeof i18n.global.locale.value
  let handler: ((notices: PluginRescanNotice[]) => void) | null = null
  beforeEach(() => {
    saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        onRescanNotices: vi.fn((h: (notices: PluginRescanNotice[]) => void) => {
          handler = h
          return () => { handler = null }
        }),
      },
    }
  })
  afterEach(() => {
    i18n.global.locale.value = saved
    delete (window as unknown as Record<string, unknown>).agentTeam
    for (const toast of useNotify().toasts.value) useNotify().dismissToast(toast.id)
  })

  it('notes a rescan that found new items, without interrupting, once within the hour', () => {
    const stop = usePluginRescanNotices(() => 0)
    const notice = { id: 'acme.demo', version: '1.0.0', added: [{ kind: 'shell', key: 'git push' }, { kind: 'host', key: 'x' }] }
    handler!([notice])
    handler!([notice])
    const messages = useNotify().toasts.value.map((toast) => toast.message)
    expect(messages.filter((message) => message.includes('acme.demo'))).toEqual([
      'A Navide Registry rescan of acme.demo 1.0.0 found 2 new items (not yet verified). See Settings → Navide Plugins → Disclosure overview.',
    ])
    expect(useNotify().dialog.value).toBeNull()
    stop()
    expect(handler).toBeNull()
  })

  it('does nothing on a Host without the channel', () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: {} }
    expect(() => usePluginRescanNotices()()).not.toThrow()
  })
})
