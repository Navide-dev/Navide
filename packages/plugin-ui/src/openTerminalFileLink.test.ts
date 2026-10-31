import { describe, expect, it, vi } from 'vitest'
import { openTerminalFileLink } from './terminalLinkInteraction'

const request = { query: 'a.ts', candidates: ['src/a.ts:3'], line: 3 }

describe('openTerminalFileLink', () => {
  it('opens the Host picker unchanged for a plugin that does not resolve links', async () => {
    const openFilePicker = vi.fn(async () => undefined)
    await openTerminalFileLink({ openFilePicker }, request)
    expect(openFilePicker).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('stops at a plugin that handled the link', async () => {
    const openFilePicker = vi.fn(async () => undefined)
    const resolveFileLink = vi.fn(async () => true)
    await openTerminalFileLink({ openFilePicker, resolveFileLink }, request)
    expect(resolveFileLink).toHaveBeenCalledExactlyOnceWith(request)
    expect(openFilePicker).not.toHaveBeenCalled()
  })

  it('falls back to the Host picker when the plugin cannot tell', async () => {
    const openFilePicker = vi.fn(async () => undefined)
    await openTerminalFileLink({ openFilePicker, resolveFileLink: async () => false }, request)
    expect(openFilePicker).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('surfaces a resolver failure to the caller', async () => {
    const openFilePicker = vi.fn(async () => undefined)
    await expect(openTerminalFileLink({
      openFilePicker,
      resolveFileLink: async () => { throw new Error('backend gone') },
    }, request)).rejects.toThrow('backend gone')
    expect(openFilePicker).not.toHaveBeenCalled()
  })
})
