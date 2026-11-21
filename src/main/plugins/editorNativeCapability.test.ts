import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  EditorNativeCapability,
  editorOpenParamsForAbsolutePath,
  type EditorNativeExecution,
  type EditorNativeHost,
} from './editorNativeCapability'
import { EditorSelectionGrants } from './editorSelectionGrants'

const temporaryRoots: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}

function makeContext(workspacePath: string, canDispatch: () => boolean = () => true): EditorNativeExecution {
  return {
    instanceId: 'instance-a',
    workspaceId: 'workspace-a',
    packageVersion: '1.0.0',
    workspacePath,
    canDispatch,
  }
}

type MockHost = { [K in keyof EditorNativeHost]: ReturnType<typeof vi.fn> }

function makeHost(): MockHost {
  return {
    pickFile: vi.fn(async () => null),
    pickWorkspace: vi.fn(async () => null),
    revealPath: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
    openTempFile: vi.fn(async () => {}),
    listEditors: vi.fn(async () => []),
    openFolderInEditor: vi.fn(async () => {}),
    openEditorWindow: vi.fn(async () => {}),
    openMainWindow: vi.fn(async () => {}),
    openBranchDiffWindow: vi.fn(async () => {}),
    openGitWindow: vi.fn(async () => {}),
    openGitHistoryWindow: vi.fn(async () => {}),
    readKeybindings: vi.fn(async () => ({ ok: true, content: '' })),
    writeKeybindings: vi.fn(async () => ({ ok: true })),
    setUiScale: vi.fn(() => 1),
  } as MockHost
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('EditorNativeCapability dispatch boundary', () => {
  it('denies native operations before invoking picker or open callbacks', async () => {
    const workspace = temporaryDirectory('navide-native-denied-')
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace, () => false)

    await expect(capability.execute('ui.pickFile', {}, context)).rejects.toThrow('editor native operation denied')
    await expect(capability.execute('ui.openPath', { path: 'inside.txt' }, context)).rejects.toThrow('editor native operation denied')
    expect(host.pickFile).not.toHaveBeenCalled()
    expect(host.openPath).not.toHaveBeenCalled()
  })

  it('does not mint a grant when dispatch is revoked after the picker returns', async () => {
    const workspace = temporaryDirectory('navide-native-late-denied-')
    const selectedPath = join(workspace, 'selected.txt')
    writeFileSync(selectedPath, 'selected')
    let dispatchAllowed = true
    const host = makeHost()
    host.pickFile.mockImplementation(async () => {
      dispatchAllowed = false
      return selectedPath
    })
    const selections = new EditorSelectionGrants()
    const capability = new EditorNativeCapability(selections, host as unknown as EditorNativeHost)

    await expect(capability.execute('ui.pickFile', {}, makeContext(workspace, () => dispatchAllowed))).rejects.toThrow(
      'editor native operation denied',
    )
    expect(host.pickFile).toHaveBeenCalledTimes(1)
    expect((selections as unknown as { selections: Map<unknown, unknown> }).selections.size).toBe(0)
  })

  it.each([
    ['instance', { instanceId: 'instance-b' }],
    ['workspace', { workspaceId: 'workspace-b' }],
    ['package version', { packageVersion: '2.0.0' }],
  ] as const)('rejects a selected file grant from another %s', async (_label, identity) => {
    const workspace = temporaryDirectory('navide-native-owner-')
    const selectedPath = join(workspace, 'selected.txt')
    writeFileSync(selectedPath, 'selected')
    const host = makeHost()
    host.pickFile.mockResolvedValue(selectedPath)
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const selected = await capability.execute('ui.pickFile', {}, makeContext(workspace)) as { grant: string }
    const otherContext = { ...makeContext(workspace), ...identity }

    await expect(capability.execute('ui.openPath', { path: 'selected.txt', grant: selected.grant }, otherContext)).rejects.toThrow(
      'selected resource is not owned by this instance',
    )
    expect(host.openPath).not.toHaveBeenCalled()
  })

  it('allows a grant to open only its exact selected file', async () => {
    const workspace = temporaryDirectory('navide-native-file-grant-')
    const selectedPath = join(workspace, 'selected.txt')
    writeFileSync(selectedPath, 'selected')
    writeFileSync(join(workspace, 'sibling.txt'), 'sibling')
    const host = makeHost()
    host.pickFile.mockResolvedValue(selectedPath)
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)
    const selected = await capability.execute('ui.pickFile', {}, context) as { grant: string }

    await expect(capability.execute('ui.openPath', { path: 'sibling.txt', grant: selected.grant }, context)).rejects.toThrow(
      'selected file path mismatch',
    )
    await capability.execute('ui.openPath', { path: basename(selectedPath), grant: selected.grant }, context)
    expect(host.openPath).toHaveBeenCalledWith(realpathSync(selectedPath))
  })

  it('forwards canonical workspace and selected external file targets', async () => {
    const workspace = temporaryDirectory('navide-native-editor-target-')
    const outside = temporaryDirectory('navide-native-editor-outside-')
    const insidePath = join(workspace, 'inside.txt')
    const outsidePath = join(outside, 'outside.txt')
    writeFileSync(insidePath, 'inside')
    writeFileSync(outsidePath, 'outside')
    const host = makeHost()
    host.pickFile.mockResolvedValue(outsidePath)
    const selections = new EditorSelectionGrants()
    const capability = new EditorNativeCapability(selections, host as unknown as EditorNativeHost)
    const context = makeContext(workspace)

    await capability.execute('ui.openEditorWindow', { path: 'inside.txt' }, context)
    expect(host.openEditorWindow).toHaveBeenCalledWith({ workspace_path: workspace, filepath: 'inside.txt', line: undefined })

    const selected = await capability.execute('ui.pickFile', {}, context) as { path: string; grant: string }
    await capability.execute('ui.openEditorWindow', { path: 'outside.txt', grant: selected.grant }, context)
    expect(host.openEditorWindow).toHaveBeenLastCalledWith({
      workspace_path: workspace,
      filepath: 'outside.txt',
      file_ws: realpathSync(outside),
      line: undefined,
    })
    expect(host.openEditorWindow.mock.calls.at(-1)?.[0]).not.toMatchObject({ grant: selected.grant, instanceId: context.instanceId })
  })

  it('rejects arbitrary identity and query fields before any Host callback', async () => {
    const workspace = temporaryDirectory('navide-native-query-')
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)

    await expect(capability.execute('ui.openEditorWindow', {
      path: 'inside.txt', workspaceId: 'forged', instanceId: 'forged', query: 'x',
    }, makeContext(workspace))).rejects.toThrow('invalid editor native operation')
    expect(host.openEditorWindow).not.toHaveBeenCalled()
  })

  it('rejects a selected grant after its symlink target is retargeted', async () => {
    const workspace = temporaryDirectory('navide-native-symlink-')
    const first = join(workspace, 'first.txt')
    const second = join(workspace, 'second.txt')
    const link = join(workspace, 'selected.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    symlinkSync(first, link)
    const host = makeHost()
    host.pickFile.mockResolvedValue(link)
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)
    const selected = await capability.execute('ui.pickFile', {}, context) as { grant: string }

    unlinkSync(link)
    symlinkSync(second, link)
    await capability.execute('ui.openPath', { path: 'first.txt', grant: selected.grant }, context)
    expect(host.openPath).toHaveBeenCalledWith(realpathSync(first))
    host.openPath.mockClear()
    await expect(capability.execute('ui.openPath', { path: 'second.txt', grant: selected.grant }, context)).rejects.toThrow(
      'selected file path mismatch',
    )
    expect(host.openPath).not.toHaveBeenCalled()

    unlinkSync(first)
    symlinkSync(second, first)
    await expect(capability.execute('ui.openPath', { path: 'first.txt', grant: selected.grant }, context)).rejects.toThrow(
      'selected resource is not owned by this instance',
    )
    expect(host.openPath).not.toHaveBeenCalled()
  })

  it('rejects native opens outside the current workspace before the Host callback', async () => {
    const workspace = temporaryDirectory('navide-native-escape-')
    const outside = temporaryDirectory('navide-native-outside-')
    const outsidePath = join(outside, 'outside.txt')
    writeFileSync(outsidePath, 'outside')
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)

    await expect(capability.execute('ui.openPath', { path: outsidePath }, makeContext(workspace))).rejects.toThrow(
      'path is outside the Host workspace binding',
    )
    expect(host.openPath).not.toHaveBeenCalled()
  })
})

describe('EditorNativeCapability legitimate authority', () => {
  it('uses the current workspace and Host picker grants for legitimate native operations', async () => {
    const workspace = temporaryDirectory('navide-native-legitimate-')
    const selectedWorkspace = temporaryDirectory('navide-native-picked-workspace-')
    const insidePath = join(workspace, 'inside.txt')
    const pickedPath = join(selectedWorkspace, 'picked.txt')
    writeFileSync(insidePath, 'inside')
    writeFileSync(pickedPath, 'picked')
    const host = makeHost()
    host.pickFile.mockResolvedValue(pickedPath)
    host.pickWorkspace.mockResolvedValue(selectedWorkspace)
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)

    await capability.execute('ui.openPath', { path: 'inside.txt' }, context)
    expect(host.openPath).toHaveBeenCalledWith(realpathSync(insidePath))
    await capability.execute('ui.openEditorWindow', {}, context)
    expect(host.openEditorWindow).toHaveBeenCalledWith({ workspace_path: workspace, sidebar: undefined })

    const pickedFile = await capability.execute('ui.pickFile', {}, context) as { path: string; grant: string }
    expect(pickedFile.path).toBe(realpathSync(pickedPath))
    await capability.execute('ui.openPath', { path: basename(pickedPath), grant: pickedFile.grant }, context)
    expect(host.openPath).toHaveBeenLastCalledWith(realpathSync(pickedPath))

    const pickedDirectory = await capability.execute('ui.pickWorkspace', {}, context) as { path: string; grant: string }
    expect(pickedDirectory.path).toBe(realpathSync(selectedWorkspace))
    await capability.execute('ui.openMainWindow', { grant: pickedDirectory.grant }, context)
    expect(host.openMainWindow).toHaveBeenCalledWith(realpathSync(selectedWorkspace))
  })

  it('forwards nested repository windows with canonical roots and relative Git files', async () => {
    const workspace = temporaryDirectory('navide-native-nested-repository-')
    const repository = join(workspace, 'packages', 'nested-repository')
    mkdirSync(join(repository, 'src'), { recursive: true })
    writeFileSync(join(repository, 'src', 'main.ts'), 'export {}')
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)

    await capability.execute('ui.openBranchDiffWindow', { repositoryPath: 'packages/nested-repository', base: 'main' }, context)
    await capability.execute('ui.openGitWindow', {
      repositoryPath: 'packages/nested-repository', path: 'src/main.ts', name: 'main.ts',
    }, context)
    await capability.execute('ui.openGitHistoryWindow', { repositoryPath: 'packages/nested-repository' }, context)

    const root = realpathSync(repository)
    expect(host.openBranchDiffWindow).toHaveBeenCalledWith(root, 'main')
    expect(host.openGitWindow).toHaveBeenCalledWith({
      workspace_path: root, filepath: 'src/main.ts', name: 'main.ts',
      staged: undefined, commit: undefined, base: undefined, compare: undefined,
    })
    expect(host.openGitHistoryWindow).toHaveBeenCalledWith(root)
  })

  it('rejects foreign and symlink-escaping repository targets before Host callbacks', async () => {
    const workspace = temporaryDirectory('navide-native-repository-boundary-')
    const outside = temporaryDirectory('navide-native-repository-outside-')
    const repository = join(workspace, 'nested')
    mkdirSync(repository, { recursive: true })
    writeFileSync(join(repository, 'inside.ts'), 'export {}')
    writeFileSync(join(outside, 'outside.ts'), 'export {}')
    symlinkSync(outside, join(workspace, 'linked-outside'))
    symlinkSync(outside, join(repository, 'linked-outside'))
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)

    await expect(capability.execute('ui.openGitWindow', {
      repositoryPath: outside, path: 'outside.ts',
    }, context)).rejects.toThrow('repository is outside the Host workspace binding')
    await expect(capability.execute('ui.openGitHistoryWindow', {
      repositoryPath: 'linked-outside',
    }, context)).rejects.toThrow('repository is outside the Host workspace binding')
    await expect(capability.execute('ui.openGitWindow', {
      repositoryPath: 'nested', path: 'linked-outside/outside.ts',
    }, context)).rejects.toThrow('Git file is outside the repository')
    await expect(capability.execute('ui.openMainWindow', { path: outside }, context)).rejects.toThrow(
      'workspace is outside the Host selection',
    )
    expect(host.openGitWindow).not.toHaveBeenCalled()
    expect(host.openGitHistoryWindow).not.toHaveBeenCalled()
    expect(host.openMainWindow).not.toHaveBeenCalled()
  })

  it('accepts a selected directory only for its exact runtime owner', async () => {
    const workspace = temporaryDirectory('navide-native-directory-owner-')
    const selectedDirectory = temporaryDirectory('navide-native-selected-directory-')
    const host = makeHost()
    host.pickWorkspace.mockResolvedValue(selectedDirectory)
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)
    const selected = await capability.execute('ui.pickWorkspace', {}, context) as { path: string; grant: string }

    await capability.execute('ui.openMainWindow', { grant: selected.grant }, context)
    expect(host.openMainWindow).toHaveBeenCalledWith(realpathSync(selectedDirectory))
    host.openMainWindow.mockClear()
    await expect(capability.execute('ui.openMainWindow', { grant: selected.grant }, {
      ...context, instanceId: 'foreign-instance',
    })).rejects.toThrow('selected resource is not owned by this instance')
    expect(host.openMainWindow).not.toHaveBeenCalled()
  })

  it('keeps current-workspace defaults when repository roots are omitted', async () => {
    const workspace = temporaryDirectory('navide-native-default-repository-')
    writeFileSync(join(workspace, 'inside.ts'), 'export {}')
    const host = makeHost()
    const capability = new EditorNativeCapability(new EditorSelectionGrants(), host as unknown as EditorNativeHost)
    const context = makeContext(workspace)

    await capability.execute('ui.openMainWindow', {}, context)
    await capability.execute('ui.openBranchDiffWindow', { base: 'main' }, context)
    await capability.execute('ui.openGitWindow', { path: 'inside.ts' }, context)
    await capability.execute('ui.openGitHistoryWindow', {}, context)

    const root = realpathSync(workspace)
    expect(host.openMainWindow).toHaveBeenCalledWith(root)
    expect(host.openBranchDiffWindow).toHaveBeenCalledWith(root, 'main')
    expect(host.openGitWindow).toHaveBeenCalledWith({
      workspace_path: root, filepath: 'inside.ts', name: undefined,
      staged: undefined, commit: undefined, base: undefined, compare: undefined,
    })
    expect(host.openGitHistoryWindow).toHaveBeenCalledWith(root)
  })
})

// window:openEditor (a terminal link, an "Open in editor" menu) can carry an
// absolute `filepath`. Passed through as is, the editor read it relative to the
// workspace, asked for <workspace>/Users/..., and stopped on "not a file".
describe('editor-open params with an absolute file path', () => {
  it('names a workspace file relative to the workspace', () => {
    const workspace = temporaryDirectory('navide-editor-abs-inside-')
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'a.txt'), 'a')
    expect(editorOpenParamsForAbsolutePath({
      workspace_path: workspace, filepath: join(workspace, 'src', 'a.txt'), line: '3',
    })).toEqual({ workspace_path: workspace, filepath: join('src', 'a.txt'), line: '3' })
  })

  it('names a file outside the workspace under its own folder', () => {
    const workspace = temporaryDirectory('navide-editor-abs-ws-')
    const outside = temporaryDirectory('navide-editor-abs-outside-')
    writeFileSync(join(outside, 'b.txt'), 'b')
    expect(editorOpenParamsForAbsolutePath({ workspace_path: workspace, filepath: join(outside, 'b.txt') }))
      .toEqual({ workspace_path: workspace, filepath: 'b.txt', file_ws: outside })
  })

  it('leaves relative paths and paths that already name their root alone', () => {
    const relativeOpen = { workspace_path: '/ws', filepath: 'src/a.txt' }
    expect(editorOpenParamsForAbsolutePath(relativeOpen)).toBe(relativeOpen)
    const rooted = { workspace_path: '/ws', filepath: 'b.txt', file_ws: '/elsewhere' }
    expect(editorOpenParamsForAbsolutePath(rooted)).toBe(rooted)
  })

  it('is applied to window:openEditor before the request is routed', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf("ipcMain.handle('window:openEditor'")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 1))
    expect(body).toMatch(/const params = editorOpenParamsForAbsolutePath\(args \?\? \{\}\)/)
  })
})
