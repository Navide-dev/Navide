import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { fromWebContents } = vi.hoisted(() => ({ fromWebContents: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/fake' },
  BrowserWindow: { fromWebContents },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

import { proveWindow } from './backend'
import { answerWindowChallenge } from './backendIpc'

type FakeWindow = { id: number; webContents: object; isDestroyed: () => boolean }

const NONCE = 'ab'.repeat(32)

function windowWith(sender: object, id = 1): FakeWindow {
  return { id, webContents: sender, isDestroyed: () => false }
}

describe('backend:proveWindow (R3-M2)', () => {
  beforeEach(() => fromWebContents.mockReset())

  it('signs the challenge for a top-level main window', () => {
    const sender = {}
    const main = windowWith(sender)
    fromWebContents.mockReturnValue(main)
    expect(
      answerWindowChallenge({ sender, senderFrame: { parent: null } } as never, NONCE, new Set([main]) as never, 'host')
    ).toBe(proveWindow('host', NONCE))
  })

  it('refuses every sender that is not a main window', () => {
    const sender = {}
    const main = windowWith(sender)
    const mains = new Set([main]) as never
    // A plugin iframe inside a main window.
    fromWebContents.mockReturnValue(main)
    expect(answerWindowChallenge({ sender, senderFrame: { parent: {} } } as never, NONCE, mains, 'host')).toBeNull()
    // A webview / WebContentsView: owned by the window but not its webContents.
    expect(answerWindowChallenge({ sender: {}, senderFrame: { parent: null } } as never, NONCE, mains, 'host')).toBeNull()
    // A Navide window that is not a main window (Plans, Token Monitor).
    const aux = {}
    fromWebContents.mockReturnValue(windowWith(aux, 2))
    expect(answerWindowChallenge({ sender: aux, senderFrame: { parent: null } } as never, NONCE, mains, 'host')).toBeNull()
    // No window at all.
    fromWebContents.mockReturnValue(null)
    expect(answerWindowChallenge({ sender: {}, senderFrame: { parent: null } } as never, NONCE, mains, 'host')).toBeNull()
  })

  it('refuses without a backend or with something that is not a challenge', () => {
    const sender = {}
    const main = windowWith(sender)
    fromWebContents.mockReturnValue(main)
    const event = { sender, senderFrame: { parent: null } } as never
    expect(answerWindowChallenge(event, NONCE, new Set([main]) as never, null)).toBeNull()
    for (const bad of ['', 'nonce-1', 'AB'.repeat(32), 7, null]) {
      expect(answerWindowChallenge(event, bad, new Set([main]) as never, 'host')).toBeNull()
    }
  })

  it('the plugin broker socket never proves', () => {
    // The broker connects with the same URL; only useBackend answers ws.welcome.
    const source = readFileSync(resolve(__dirname, 'plugins/frontendPluginManager.ts'), 'utf8')
    expect(source).not.toMatch(/ws\.welcome|window\.prove|proveWindow/)
  })
})
