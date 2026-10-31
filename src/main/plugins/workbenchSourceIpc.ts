// The main window's reach to WorkbenchSourceStore. Accepting is the user's act:
// only the trusted main window can call this, and no MCP tool reaches it.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { WorkbenchSourceStore } from './workbenchSourceStore'
import type { ProjectWorkbenchResult, ProjectWorkbenchSnapshot } from '../../shared/projectWorkbench'

const NO_WORKSPACE: ProjectWorkbenchSnapshot = {
  status: 'none', fingerprint: null, recommendation: null, active: null, shouldNotify: false,
}

function fingerprintOf(args: unknown): string {
  const value = typeof args === 'object' && args !== null ? (args as { fingerprint?: unknown }).fingerprint : undefined
  return typeof value === 'string' ? value : ''
}

export function registerWorkbenchSourceIpc(
  store: WorkbenchSourceStore,
  isAuthorized: (event: IpcMainInvokeEvent) => boolean,
  resolveWorkspace: (event: IpcMainInvokeEvent) => string | undefined,
): void {
  const withWorkspace = (
    event: IpcMainInvokeEvent,
    run: (workspace: string) => ProjectWorkbenchResult,
  ): ProjectWorkbenchResult => {
    if (!isAuthorized(event)) throw new Error('untrusted sender')
    const workspace = resolveWorkspace(event)
    return workspace ? run(workspace) : { ok: false, reason: 'unavailable', snapshot: NO_WORKSPACE }
  }

  ipcMain.handle('workbench-project:inspect', (event): ProjectWorkbenchSnapshot => {
    if (!isAuthorized(event)) throw new Error('untrusted sender')
    const workspace = resolveWorkspace(event)
    return workspace ? store.inspect(workspace) : NO_WORKSPACE
  })
  ipcMain.handle('workbench-project:accept', (event, args: unknown) =>
    withWorkspace(event, (workspace) => store.accept(workspace, fingerprintOf(args))))
  ipcMain.handle('workbench-project:revoke', (event) =>
    withWorkspace(event, (workspace) => store.revoke(workspace)))
  ipcMain.handle('workbench-project:mark-notified', (event, args: unknown) =>
    withWorkspace(event, (workspace) => store.markNotified(workspace, fingerprintOf(args))))
}
