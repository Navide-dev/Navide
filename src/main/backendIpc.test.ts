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
import { answerWindowChallenge, backendChangedTargets, backendInfoFor } from './backendIpc'

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

describe('backend:info scope (R3-M2)', () => {
  beforeEach(() => fromWebContents.mockReset())

  const FULL = {
    status: 'ready' as const,
    host: '127.0.0.1',
    port: 1,
    pid: 2,
    shell: '/bin/zsh',
    httpUrl: 'http://127.0.0.1:1',
    wsUrl: 'ws://127.0.0.1:1/ws?t=secret',
  }

  it('gives every Navide window main created the full payload', () => {
    const mainSender = {}
    const auxSender = {}
    const main = windowWith(mainSender, 1)
    const aux = windowWith(auxSender, 2)
    const groups = [new Set([main]), new Set([aux])] as never
    fromWebContents.mockReturnValue(main)
    expect(backendInfoFor({ sender: mainSender, senderFrame: { parent: null } } as never, groups, FULL)).toEqual(FULL)
    fromWebContents.mockReturnValue(aux)
    expect(backendInfoFor({ sender: auxSender, senderFrame: { parent: null } } as never, groups, FULL)).toEqual(FULL)
  })

  it('gives anything else only the status', () => {
    const sender = {}
    const main = windowWith(sender)
    const groups = [new Set([main])] as never
    fromWebContents.mockReturnValue(main)
    // Plugin iframe in a Navide window.
    expect(backendInfoFor({ sender, senderFrame: { parent: {} } } as never, groups, FULL)).toEqual({ status: 'ready' })
    // Webview / plugin view owned by it.
    expect(backendInfoFor({ sender: {}, senderFrame: { parent: null } } as never, groups, FULL)).toEqual({ status: 'ready' })
    // A window main did not register as a Navide window (a plugin host window).
    const stranger = {}
    fromWebContents.mockReturnValue(windowWith(stranger, 9))
    expect(backendInfoFor({ sender: stranger, senderFrame: { parent: null } } as never, groups, FULL)).toEqual({ status: 'ready' })
    fromWebContents.mockReturnValue(null)
    expect(backendInfoFor({ sender: {}, senderFrame: { parent: null } } as never, groups, FULL)).toEqual({ status: 'ready' })
  })
})

describe('backend:changed recipients', () => {
  it('pushes only to Navide windows main created; other windows get nothing', () => {
    const main = windowWith({}, 1)
    const detached = windowWith({}, 2)
    const plans = windowWith({}, 3)
    const pluginHost = windowWith({}, 4)
    const pdf = windowWith({}, 5)
    const groups = [new Set([main, detached]), new Set([plans])] as never
    expect(backendChangedTargets([main, pluginHost, detached, plans, pdf] as never, groups)).toEqual([main, detached, plans])
  })

  it('is what broadcastBackendChanged iterates', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    const body = source.slice(source.indexOf('function broadcastBackendChanged'))
    const loop = body.slice(0, body.indexOf('\n}\n'))
    expect(loop).toContain('backendChangedTargets(BrowserWindow.getAllWindows(), [mainWindows, navideAuxWindows])')
    expect(loop).not.toMatch(/for \(const win of BrowserWindow\.getAllWindows\(\)\)/)
  })
})

describe('backend:restart', () => {
  it('answers through backendInfoFor, like backend:info', () => {
    // The restart answer is the same payload as backend:info, wsUrl and all;
    // a plugin frame or any other window must get only the status from it too.
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    const start = source.indexOf("ipcMain.handle('backend:restart'")
    expect(start).toBeGreaterThan(-1)
    const handler = source.slice(start, source.indexOf('\n)', start) + 2)
    expect(handler).toContain('backendInfoFor(event, [mainWindows, navideAuxWindows], await restartBackendNow())')
  })
})

