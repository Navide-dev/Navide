import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { join, resolve } from 'node:path'
import { classifyEditorOpen, resolveExternalOpenTarget } from './editor-fallback'
import { composePluginContributionQuery } from './plugins/pluginContributionQuery'

describe('classifyEditorOpen', () => {
  it('classifies a plain file open', () => {
    expect(classifyEditorOpen({ filepath: 'src/app.ts', line: '12' })).toBe('file')
  })

  it('classifies a diff open even when filepath is absent', () => {
    expect(classifyEditorOpen({ diff_filepath: 'src/app.ts', diff_staged: '1', sidebar: 'git' })).toBe('diff')
  })

  it('classifies a branch-diff open', () => {
    expect(classifyEditorOpen({ branch_diff_base: 'main', branch_diff_compare: 'feature' })).toBe('diff')
  })

  it('diff wins over filepath when both are present', () => {
    expect(classifyEditorOpen({ filepath: 'src/app.ts', diff_filepath: 'src/app.ts' })).toBe('diff')
  })

  it('classifies a bare open (no filepath, e.g. sidebar only)', () => {
    expect(classifyEditorOpen({ sidebar: 'files' })).toBe('bare')
    expect(classifyEditorOpen({})).toBe('bare')
  })

  it('treats an empty filepath as bare', () => {
    expect(classifyEditorOpen({ filepath: '' })).toBe('bare')
  })
})

describe('resolveExternalOpenTarget', () => {
  const workspace = join('/tmp', 'editor-fallback-ws')
  const always = () => true

  it('resolves a workspace-relative path', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/app.ts', always)).toBe(
      resolve(workspace, 'src/app.ts')
    )
  })

  it('returns null when workspace or filepath is empty', () => {
    expect(resolveExternalOpenTarget('', 'src/app.ts', always)).toBeNull()
    expect(resolveExternalOpenTarget(workspace, '', always)).toBeNull()
  })

  it('rejects ../ escapes out of the workspace', () => {
    expect(resolveExternalOpenTarget(workspace, '../outside.txt', always)).toBeNull()
    expect(resolveExternalOpenTarget(workspace, 'src/../../outside.txt', always)).toBeNull()
  })

  it('rejects the workspace root itself', () => {
    expect(resolveExternalOpenTarget(workspace, '.', always)).toBeNull()
  })

  it('allows internal ../ that stays inside the workspace', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/../README.md', always)).toBe(
      resolve(workspace, 'README.md')
    )
  })

  it('returns null when the file does not exist on disk', () => {
    expect(resolveExternalOpenTarget(workspace, 'src/app.ts', () => false)).toBeNull()
  })

  it('uses existsSync by default (missing file on real disk)', () => {
    expect(resolveExternalOpenTarget(workspace, 'definitely-not-there-3f1a.txt')).toBeNull()
  })
})

// An out-of-workspace open arrives as (file_ws, basename): `filepath` is
// relative to `file_ws`, not to the window's workspace. index.ts picks the root
// with `params.file_ws || workspacePath` before calling in here; these tests pin
// what each choice resolves to, so a regression that drops file_ws is visible as
// "opened the wrong file / opened nothing".
describe('resolveExternalOpenTarget – out-of-workspace opens (file_ws as the root)', () => {
  const workspace = join('/tmp', 'editor-fallback-ws')
  const external = join('/tmp', 'editor-fallback-ext')
  const always = () => true

  it('resolves a basename against the file own root (file_ws)', () => {
    expect(resolveExternalOpenTarget(external, 'notes.txt', always)).toBe(
      resolve(external, 'notes.txt')
    )
  })

  it('resolves the same basename to a DIFFERENT file when the workspace is used as root', () => {
    // Exactly the damage of ignoring file_ws: a real path, but the wrong file.
    expect(resolveExternalOpenTarget(workspace, 'notes.txt', always)).not.toBe(
      resolveExternalOpenTarget(external, 'notes.txt', always)
    )
  })

  it('returns null when the workspace copy does not exist (open silently does nothing)', () => {
    // The usual shape of the bug: /ws has no notes.txt, so the fallback finds
    // nothing to hand to the OS and drops to the "unavailable" dialog.
    const exists = (p: string): boolean => p === resolve(external, 'notes.txt')
    expect(resolveExternalOpenTarget(workspace, 'notes.txt', exists)).toBeNull()
    expect(resolveExternalOpenTarget(external, 'notes.txt', exists)).toBe(
      resolve(external, 'notes.txt')
    )
  })

  // `file_ws: '/'` is reachable in production — ⌘O on /notes.txt and a ⌘-click
  // on a filesystem-root path both emit it — and the containment check must not
  // demand a '//' prefix for that root.
  it('resolves against the filesystem root when file_ws is /', () => {
    expect(resolveExternalOpenTarget('/', 'notes.txt', always)).toBe(resolve('/', 'notes.txt'))
  })

  it('applies the same containment rule to an external root', () => {
    expect(resolveExternalOpenTarget(external, '../outside.txt', always)).toBeNull()
    expect(resolveExternalOpenTarget(external, '.', always)).toBeNull()
  })

  it('still classifies an open carrying file_ws as a plain file open', () => {
    // The OS-default-app branch is what handles it; file_ws must not push the
    // request into the diff/bare branches.
    expect(classifyEditorOpen({ filepath: 'notes.txt', file_ws: external })).toBe('file')
    expect(classifyEditorOpen({ file_ws: external })).toBe('bare')
  })
})


describe('Host Mini-IDE locale authority', () => {
  const extractFunction = (name: string): string => {
    const source = createSourceFile('index.ts', readFileSync(resolve('src/main/index.ts'), 'utf8'), ScriptTarget.Latest, true)
    const statement = source.statements.find(item => isFunctionDeclaration(item) && item.name?.text === name)
    expect(statement).toBeDefined()
    return transpileModule(statement!.getText(source), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  }

  it('routes initial and repeated editor opens through the v2 contribution window', async () => {
    const openCatalogContributionWindow = vi.fn(async () => ({ ok: true }))
    const createSender = new Function(
      'miniIdeRecoveryEnabled',
      'openCatalogContributionWindow',
      'MINI_IDE_CONTRIBUTION',
      'resolveExternalOpenTarget',
      'refuseDisabledBuiltin',
      'MINI_IDE_PLUGIN_ID',
      `${extractFunction('openMiniIdeEditor')}\nreturn openMiniIdeEditor`,
    )
    const openEditor = createSender(
      false, openCatalogContributionWindow, 'navide.mini-ide.window', () => null, () => false, 'navide.mini-ide',
    )
    await expect(openEditor(null, { workspace_path: '/ws', filepath: 'a.ts', locale: 'en-US' })).resolves.toBe(true)
    expect(openCatalogContributionWindow).toHaveBeenLastCalledWith(
      'navide.mini-ide.window',
      '/ws',
      { filepath: 'a.ts', locale: 'en-US' },
      undefined,
      expect.any(Function),
    )
  })

  it('refuses every editor open, with its reason, while the Mini-IDE is disabled', async () => {
    const openCatalogContributionWindow = vi.fn(async () => ({ ok: true }))
    const refuse = vi.fn((pluginId: string) => pluginId === 'navide.mini-ide')
    const createSender = new Function(
      'miniIdeRecoveryEnabled',
      'openCatalogContributionWindow',
      'MINI_IDE_CONTRIBUTION',
      'resolveExternalOpenTarget',
      'refuseDisabledBuiltin',
      'MINI_IDE_PLUGIN_ID',
      `${extractFunction('openMiniIdeEditor')}\nreturn openMiniIdeEditor`,
    )
    // Recovery on: not even the legacy copy may open.
    const openEditor = createSender(
      true, openCatalogContributionWindow, 'navide.mini-ide.window', () => null, refuse, 'navide.mini-ide',
    )
    await expect(openEditor(null, { workspace_path: '/ws', filepath: 'a.ts' })).resolves.toBe(false)
    expect(refuse).toHaveBeenCalledWith('navide.mini-ide', null)
    expect(openCatalogContributionWindow).not.toHaveBeenCalled()
  })

  it('keeps the current Host locale authoritative over the caller locale in the entry query', () => {
    let hostLocale = 'ja-JP'
    const createQuery = new Function(
      'composePluginContributionQuery',
      'currentUiTheme',
      'currentUiLocale',
      'backend',
      'currentGitReadOnlyQuery',
      `${extractFunction('catalogContributionQuery')}\nreturn catalogContributionQuery`,
    )
    const catalogQuery = createQuery(composePluginContributionQuery, () => 'dark', () => hostLocale, null, () => ({}))
    const first = new URLSearchParams(catalogQuery('navide.mini-ide.window', '/ws', { filepath: 'a.ts', locale: 'en-US' }))
    expect(first.get('locale')).toBe('ja-JP')
    expect(first.get('filepath')).toBe('a.ts')
    hostLocale = 'en-US'
    const second = new URLSearchParams(catalogQuery('navide.mini-ide.window', '/ws', { filepath: 'b.ts', locale: 'ja-JP' }))
    expect(second.get('locale')).toBe('en-US')
  })
})

// #641 M1: a window that opened without its native backend says so in the main
// window, and openCatalogContributionWindow is the only way that reason (and
// the gate that refused) gets from the manager to the renderer. The field is
// optional, so dropping it here would type-check and fail silently.
describe('openCatalogContributionWindow forwards a missing native backend', () => {
  const extract = (name: string): string => {
    const source = createSourceFile('index.ts', readFileSync(resolve('src/main/index.ts'), 'utf8'), ScriptTarget.Latest, true)
    const statement = source.statements.find(item => isFunctionDeclaration(item) && item.name?.text === name)
    expect(statement).toBeDefined()
    return transpileModule(statement!.getText(source), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  }

  const open = (managerResult: Record<string, unknown>) => {
    class FakeWindow {
      id = 1
      isDestroyed(): boolean { return false }
      once(): void {}
      isMinimized(): boolean { return false }
      restore(): void {}
      show(): void {}
      focus(): void {}
      close(): void {}
    }
    const manager = {
      listContributionCatalog: () => [{ contributionKey: 'acme.map.main', location: 'window', title: 'Map' }],
      peekWorkspaceDisplayName: async () => 'ws',
      openContributionWindow: vi.fn(async () => managerResult),
      closeContribution: () => undefined,
    }
    const create = new Function(
      'prepareCatalogContribution',
      'MINI_IDE_CONTRIBUTION',
      'frontendPluginManager',
      'getContributionWindowKey',
      'normalizeWorkspacePath',
      'contributionWindows',
      'BrowserWindow',
      'getContributionWindowConfig',
      'windowCloseCoordinator',
      'catalogContributionQuery',
      'warnMain',
      'AUX_KIND_BY_CONTRIBUTION',
      'trackAuxWindow',
      'windowRegistry',
      `${extract('openCatalogContributionWindow')}\nreturn openCatalogContributionWindow`,
    )
    const fn = create(
      async () => true,
      'navide.mini-ide.window',
      manager,
      (key: string, workspace: string) => `${key}\n${workspace}`,
      (path: string) => path,
      new Map(),
      FakeWindow,
      () => ({}),
      { watch: () => undefined },
      () => '',
      () => undefined,
      {},
      () => undefined,
      { setAuxWorkspace: () => undefined },
    )
    return fn('acme.map.main', '/ws') as Promise<Record<string, unknown>>
  }

  it('passes the reason and the refusing gate on', async () => {
    await expect(open({ ok: true, backendUnavailable: 'the user did not allow the native backend', backendUnavailableStatus: 'needs-consent' }))
      .resolves.toEqual({ ok: true, backendUnavailable: 'the user did not allow the native backend', backendUnavailableStatus: 'needs-consent' })
  })

  it('adds nothing when the backend bound', async () => {
    await expect(open({ ok: true })).resolves.toEqual({ ok: true })
  })
})
