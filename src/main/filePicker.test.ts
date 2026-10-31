import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FilePickerInvocation } from './filePicker'

type Listener = (...args: unknown[]) => void

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let nextWebContentsId = 100

  class FakeWebContents {
    static instances: FakeWebContents[] = []
    readonly id = nextWebContentsId++
    readonly mainFrame = { parent: null }
    readonly listeners = new Map<string, Set<Listener>>()
    readonly loadCalls: Array<{ method: 'loadFile' | 'loadURL'; value: string; options?: unknown }> = []
    readonly sendCalls: Array<{ channel: string; args: unknown[] }> = []
    windowOpenHandler: (() => unknown) | undefined
    destroyed = false
    focused = false

    constructor() {
      FakeWebContents.instances.push(this)
    }

    on(event: string, listener: Listener): this {
      const eventListeners = this.listeners.get(event) ?? new Set<Listener>()
      eventListeners.add(listener)
      this.listeners.set(event, eventListeners)
      return this
    }

    once(event: string, listener: Listener): this {
      const once = (...args: unknown[]) => {
        this.listeners.get(event)?.delete(once)
        listener(...args)
      }
      return this.on(event, once)
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }

    loadFile(value: string, options?: unknown): Promise<void> {
      this.loadCalls.push({ method: 'loadFile', value, options })
      return Promise.resolve()
    }

    loadURL(value: string, options?: unknown): Promise<void> {
      this.loadCalls.push({ method: 'loadURL', value, options })
      return Promise.resolve()
    }

    send(channel: string, ...args: unknown[]): void {
      this.sendCalls.push({ channel, args })
    }

    focus(): void {
      this.focused = true
    }

    setWindowOpenHandler(handler: () => unknown): void {
      this.windowOpenHandler = handler
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class FakeContentView {
    readonly children: FakeWebContentsView[] = []

    addChildView(view: FakeWebContentsView): void {
      this.children.push(view)
    }

    removeChildView(view: FakeWebContentsView): void {
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    readonly contentView = new FakeContentView()
    readonly listeners = new Map<string, Set<Listener>>()
    destroyed = false

    constructor() {
      FakeBrowserWindow.instances.push(this)
    }

    on(event: string, listener: Listener): this {
      const eventListeners = this.listeners.get(event) ?? new Set<Listener>()
      eventListeners.add(listener)
      this.listeners.set(event, eventListeners)
      return this
    }

    once(event: string, listener: Listener): this {
      const once = (...args: unknown[]) => {
        this.listeners.get(event)?.delete(once)
        listener(...args)
      }
      return this.on(event, once)
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    readonly webContents = new FakeWebContents()
    readonly options: unknown
    backgroundColor: string | undefined
    bounds: unknown

    constructor(options: unknown) {
      this.options = options
      FakeWebContentsView.instances.push(this)
    }

    setBackgroundColor(color: string): void {
      this.backgroundColor = color
    }

    setBounds(bounds: unknown): void {
      this.bounds = bounds
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    ipcMain: {
      on(channel: string, listener: Listener): void {
        const channelListeners = listeners.get(channel) ?? new Set<Listener>()
        channelListeners.add(listener)
        listeners.set(channel, channelListeners)
      },
      off(channel: string, listener: Listener): void {
        listeners.get(channel)?.delete(listener)
      },
      removeListener(channel: string, listener: Listener): void {
        listeners.get(channel)?.delete(listener)
      },
      handle(channel: string, handler: (...args: unknown[]) => unknown): void {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string): void {
        handlers.delete(channel)
      },
      emit(channel: string, ...args: unknown[]): void {
        for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args)
      },
      invoke(channel: string, ...args: unknown[]): Promise<unknown> {
        return Promise.resolve(handlers.get(channel)?.(...args))
      },
    },
    reset(): void {
      listeners.clear()
      handlers.clear()
      FakeWebContents.instances.length = 0
      FakeWebContentsView.instances.length = 0
      FakeBrowserWindow.instances.length = 0
      nextWebContentsId = 100
    },
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args)
    },
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      return Promise.resolve(handlers.get(channel)?.(...args))
    },
    FakeWebContents,
    FakeWebContentsView,
    FakeBrowserWindow,
  }
})

vi.mock('electron', () => electron)

import { FilePickerHostService } from './filePicker'

const temporaryRoots: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

function readyEvent(sender: InstanceType<typeof electron.FakeWebContents>, frame: unknown = sender.mainFrame): object {
  return { sender, senderFrame: frame }
}

function makeInvocation(workspacePath: string, overrides: Partial<FilePickerInvocation> = {}): FilePickerInvocation {
  const sender = new electron.FakeWebContents() as unknown as FilePickerInvocation['sender']
  const hostWindow = new electron.FakeBrowserWindow() as unknown as FilePickerInvocation['hostWindow']
  return {
    instanceId: 'plugin-instance',
    sender,
    hostWindow,
    workspacePath,
    sourceBounds: () => ({ x: 4, y: 5, width: 120, height: 24 }),
    request: { query: 'needle', candidates: ['inside.txt'], line: 9 },
    canDispatch: () => true,
    search: vi.fn(async () => []),
    ...overrides,
  }
}

type OpenSelected = (target: {
  workspacePath: string
  canonicalPath: string
  line?: number
  canDispatch(): boolean
}) => Promise<boolean>

type OpenPreview = (target: {
  workspacePath: string
  canonicalPath: string
  canDispatch(): boolean
}) => Promise<boolean>

function service(openSelected: OpenSelected, openPreview?: OpenPreview): FilePickerHostService {
  return new FilePickerHostService({
    preloadPath: '/app/file-picker-preload.js',
    entry: { filePath: '/app/renderer/index.html' },
    openSelected,
    ...(openPreview ? { openPreview } : {}),
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function invocationId(view: InstanceType<typeof electron.FakeWebContentsView>): string {
  const init = view.webContents.sendCalls[0]?.args[0]
  if (!init || typeof init !== 'object' || typeof (init as { invocationId?: unknown }).invocationId !== 'string') {
    throw new Error('file-picker init event was not sent')
  }
  return (init as { invocationId: string }).invocationId
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('FilePickerHostService', () => {
  beforeEach(() => {
    electron.reset()
  })

  it('keeps the picker unattached until ready and loads only the file-picker entry', async () => {
    const workspace = temporaryDirectory('navide-file-picker-ready-')
    const invocation = makeInvocation(workspace)
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      const hostWindow = electron.FakeBrowserWindow.instances[0]
      expect(hostWindow.contentView.children).toHaveLength(0)
      expect(view.webContents.loadCalls).toEqual([{
        method: 'loadFile',
        value: '/app/renderer/index.html',
        options: { query: { file_picker: '1' } },
      }])
      expect(view.webContents.loadCalls[0]?.value).not.toMatch(/terminal|ide/i)

      electron.emit('file-picker:ready', readyEvent(view.webContents))
      expect(hostWindow.contentView.children).toEqual([view])
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      expect(hostWindow.contentView.children).toEqual([view])
      expect(view.webContents.sendCalls[0]?.channel).toBe('file-picker:init')
      expect(view.webContents.sendCalls[0]?.args[0]).toMatchObject({
        invocationId: expect.any(String), query: 'needle', theme: 'dark-github',
      })
      expect(view.webContents.focused).toBe(true)
      pickerService.cancelInstance(invocation.instanceId)
      await expect(pending).resolves.toEqual({ opened: false })
    } finally {
      pickerService.dispose()
    }
  })

  it('ignores foreign senders, subframes, forged invocation ids, and forged row ids', async () => {
    const workspace = temporaryDirectory('navide-file-picker-trust-')
    const selected = join(workspace, 'inside.txt')
    writeFileSync(selected, 'inside')
    const invocation = makeInvocation(workspace, {
      request: { query: 'inside', candidates: ['inside.txt'] },
      search: vi.fn(async () => [selected]),
    })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const foreign = new electron.FakeWebContents()

      await expect(electron.invoke('file-picker:search', readyEvent(foreign), id, 'inside')).resolves.toEqual([])
      await expect(electron.invoke('file-picker:search', readyEvent(view.webContents, { parent: {} }), id, 'inside')).resolves.toEqual([])
      await expect(electron.invoke('file-picker:search', readyEvent(view.webContents), 'forged-invocation', 'inside')).resolves.toEqual([])
      electron.emit('file-picker:select', readyEvent(foreign), id, 'forged-row')
      electron.emit('file-picker:select', readyEvent(view.webContents, { parent: {} }), id, 'forged-row')
      electron.emit('file-picker:select', readyEvent(view.webContents), 'forged-invocation', 'forged-row')
      electron.emit('file-picker:select', readyEvent(view.webContents), id, 'forged-row')
      await flush()
      expect(openSelected).not.toHaveBeenCalled()

      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside') as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'label', 'path'])
      expect(rows[0]?.path).toBe(realpathSync.native(selected))
      pickerService.cancelInstance(invocation.instanceId)
      await expect(pending).resolves.toEqual({ opened: false })
    } finally {
      pickerService.dispose()
    }
  })

  it('returns canonical trusted rows and opens only the selected row', async () => {
    const workspace = temporaryDirectory('navide-file-picker-canonical-')
    const directory = join(workspace, 'src')
    mkdirSync(directory)
    const target = join(directory, 'target.ts')
    const link = join(workspace, 'target-link.ts')
    writeFileSync(target, 'target')
    symlinkSync(target, link)
    const invocation = makeInvocation(workspace, {
      request: { query: 'target', candidates: ['target-link.ts'], line: 12 },
    })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'target') as Array<{ id: string; path: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.path).toBe(realpathSync.native(target))

      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: true })
      expect(openSelected).toHaveBeenCalledOnce()
      expect(openSelected).toHaveBeenCalledWith({
        workspacePath: workspace,
        canonicalPath: realpathSync.native(target),
        line: 12,
        canDispatch: expect.any(Function),
      })
    } finally {
      pickerService.dispose()
    }
  })

  it('takes parsed targets as they are, without reading a suffix', async () => {
    const workspace = temporaryDirectory('navide-file-picker-targets-')
    const target = join(workspace, 'odd:7')
    writeFileSync(target, 'target')
    const invocation = makeInvocation(workspace, {
      request: { query: 'odd', candidates: ['ignored.ts'], targets: [{ path: 'odd:7', line: 12 }] },
      search: vi.fn(async () => []),
    })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'odd') as Array<{ id: string; path: string }>
      expect(rows.map(row => row.path)).toEqual([realpathSync.native(target)])
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: true })
      expect(openSelected).toHaveBeenCalledWith(expect.objectContaining({ line: 12 }))
    } finally {
      pickerService.dispose()
    }
  })

  it('still reads the suffix of a string candidate when no targets are sent', async () => {
    const workspace = temporaryDirectory('navide-file-picker-suffix-')
    const target = join(workspace, 'a.ts')
    writeFileSync(target, 'target')
    const invocation = makeInvocation(workspace, {
      request: { query: 'a.ts', candidates: ['a.ts:137-158'] },
      search: vi.fn(async () => []),
    })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'a.ts') as Array<{ id: string; path: string }>
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: true })
      expect(openSelected).toHaveBeenCalledWith(expect.objectContaining({ line: 137 }))
    } finally {
      pickerService.dispose()
    }
  })

  it.each(['html', 'htm'])('previews the first trusted workspace .%s candidate directly', async suffix => {
    const workspace = temporaryDirectory(`navide-file-picker-preview-${suffix}-`)
    const previewPath = join(workspace, `report.${suffix}`)
    writeFileSync(previewPath, '<!doctype html>')
    const invocation = makeInvocation(workspace, {
      request: { query: `report.${suffix}`, candidates: [`report.${suffix}:18`] },
      search: vi.fn(async () => { throw new Error('preview should not search the backend') }),
    })
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async () => true)
    const pickerService = service(openSelected, openPreview)
    try {
      const pending = pickerService.open(invocation)
      await expect(pending).resolves.toEqual({ opened: true })
      expect(openPreview).toHaveBeenCalledWith({
        workspacePath: workspace,
        canonicalPath: realpathSync.native(previewPath),
        canDispatch: expect.any(Function),
      })
      expect(openSelected).not.toHaveBeenCalled()
      expect(electron.FakeWebContentsView.instances[0]?.webContents.loadCalls).toEqual([])
      expect(electron.FakeBrowserWindow.instances[0]?.contentView.children).toHaveLength(0)
    } finally {
      pickerService.dispose()
    }
  })

  it('uses the first valid workspace HTML candidate in request order', async () => {
    const workspace = temporaryDirectory('navide-file-picker-preview-order-')
    const first = join(workspace, 'first.html')
    const second = join(workspace, 'second.htm')
    writeFileSync(first, '<!doctype html>')
    writeFileSync(second, '<!doctype html>')
    const invocation = makeInvocation(workspace, {
      request: { query: 'first', candidates: ['missing.html', 'first.html', 'second.htm'] },
      search: vi.fn(async () => { throw new Error('preview should not search the backend') }),
    })
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async () => true)
    const pickerService = service(openSelected, openPreview)
    try {
      await expect(pickerService.open(invocation)).resolves.toEqual({ opened: true })
      expect(openPreview).toHaveBeenCalledOnce()
      expect(openPreview).toHaveBeenCalledWith({
        workspacePath: workspace,
        canonicalPath: realpathSync.native(first),
        canDispatch: expect.any(Function),
      })
      expect(openSelected).not.toHaveBeenCalled()
      expect(electron.FakeWebContentsView.instances[0]?.webContents.loadCalls).toEqual([])
    } finally {
      pickerService.dispose()
    }
  })

  it('keeps an external HTML candidate in the picker', async () => {
    const workspace = temporaryDirectory('navide-file-picker-preview-external-workspace-')
    const outside = temporaryDirectory('navide-file-picker-preview-external-target-')
    const externalPath = join(outside, 'report.html')
    writeFileSync(externalPath, '<!doctype html>')
    const invocation = makeInvocation(workspace, {
      request: { query: 'report.html', candidates: [externalPath] },
    })
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async () => true)
    const pickerService = service(openSelected, openPreview)
    try {
      const pending = pickerService.open(invocation)
      await flush()
      const view = electron.FakeWebContentsView.instances[0]
      await vi.waitFor(() => expect(view.webContents.loadCalls).toHaveLength(1))
      expect(openPreview).not.toHaveBeenCalled()
      expect(view.webContents.loadCalls).toEqual([{
        method: 'loadFile',
        value: '/app/renderer/index.html',
        options: { query: { file_picker: '1' } },
      }])
      pickerService.cancelInstance(invocation.instanceId)
      await expect(pending).resolves.toEqual({ opened: false })
    } finally {
      pickerService.dispose()
    }
  })

  it('keeps an HTML symlink escaping the workspace in the picker', async () => {
    const workspace = temporaryDirectory('navide-file-picker-preview-symlink-workspace-')
    const outside = temporaryDirectory('navide-file-picker-preview-symlink-target-')
    const externalPath = join(outside, 'report.html')
    const linkPath = join(workspace, 'report.html')
    writeFileSync(externalPath, '<!doctype html>')
    symlinkSync(externalPath, linkPath)
    const invocation = makeInvocation(workspace, {
      request: { query: 'report.html', candidates: ['report.html'] },
    })
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async () => true)
    const pickerService = service(openSelected, openPreview)
    try {
      const pending = pickerService.open(invocation)
      await flush()
      const view = electron.FakeWebContentsView.instances[0]
      await vi.waitFor(() => expect(view.webContents.loadCalls).toHaveLength(1))
      expect(openPreview).not.toHaveBeenCalled()
      expect(view.webContents.loadCalls).toEqual([{
        method: 'loadFile',
        value: '/app/renderer/index.html',
        options: { query: { file_picker: '1' } },
      }])
      pickerService.cancelInstance(invocation.instanceId)
      await expect(pending).resolves.toEqual({ opened: false })
    } finally {
      pickerService.dispose()
    }
  })

  it('stops the preflight when dispatch is revoked during candidate lookup', async () => {
    const workspace = temporaryDirectory('navide-file-picker-preview-lookup-revoked-')
    const previewPath = join(workspace, 'report.html')
    writeFileSync(previewPath, '<!doctype html>')
    const invocation = makeInvocation(workspace, {
      request: { query: 'report.html', candidates: ['report.html'] },
    })
    const sender = invocation.sender as unknown as InstanceType<typeof electron.FakeWebContents>
    let checks = 0
    invocation.canDispatch = () => {
      checks += 1
      if (checks === 3) sender.emit('did-start-navigation')
      return checks < 3
    }
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async () => true)
    const pickerService = service(openSelected, openPreview)
    try {
      await expect(pickerService.open(invocation)).resolves.toEqual({ opened: false })
      expect(openPreview).not.toHaveBeenCalled()
      expect(openSelected).not.toHaveBeenCalled()
      expect(electron.FakeWebContentsView.instances[0]?.webContents.loadCalls).toEqual([])
      expect(electron.FakeWebContentsView.instances[0]?.webContents.isDestroyed()).toBe(true)
    } finally {
      pickerService.dispose()
    }
  })

  it('passes revocation into the awaited preview callback', async () => {
    const workspace = temporaryDirectory('navide-file-picker-preview-callback-revoked-')
    const previewPath = join(workspace, 'report.html')
    writeFileSync(previewPath, '<!doctype html>')
    const invocation = makeInvocation(workspace, {
      request: { query: 'report.html', candidates: ['report.html'] },
    })
    const sender = invocation.sender as unknown as InstanceType<typeof electron.FakeWebContents>
    let callbackGuard: (() => boolean) | undefined
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const openPreview = vi.fn<OpenPreview>(async target => {
      callbackGuard = target.canDispatch
      sender.close()
      return target.canDispatch()
    })
    const pickerService = service(openSelected, openPreview)
    try {
      await expect(pickerService.open(invocation)).resolves.toEqual({ opened: false })
      expect(openPreview).toHaveBeenCalledOnce()
      expect(callbackGuard?.()).toBe(false)
      expect(openSelected).not.toHaveBeenCalled()
      expect(electron.FakeWebContentsView.instances[0]?.webContents.loadCalls).toEqual([])
      expect(electron.FakeWebContentsView.instances[0]?.webContents.isDestroyed()).toBe(true)
    } finally {
      pickerService.dispose()
    }
  })

  it('does not expose stat or grant metadata for an external candidate', async () => {
    const workspace = temporaryDirectory('navide-file-picker-external-workspace-')
    const outside = temporaryDirectory('navide-file-picker-external-target-')
    const externalTarget = join(outside, 'outside.ts')
    writeFileSync(externalTarget, 'outside')
    const invocation = makeInvocation(workspace, {
      request: { query: 'outside', candidates: [] },
      search: vi.fn(async () => [externalTarget]),
    })
    const openSelected = vi.fn<OpenSelected>(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'outside') as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'label', 'path'])
      expect(rows[0]?.path).toBe(realpathSync.native(externalTarget))
      expect(rows[0]).not.toHaveProperty('stat')
      expect(rows[0]).not.toHaveProperty('grant')

      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: true })
      expect(openSelected).toHaveBeenCalledWith({
        workspacePath: workspace,
        canonicalPath: realpathSync.native(externalTarget),
        canDispatch: expect.any(Function),
      })
      expect(openSelected.mock.calls[0]?.[0]).not.toHaveProperty('stat')
      expect(openSelected.mock.calls[0]?.[0]).not.toHaveProperty('grant')
    } finally {
      pickerService.dispose()
    }
  })

  it('passes a live dispatch guard into the awaited open callback', async () => {
    const workspace = temporaryDirectory('navide-file-picker-routing-')
    const selected = join(workspace, 'inside.txt')
    writeFileSync(selected, 'inside')
    let allowed = true
    let callbackGuard: (() => boolean) | undefined
    const invocation = makeInvocation(workspace, {
      request: { query: 'inside', candidates: ['inside.txt'] },
      canDispatch: () => allowed,
    })
    const openSelected = vi.fn(async (target: { canDispatch(): boolean }) => {
      callbackGuard = target.canDispatch
      allowed = false
      return target.canDispatch()
    })
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside') as Array<{ id: string }>
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: false })
      expect(openSelected).toHaveBeenCalledOnce()
      expect(callbackGuard?.()).toBe(false)
    } finally {
      pickerService.dispose()
    }
  })

  it('denies before creation and after ready without searching or selecting', async () => {
    const workspace = temporaryDirectory('navide-file-picker-denied-')
    let allowed = false
    const search = vi.fn(async () => [join(workspace, 'inside.txt')])
    const invocation = makeInvocation(workspace, { canDispatch: () => allowed, search })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      await expect(pickerService.open(invocation)).resolves.toEqual({ opened: false })
      expect(electron.FakeWebContentsView.instances).toHaveLength(0)

      allowed = true
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      allowed = false
      await expect(electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside')).resolves.toEqual([])
      electron.emit('file-picker:select', readyEvent(view.webContents), id, 'row')
      await flush()
      expect(search).not.toHaveBeenCalled()
      expect(openSelected).not.toHaveBeenCalled()
      await expect(pending).resolves.toEqual({ opened: false })
    } finally {
      pickerService.dispose()
    }
  })

  it('rejects a row whose symlink target changes before selection', async () => {
    const workspace = temporaryDirectory('navide-file-picker-symlink-')
    const first = join(workspace, 'first.txt')
    const second = join(workspace, 'second.txt')
    const link = join(workspace, 'selected.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    symlinkSync(first, link)
    const invocation = makeInvocation(workspace, { request: { query: 'selected', candidates: ['selected.txt'] } })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'selected') as Array<{ id: string }>
      unlinkSync(link)
      symlinkSync(second, link)
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await expect(pending).resolves.toEqual({ opened: false })
      expect(openSelected).not.toHaveBeenCalled()
    } finally {
      pickerService.dispose()
    }
  })

  it('processes duplicate selection events only once', async () => {
    const workspace = temporaryDirectory('navide-file-picker-duplicate-')
    const selected = join(workspace, 'inside.txt')
    writeFileSync(selected, 'inside')
    const invocation = makeInvocation(workspace, { request: { query: 'inside', candidates: ['inside.txt'] } })
    let resolveOpen: ((opened: boolean) => void) | undefined
    const openSelected = vi.fn(() => new Promise<boolean>(resolve => { resolveOpen = resolve }))
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      const rows = await electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside') as Array<{ id: string }>
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      electron.emit('file-picker:select', readyEvent(view.webContents), id, rows[0]?.id)
      await vi.waitFor(() => expect(openSelected).toHaveBeenCalledOnce())
      expect(openSelected).toHaveBeenCalledOnce()
      resolveOpen?.(true)
      await expect(pending).resolves.toEqual({ opened: true })
    } finally {
      pickerService.dispose()
    }
  })

  it.each([
    ['sender navigation', (invocation: FilePickerInvocation) => {
      ;(invocation.sender as unknown as InstanceType<typeof electron.FakeWebContents>).emit('did-start-navigation')
    }],
    ['sender destruction', (invocation: FilePickerInvocation) => {
      ;(invocation.sender as unknown as InstanceType<typeof electron.FakeWebContents>).close()
    }],
    ['host window destruction', (invocation: FilePickerInvocation) => {
      ;(invocation.hostWindow as unknown as InstanceType<typeof electron.FakeBrowserWindow>).close()
    }],
  ] as const)('closes on %s and ignores stale events', async (_name, trigger) => {
    const workspace = temporaryDirectory('navide-file-picker-lifecycle-')
    const selected = join(workspace, 'inside.txt')
    writeFileSync(selected, 'inside')
    const invocation = makeInvocation(workspace, { request: { query: 'inside', candidates: ['inside.txt'] } })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      trigger(invocation)
      await expect(pending).resolves.toEqual({ opened: false })
      await expect(electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside')).resolves.toEqual([])
      electron.emit('file-picker:select', readyEvent(view.webContents), id, 'stale-row')
      expect(openSelected).not.toHaveBeenCalled()
    } finally {
      pickerService.dispose()
    }
  })

  it('cancels a session and ignores subsequent stale events', async () => {
    const workspace = temporaryDirectory('navide-file-picker-session-')
    const invocation = makeInvocation(workspace, {
      sessionId: 'session-a',
      request: { query: 'inside', candidates: [] },
    })
    const openSelected = vi.fn(async () => true)
    const pickerService = service(openSelected)
    try {
      const pending = pickerService.open(invocation)
      const view = electron.FakeWebContentsView.instances[0]
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      const id = invocationId(view)
      pickerService.cancelSession(invocation.instanceId, 'other-session')
      expect(view.webContents.isDestroyed()).toBe(false)
      pickerService.cancelSession(invocation.instanceId, 'session-a')
      await expect(pending).resolves.toEqual({ opened: false })
      electron.emit('file-picker:ready', readyEvent(view.webContents))
      await expect(electron.invoke('file-picker:search', readyEvent(view.webContents), id, 'inside')).resolves.toEqual([])
      expect(openSelected).not.toHaveBeenCalled()
    } finally {
      pickerService.dispose()
    }
  })
})
