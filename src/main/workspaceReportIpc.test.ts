import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const { fromWebContents } = vi.hoisted(() => ({ fromWebContents: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

import { mayReportWorkspace } from './workspaceReportIpc'

type ReportEvent = Parameters<typeof mayReportWorkspace>[0]

const sender = {}
const hostWindow = { id: 1, webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
const main = new Set([hostWindow])
const event = (senderFrame: unknown, from: object = sender) => ({ sender: from, senderFrame }) as unknown as ReportEvent

describe('who may report a workspace', () => {
  beforeEach(() => {
    fromWebContents.mockReset()
    fromWebContents.mockReturnValue(hostWindow)
  })

  it('accepts the top frame of a registered main window', () => {
    expect(mayReportWorkspace(event({ parent: null }), main)).toBe(true)
  })

  it('refuses a subframe', () => {
    expect(mayReportWorkspace(event({ parent: {} }), main)).toBe(false)
  })

  it('refuses when the frame is gone', () => {
    expect(mayReportWorkspace(event(null), main)).toBe(false)
  })

  it('refuses a view inside the window', () => {
    expect(mayReportWorkspace(event({ parent: null }, {}), main)).toBe(false)
  })

  it('refuses a window that is not a main window', () => {
    expect(mayReportWorkspace(event({ parent: null }), new Set())).toBe(false)
  })
})

// index.ts cannot be imported in a unit test (it boots Electron), so the wiring
// is read from source, as gitAccountsIpcSender.test.ts does.
describe('window:reportWorkspace', () => {
  it('checks the sender before it touches anything', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf("ipcMain.on('window:reportWorkspace'")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n})', start))
    const check = body.indexOf('if (!mayReportWorkspace(event, mainWindows)) return')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('mainWindowWorkspaces.'))
    expect(check).toBeLessThan(body.indexOf('windowRegistry.'))
  })
})
