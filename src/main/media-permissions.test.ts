import { describe, expect, it } from 'vitest'
import type { Session, WebContents } from 'electron'
import { decideMediaPermission, decidePermission, installMediaPermissionHandlers } from './media-permissions'

describe('media permission decisions', () => {
  it('keeps every non-media permission on Electron’s default (allow)', () => {
    for (const p of ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'openExternal', 'pointerLock']) {
      expect(decidePermission(p, () => ({ mediaTypes: ['video'], fromMainRenderer: false }))).toBe(true)
    }
  })

  it('allows audio for the main renderer only', () => {
    expect(decideMediaPermission({ mediaTypes: ['audio'], fromMainRenderer: true })).toBe(true)
    expect(decideMediaPermission({ mediaTypes: ['audio'], fromMainRenderer: false })).toBe(false)
  })

  it('denies video, even to the main renderer', () => {
    expect(decideMediaPermission({ mediaTypes: ['video'], fromMainRenderer: true })).toBe(false)
    expect(decideMediaPermission({ mediaTypes: ['audio', 'video'], fromMainRenderer: true })).toBe(false)
  })

  it('display-capture (Electron 45+ screen capture) keeps the old media rule: main renderer only', () => {
    expect(decidePermission('display-capture', () => ({ mediaTypes: [], fromMainRenderer: true }))).toBe(true)
    expect(decidePermission('display-capture', () => ({ mediaTypes: [], fromMainRenderer: false }))).toBe(false)
  })
})

describe('installMediaPermissionHandlers', () => {
  function install(mainId: number) {
    let request: ((...a: unknown[]) => void) | null = null
    let check: ((...a: unknown[]) => boolean) | null = null
    const ses = {
      setPermissionRequestHandler: (h: typeof request) => { request = h },
      setPermissionCheckHandler: (h: typeof check) => { check = h },
    } as unknown as Session
    installMediaPermissionHandlers(ses, (wc) => wc?.id === mainId)
    const ask = (wcId: number | null, permission: string, details: Record<string, unknown>): boolean => {
      let answer: boolean | undefined
      request!(wcId === null ? null : ({ id: wcId } as WebContents), permission, (ok: boolean) => { answer = ok }, details)
      return answer!
    }
    const probe = (wcId: number | null, permission: string, details: Record<string, unknown>): boolean =>
      check!(wcId === null ? null : ({ id: wcId } as WebContents), permission, 'file://', details)
    return { ask, probe }
  }

  it('request handler: mic for the main window, nothing for a plugin view', () => {
    const { ask } = install(1)
    expect(ask(1, 'media', { mediaTypes: ['audio'] })).toBe(true)
    expect(ask(7, 'media', { mediaTypes: ['audio'] })).toBe(false)
    expect(ask(1, 'media', { mediaTypes: ['video'] })).toBe(false)
    expect(ask(7, 'notifications', {})).toBe(true)
    expect(ask(1, 'display-capture', {})).toBe(true)
    expect(ask(7, 'display-capture', {})).toBe(false)
  })

  it('check handler: same rule, other permissions untouched', () => {
    const { probe } = install(1)
    expect(probe(1, 'media', { mediaType: 'audio' })).toBe(true)
    expect(probe(1, 'media', { mediaType: 'video' })).toBe(false)
    expect(probe(null, 'media', { mediaType: 'audio' })).toBe(false)
    expect(probe(null, 'clipboard-read', {})).toBe(true)
    expect(probe(null, 'display-capture', {})).toBe(false)
  })
})
