import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { FilePickerRequest, FilePickerTarget } from '../../packages/plugin-contracts/src/filePicker'
import { splitFilePickerCandidate } from '../../packages/plugin-contracts/src/filePicker'
import type { HostFilePickerRow } from '../shared/filePicker'

export interface FilePickerInvocation {
  instanceId: string
  sessionId?: string
  sender: WebContents
  hostWindow: BrowserWindow
  workspacePath: string
  sourceBounds(): { x: number; y: number; width: number; height: number }
  request: FilePickerRequest
  canDispatch(): boolean
  search(query: string): Promise<string[]>
  theme?: string
}

export interface FilePickerHost {
  open(invocation: FilePickerInvocation): Promise<{ opened: boolean }>
  cancelInstance(instanceId: string): void
  cancelSession(instanceId: string, sessionId: string): void
}

interface Picker {
  id: string
  view: WebContentsView
  invocation: FilePickerInvocation
  rows: Map<string, { originalPath: string; canonicalPath: string; line?: number }>
  generation: number
  selecting: boolean
  attached: boolean
  finish(opened: boolean): void
}

/** What the caller wants opened: its own parsed `targets`, or else the
 * `candidates` strings as this Host has always read them. */
function requestedTargets(request: FilePickerRequest): FilePickerTarget[] {
  return request.targets ?? request.candidates.map(splitFilePickerCandidate)
}

/** A picker-only trusted renderer. Candidates are never filesystem authority;
 * only a row selected through its isolated channel can reach openSelected. */
export class FilePickerHostService implements FilePickerHost {
  private readonly pickers = new Map<string, Picker>()

  constructor(private readonly options: {
    preloadPath: string
    entry: { filePath: string } | { url: string }
    openSelected(target: { workspacePath: string; canonicalPath: string; line?: number; canDispatch(): boolean }): Promise<boolean>
    openPreview?(target: { workspacePath: string; canonicalPath: string; canDispatch(): boolean }): Promise<boolean>
  }) {
    ipcMain.on('file-picker:ready', this.onReady)
    ipcMain.handle('file-picker:search', this.onSearch)
    ipcMain.on('file-picker:select', this.onSelect)
    ipcMain.on('file-picker:cancel', this.onCancel)
  }

  private live(picker: Picker): boolean {
    return this.pickers.get(picker.id) === picker && !picker.invocation.sender.isDestroyed() &&
      !picker.invocation.hostWindow.isDestroyed() && picker.invocation.canDispatch()
  }

  private fromEvent(event: IpcMainEvent | IpcMainInvokeEvent, id?: unknown): Picker | undefined {
    if (event.senderFrame !== event.sender.mainFrame) return undefined
    const picker = [...this.pickers.values()].find(item => item.view.webContents.id === event.sender.id)
    if (!picker || (id !== undefined && picker.id !== id)) return undefined
    if (!this.live(picker)) { picker.finish(false); return undefined }
    return picker
  }

  private readonly onReady = (event: IpcMainEvent): void => {
    const picker = this.fromEvent(event)
    if (!picker) return
    if (!picker.attached) {
      picker.invocation.hostWindow.contentView.addChildView(picker.view)
      picker.attached = true
    }
    picker.view.webContents.send('file-picker:init', {
      invocationId: picker.id,
      query: picker.invocation.request.query,
      theme: picker.invocation.theme ?? 'dark-github',
      homePath: homedir(),
    })
    picker.view.webContents.focus()
  }

  private async resolveCandidate(workspacePath: string, candidate: string): Promise<{ originalPath: string; canonicalPath: string } | null> {
    if (!candidate || candidate.includes('\0')) return null
    const expanded = candidate.startsWith('~/') ? resolve(homedir(), candidate.slice(2)) : candidate
    const originalPath = resolve(workspacePath, expanded)
    try {
      const canonicalPath = await realpath(originalPath)
      return (await stat(canonicalPath)).isFile() ? { originalPath, canonicalPath } : null
    } catch { return null }
  }

  private readonly onSearch = async (event: IpcMainInvokeEvent, id: unknown, query: unknown): Promise<HostFilePickerRow[]> => {
    if (typeof id !== 'string') return []
    const picker = this.fromEvent(event, id)
    if (!picker || typeof query !== 'string' || picker.selecting) return []
    const generation = ++picker.generation
    const invocation = picker.invocation
    let found: string[] = []
    try { found = await invocation.search(query) } catch { /* Keep a valid clicked candidate, as the existing picker does. */ }
    if (!this.live(picker) || generation !== picker.generation) return []
    const preferred = query === invocation.request.query
      ? (await Promise.all(requestedTargets(invocation.request).map(async candidate => {
          const target = await this.resolveCandidate(invocation.workspacePath, candidate.path)
          return target ? { ...target, line: candidate.line ?? invocation.request.line } : null
        }))).find(target => target !== null)
      : undefined
    const resolved = [preferred, ...await Promise.all(found.map(path => this.resolveCandidate(invocation.workspacePath, path)))]
    if (!this.live(picker) || generation !== picker.generation) return []
    picker.rows.clear()
    const seen = new Set<string>()
    const rows: HostFilePickerRow[] = []
    for (const target of resolved) {
      if (!target || seen.has(target.canonicalPath)) continue
      seen.add(target.canonicalPath)
      const rowId = randomUUID()
      picker.rows.set(rowId, target)
      const rel = relative(invocation.workspacePath, target.canonicalPath)
      const label = rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel : target.canonicalPath
      rows.push({ id: rowId, label, path: target.canonicalPath })
    }
    return rows
  }

  private readonly onSelect = (event: IpcMainEvent, id: unknown, rowId: unknown): void => {
    if (typeof id !== 'string') return
    const picker = this.fromEvent(event, id)
    if (!picker || picker.selecting || typeof rowId !== 'string') return
    const target = picker.rows.get(rowId)
    if (!target) return
    picker.selecting = true
    void (async () => {
      const current = await this.resolveCandidate(picker.invocation.workspacePath, target.originalPath)
      if (!current || current.canonicalPath !== target.canonicalPath || !this.live(picker)) return false
      return this.options.openSelected({
        workspacePath: picker.invocation.workspacePath,
        canonicalPath: current.canonicalPath,
        canDispatch: () => this.live(picker),
        ...((target.line ?? picker.invocation.request.line) !== undefined ? { line: target.line ?? picker.invocation.request.line } : {}),
      })
    })().then(opened => picker.finish(opened), () => picker.finish(false))
  }

  private readonly onCancel = (event: IpcMainEvent, id: unknown): void => {
    if (typeof id === 'string') this.fromEvent(event, id)?.finish(false)
  }

  open(invocation: FilePickerInvocation): Promise<{ opened: boolean }> {
    if (!invocation.canDispatch() || invocation.sender.isDestroyed() || invocation.hostWindow.isDestroyed()) return Promise.resolve({ opened: false })
    this.cancelInstance(invocation.instanceId)
    const view = new WebContentsView({ webPreferences: {
      preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true,
    } })
    view.setBackgroundColor('#00000000')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return new Promise(resolveResult => {
      const close = (): void => picker.finish(false)
      const resize = (): void => {
        if (!this.live(picker)) { close(); return }
        const bounds = invocation.sourceBounds()
        view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) })
      }
      const picker: Picker = {
        id: randomUUID(), view, invocation, rows: new Map(), generation: 0, selecting: false, attached: false,
        finish: opened => {
          if (!this.pickers.delete(picker.id)) return
          invocation.sender.off('destroyed', close)
          invocation.sender.off('did-start-navigation', close)
          invocation.hostWindow.off('closed', close)
          invocation.hostWindow.off('resize', resize)
          if (picker.attached && !invocation.hostWindow.isDestroyed()) invocation.hostWindow.contentView.removeChildView(view)
          if (!view.webContents.isDestroyed()) view.webContents.close()
          if (!opened && !invocation.sender.isDestroyed() && invocation.canDispatch()) invocation.sender.focus()
          resolveResult({ opened })
        },
      }
      this.pickers.set(picker.id, picker)
      invocation.sender.once('destroyed', close)
      invocation.sender.on('did-start-navigation', close)
      invocation.hostWindow.once('closed', close)
      invocation.hostWindow.on('resize', resize)
      view.webContents.on('will-navigate', event => { event.preventDefault(); close() })
      view.webContents.once('destroyed', close)
      view.webContents.once('render-process-gone', close)
      resize()
      if (!this.live(picker)) return
      void (async () => {
        if (this.options.openPreview) {
          // The original terminal directly previews a clicked workspace HTML
          // report. External candidates still require the trusted row picker.
          for (const candidate of requestedTargets(invocation.request)) {
            const target = await this.resolveCandidate(invocation.workspacePath, candidate.path)
            if (!this.live(picker)) { close(); return }
            if (!target) continue
            const root = await realpath(invocation.workspacePath)
            const path = relative(root, target.canonicalPath)
            if (/\.html?$/i.test(target.canonicalPath) && path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
              if (!this.live(picker)) { close(); return }
              const opened = await this.options.openPreview({
                workspacePath: invocation.workspacePath,
                canonicalPath: target.canonicalPath,
                canDispatch: () => this.live(picker),
              })
              picker.finish(opened)
              return
            }
            break
          }
        }
        if (!this.live(picker)) { close(); return }
        const entry = this.options.entry
        const url = 'url' in entry ? new URL(entry.url) : null
        url?.searchParams.set('file_picker', '1')
        await (url ? view.webContents.loadURL(url.href) : view.webContents.loadFile((entry as { filePath: string }).filePath, { query: { file_picker: '1' } }))
      })().catch(close)
    })
  }

  cancelInstance(instanceId: string): void {
    for (const picker of this.pickers.values()) if (picker.invocation.instanceId === instanceId) picker.finish(false)
  }

  cancelSession(instanceId: string, sessionId: string): void {
    for (const picker of this.pickers.values()) {
      if (picker.invocation.instanceId === instanceId && picker.invocation.sessionId === sessionId) picker.finish(false)
    }
  }

  dispose(): void {
    for (const picker of this.pickers.values()) picker.finish(false)
    ipcMain.off('file-picker:ready', this.onReady)
    ipcMain.removeHandler('file-picker:search')
    ipcMain.off('file-picker:select', this.onSelect)
    ipcMain.off('file-picker:cancel', this.onCancel)
  }
}
