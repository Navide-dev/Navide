import { WebContentsView, ipcMain, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { validTerminalOwnerRequest, type TerminalStorageOwnerRequest, type TerminalStorageOwnerState } from '../shared/terminalStorageOwner'

export type TerminalOwnerOrigin = 'legacy-mini-ide' | 'host'
export type TerminalOwnerEntry = { filePath: string } | { url: string }

/** Preserve the exact existing entry; only query parameters differ. No
 * partition override means the original Electron default session is used. */
export function terminalOwnerLocation(entry: TerminalOwnerEntry): TerminalOwnerEntry {
  if ('filePath' in entry) return entry
  const url = new URL(entry.url)
  url.searchParams.set('terminal_owner', '1')
  return { url: url.href }
}

interface Owner {
  view: WebContentsView
  ready: Promise<void>
  resolveReady(): void
  rejectReady(error: Error): void
}
interface Pending {
  senderId: number
  resolve(value: TerminalStorageOwnerState | null): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** A storage-only renderer at the original owner's origin. It owns no PTY,
 * IDE UI, Plugin runtime or backend credentials and remains available when
 * user-facing Host/legacy windows close. */
export class TerminalStorageOwnerService {
  private readonly owners = new Map<TerminalOwnerOrigin, Owner>()
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: {
    preloadPath: string
    entry(origin: TerminalOwnerOrigin): TerminalOwnerEntry
  }) {
    ipcMain.on('terminal-owner:ready', this.onReady)
    ipcMain.on('terminal-owner:response', this.onResponse)
  }

  private readonly onReady = (event: IpcMainEvent): void => {
    const owner = [...this.owners.values()].find(item => item.view.webContents?.id === event.sender.id)
    if (owner && event.senderFrame === event.sender.mainFrame) owner.resolveReady()
  }

  private readonly onResponse = (event: IpcMainEvent, response: unknown): void => {
    if (!response || typeof response !== 'object') return
    const value = response as { id?: unknown; ok?: unknown; value?: TerminalStorageOwnerState | null }
    const pending = typeof value.id === 'string' ? this.pending.get(value.id) : undefined
    if (!pending || pending.senderId !== event.sender.id || event.senderFrame !== event.sender.mainFrame) return
    this.pending.delete(value.id as string)
    clearTimeout(pending.timer)
    if (value.ok === true) pending.resolve(value.value ?? null)
    else pending.reject(new Error('Terminal owner storage operation failed'))
  }

  private getOwner(origin: TerminalOwnerOrigin): Owner {
    const existing = this.owners.get(origin)
    if (existing && existing.view.webContents && !existing.view.webContents.isDestroyed()) return existing
    // An unattached WebContentsView does not keep a user BrowserWindow open
    // or change the application's window-all-closed behavior.
    const view = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const owner = { view, ready, resolveReady, rejectReady }
    const senderId = view.webContents.id
    const startupTimer = setTimeout(() => rejectReady(new Error('Terminal storage owner did not become ready')), 10_000)
    void ready.then(() => clearTimeout(startupTimer), () => {
      clearTimeout(startupTimer)
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close()
    })
    this.owners.set(origin, owner)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.once('destroyed', () => {
      if (this.owners.get(origin) === owner) this.owners.delete(origin)
      const error = new Error('Terminal storage owner closed')
      rejectReady(error)
      for (const [id, pending] of this.pending) {
        if (pending.senderId !== senderId) continue
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error)
      }
    })
    const entry = terminalOwnerLocation(this.options.entry(origin))
    const load = 'filePath' in entry
      ? view.webContents.loadFile(entry.filePath, { query: { terminal_owner: '1' } })
      : view.webContents.loadURL(entry.url)
    void load.catch(error => rejectReady(error instanceof Error ? error : new Error('Terminal owner could not load')))
    return owner
  }

  async execute(origin: TerminalOwnerOrigin, request: TerminalStorageOwnerRequest, canDispatch = (): boolean => true): Promise<TerminalStorageOwnerState | null> {
    if (!validTerminalOwnerRequest(request)) throw new Error('Invalid terminal owner request')
    if (!canDispatch()) throw new Error('Terminal owner request denied')
    const owner = this.getOwner(origin)
    await owner.ready
    if (!canDispatch()) throw new Error('Terminal owner request denied')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Terminal owner storage request timed out'))
      }, 10_000)
      this.pending.set(id, { senderId: owner.view.webContents.id, resolve, reject, timer })
      try { owner.view.webContents.send('terminal-owner:request', id, request) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  dispose(): void {
    for (const owner of this.owners.values()) owner.view.webContents?.close()
    this.owners.clear()
    ipcMain.removeListener('terminal-owner:ready', this.onReady)
    ipcMain.removeListener('terminal-owner:response', this.onResponse)
  }
}
