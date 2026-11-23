import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { EditorNativeResults } from '../../../packages/plugin-contracts/src/index'
import { EditorSelectionGrants, type EditorSelectionOwner } from './editorSelectionGrants'
import { isWorkspaceContainedPath, resolvePathForContainment } from './workspacePathPolicy'

/** How the editor window names one absolute file: relative to the workspace
 *  when the file is inside it, otherwise by name under its own folder
 *  (`file_ws`). The editor reads `filepath` relative to one of those roots, so
 *  an absolute `filepath` resolves to a path that does not exist. */
export function editorWindowFileTarget(workspacePath: string, path: string): { filepath: string; file_ws?: string } {
  if (isWorkspaceContainedPath(workspacePath, path)) {
    const root = resolvePathForContainment(workspacePath)
    const resolved = resolvePathForContainment(path)
    if (!root || !resolved) throw new Error('workspace cannot be safely resolved')
    return { filepath: relative(root, resolved) }
  }
  return { filepath: basename(path), file_ws: dirname(path) }
}

/** Editor-open params whose `filepath` is absolute (a terminal link, a drop),
 *  rewritten into the form `editorWindowFileTarget` gives. Anything else —
 *  a relative path, or one that already names its root with `file_ws` — is
 *  returned as is. */
export function editorOpenParamsForAbsolutePath(params: Record<string, string>): Record<string, string> {
  const { workspace_path: workspacePath, filepath, file_ws: fileWs } = params
  if (!workspacePath || !filepath || fileWs || !isAbsolute(filepath)) return params
  return { ...params, ...editorWindowFileTarget(workspacePath, filepath) }
}

const fields = {
  'ui.openPluginWindow': { contributionKey: 'string', path: 'string?', line: 'number?', grant: 'string?' },
  'ui.pickFile': { title: 'string?' },
  'ui.pickWorkspace': { defaultPath: 'string?' },
  'ui.resolvePath': { path: 'string', grant: 'string?' },
  'ui.revealPath': { path: 'string', grant: 'string?' },
  'ui.openPath': { path: 'string', grant: 'string?' },
  'ui.openTempFile': { name: 'string', content: 'string' },
  'ui.listEditors': { refresh: 'boolean?' },
  'ui.openFolderInEditor': { path: 'string', editorId: 'string?', grant: 'string?' },
  'ui.openEditorWindow': { path: 'string?', line: 'number?', sidebar: 'string?', grant: 'string?' },
  'ui.openMainWindow': { path: 'string?', grant: 'string?' },
  'ui.openBranchDiffWindow': { base: 'string', repositoryPath: 'string?' },
  'ui.openGitWindow': { path: 'string?', name: 'string?', staged: 'boolean?', commit: 'string?', base: 'string?', compare: 'string?', repositoryPath: 'string?' },
  'ui.openGitHistoryWindow': { repositoryPath: 'string?' },
  'ui.readKeybindings': {},
  'ui.writeKeybindings': { content: 'string' },
  'ui.setUiScale': { scale: 'number' },
} as const

export const EDITOR_NATIVE_METHODS = Object.keys(fields) as Array<keyof typeof fields>

export function validateEditorNativeRequest(address: string, value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(address in fields)) return false
  const args = value as Record<string, unknown>
  const schema = fields[address as keyof typeof fields] as Record<string, string>
  return Object.keys(args).every(key => Object.hasOwn(schema, key)) &&
    Object.entries(schema).every(([key, type]) =>
      (args[key] === undefined && type.endsWith('?')) ||
      (typeof args[key] === type.replace('?', '') && (typeof args[key] !== 'number' || Number.isFinite(args[key])))) &&
    (args.line === undefined || (Number.isInteger(args.line) && Number(args.line) >= 1)) &&
    (address !== 'ui.openPluginWindow' ||
      (typeof args.contributionKey === 'string' && args.contributionKey.length > 0 &&
        (args.path !== undefined || (args.grant === undefined && args.line === undefined))))
}

export interface EditorNativeHost {
  openPluginWindow(args: {
    contributionKey: string
    workspacePath: string
    filePath?: string
    line?: number
  }): Promise<EditorNativeResults['ui.openPluginWindow']>
  pickFile(title?: string): Promise<string | null>
  pickWorkspace(defaultPath?: string): Promise<string | null>
  revealPath(path: string): void | Promise<void>
  openPath(path: string): void | Promise<void>
  openTempFile(name: string, content: string): void | Promise<void>
  listEditors(refresh?: boolean): Promise<EditorNativeResults['ui.listEditors']>
  openFolderInEditor(path: string, editorId?: string): void | Promise<void>
  openEditorWindow(args: { workspace_path: string; filepath?: string; file_ws?: string; line?: number; sidebar?: string }): void | Promise<void>
  openMainWindow(workspacePath: string): void | Promise<void>
  openBranchDiffWindow(workspacePath: string, base: string): void | Promise<void>
  openGitWindow(args: { workspace_path: string; filepath?: string; name?: string; staged?: boolean; commit?: string; base?: string; compare?: string }): void | Promise<void>
  openGitHistoryWindow(workspacePath: string): void | Promise<void>
  readKeybindings(): Promise<EditorNativeResults['ui.readKeybindings']>
  writeKeybindings(content: string): Promise<EditorNativeResults['ui.writeKeybindings']>
  setUiScale(scale: number): number
}

export interface EditorNativeExecution extends EditorSelectionOwner {
  workspacePath: string
  canDispatch(): boolean
}

export class EditorNativeCapability {
  constructor(readonly selections: EditorSelectionGrants, private readonly host: EditorNativeHost) {}

  async execute(address: string, args: Record<string, unknown>, context: EditorNativeExecution): Promise<unknown> {
    if (!validateEditorNativeRequest(address, args)) throw new Error('invalid editor native operation')
    const requireDispatch = (): void => { if (!context.canDispatch()) throw new Error('editor native operation denied') }
    const performed = async (action: void | Promise<void>): Promise<{ ok: boolean }> => {
      await action
      return { ok: true }
    }
    requireDispatch()
    if (address === 'ui.pickFile' || address === 'ui.pickWorkspace') {
      const path = address === 'ui.pickFile'
        ? await this.host.pickFile(args.title as string | undefined)
        : await this.host.pickWorkspace(args.defaultPath as string | undefined)
      requireDispatch()
      return path ? this.selections.mint(context, path, address === 'ui.pickFile' ? 'file' : 'directory') : null
    }
    const workspace = (): string => args.grant
      ? this.selections.resolve(context, args.grant, 'directory')
      : context.workspacePath
    const repository = (): string => {
      const path = String(args.repositoryPath ?? '.')
      if (!isWorkspaceContainedPath(context.workspacePath, path)) throw new Error('repository is outside the Host workspace binding')
      const root = resolvePathForContainment(resolve(context.workspacePath, path))
      if (!root) throw new Error('repository cannot be safely resolved')
      return root
    }
    const target = (): string => {
      if (args.grant) {
        const path = this.selections.resolve(context, args.grant, 'file')
        if (resolve(dirname(path), String(args.path)) !== path) throw new Error('selected file path mismatch')
        return path
      }
      const path = String(args.path ?? '.')
      if (!isWorkspaceContainedPath(context.workspacePath, path)) throw new Error('path is outside the Host workspace binding')
      const resolved = resolvePathForContainment(resolve(context.workspacePath, path))
      if (!resolved) throw new Error('path cannot be safely resolved')
      return resolved
    }
    switch (address) {
      case 'ui.openPluginWindow': {
        const filePath = args.path === undefined ? undefined : target()
        requireDispatch()
        return this.host.openPluginWindow({
          contributionKey: String(args.contributionKey),
          workspacePath: context.workspacePath,
          ...(filePath === undefined ? {} : { filePath }),
          ...(args.line === undefined ? {} : { line: Number(args.line) }),
        })
      }
      case 'ui.resolvePath': return target()
      case 'ui.revealPath': return performed(this.host.revealPath(target()))
      case 'ui.openPath': return performed(this.host.openPath(target()))
      case 'ui.openTempFile': return performed(this.host.openTempFile(String(args.name), String(args.content)))
      case 'ui.listEditors': return (await this.host.listEditors(args.refresh as boolean | undefined))
        .map(({ id, label, available }) => ({ id, label, available }))
      case 'ui.openFolderInEditor': {
        const root = workspace()
        if (!isWorkspaceContainedPath(root, String(args.path))) throw new Error('folder is outside the Host selection')
        return performed(this.host.openFolderInEditor(resolve(root, String(args.path)), args.editorId as string | undefined))
      }
      case 'ui.openEditorWindow': {
        if (args.path !== undefined) {
          return performed(this.host.openEditorWindow({ workspace_path: context.workspacePath,
            ...editorWindowFileTarget(context.workspacePath, target()), line: args.line as number | undefined }))
        }
        return performed(this.host.openEditorWindow({ workspace_path: workspace(), sidebar: args.sidebar as string | undefined }))
      }
      case 'ui.openMainWindow': {
        const root = workspace()
        if (!isWorkspaceContainedPath(root, String(args.path ?? '.'))) throw new Error('workspace is outside the Host selection')
        const path = resolvePathForContainment(resolve(root, String(args.path ?? '.')))
        if (!path) throw new Error('workspace cannot be safely resolved')
        return performed(this.host.openMainWindow(path))
      }
      case 'ui.openBranchDiffWindow': return performed(this.host.openBranchDiffWindow(repository(), String(args.base)))
      case 'ui.openGitWindow': {
        const root = repository()
        if (args.path !== undefined && !isWorkspaceContainedPath(root, String(args.path))) throw new Error('Git file is outside the repository')
        return performed(this.host.openGitWindow({ workspace_path: root, filepath: args.path as string | undefined,
          name: args.name as string | undefined,
          staged: args.staged as boolean | undefined, commit: args.commit as string | undefined,
          base: args.base as string | undefined, compare: args.compare as string | undefined }))
      }
      case 'ui.openGitHistoryWindow': return performed(this.host.openGitHistoryWindow(repository()))
      case 'ui.readKeybindings': return this.host.readKeybindings()
      case 'ui.writeKeybindings': return this.host.writeKeybindings(String(args.content))
      case 'ui.setUiScale': return this.host.setUiScale(Number(args.scale))
    }
    throw new Error('unknown editor native operation')
  }
}
