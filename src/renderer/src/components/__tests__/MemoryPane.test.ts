// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import MemoryPane from '../MemoryPane.vue'

const WORKSPACE = '/Users/x/proj'

const files = [
  {
    scope: 'user',
    path: '/Users/x/.claude/CLAUDE.md',
    relative: '.claude/CLAUDE.md',
    readers: ['claude', 'kilo', 'opencode'],
    canonical: true,
    exists: true,
    size: 2048,
    modified: 1756339200,
    error: '',
  },
  {
    scope: 'user',
    path: '/Users/x/.grok/AGENTS.md',
    relative: '.grok/AGENTS.md',
    readers: ['grok'],
    canonical: true,
    exists: false,
    size: 0,
    modified: 0,
    error: '',
  },
  {
    scope: 'project',
    path: '/Users/x/proj/AGENTS.md',
    relative: 'AGENTS.md',
    readers: ['codex', 'cursor'],
    canonical: true,
    exists: true,
    size: 512,
    modified: 1756339200,
    error: '',
  },
]

const agents = [
  { agent: 'claude', label: 'Claude Code', state: 'mapped', scopes: ['project', 'user'] },
  { agent: 'codex', label: 'Codex', state: 'mapped', scopes: ['project', 'user'] },
  { agent: 'aider', label: 'Aider', state: 'configured', scopes: ['user', 'project'] },
]

/** A file no CLI names on its own: aider loads it because .aider.conf.yml's
 *  `read:` key points at it, and it must be listed like any other. */
const aiderFile = {
  scope: 'project',
  path: '/Users/x/proj/docs/style.md',
  relative: 'docs/style.md',
  readers: ['aider'],
  canonical: false,
  exists: true,
  size: 128,
  modified: 1756339200,
  error: '',
}

interface Overrides {
  list?: Record<string, unknown>
  get?: Record<string, unknown>
  save?: Record<string, unknown>
  restore?: Record<string, unknown>
}

function mockBackend(overrides: Overrides = {}) {
  const send = vi.fn(async (type: string, _payload?: unknown) => {
    if (type === 'memory.get') {
      return (
        overrides.get ?? {
          ok: true,
          payload: { path: '', text: '# hello', exists: true, modified: 1756339200 },
        }
      )
    }
    if (type === 'memory.save') {
      return overrides.save ?? { ok: true, payload: { path: '', size: 7, modified: 1756339999 } }
    }
    if (type === 'memory.restore') {
      return overrides.restore ?? { ok: true, payload: { path: '', size: 5, modified: 1756340500 } }
    }
    return (
      overrides.list ?? {
        ok: true,
        payload: { files, agents, workspace_path: WORKSPACE },
      }
    )
  })
  return { backend: { send } as never, send }
}

async function mountPane(backend: never, workspacePath = WORKSPACE): Promise<VueWrapper> {
  const wrapper = mount(MemoryPane, {
    props: { backend, workspacePath },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

function rowFor(wrapper: VueWrapper, relative: string) {
  const row = wrapper
    .findAll('.memory-row')
    .find((r) => r.find('.memory-relative').text() === relative)
  if (!row) throw new Error(`no row for ${relative}`)
  return row
}

async function clickEditorButton(wrapper: VueWrapper, label: string): Promise<void> {
  const button = wrapper
    .findAll('.memory-editor button')
    .find((b) => b.text() === label)
  if (!button) throw new Error(`no editor button labelled ${label}`)
  await button.trigger('click')
  await flushPromises()
}

async function openRow(wrapper: VueWrapper, relative: string): Promise<void> {
  await rowFor(wrapper, relative).find('.memory-open').trigger('click')
  await flushPromises()
}

describe('MemoryPane', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('lists the files of both scopes under their own group', async () => {
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)

    expect(send).toHaveBeenCalledWith('memory.list', { workspace_path: WORKSPACE })
    const groups = wrapper.findAll('.memory-group')
    expect(groups[0].find('.memory-group-title').text()).toContain('User level')
    expect(groups[0].findAll('.memory-relative').map((el) => el.text())).toEqual([
      '.claude/CLAUDE.md',
      '.grok/AGENTS.md',
    ])
    expect(groups[1].find('.memory-group-title').text()).toContain('Project level')
    expect(groups[1].findAll('.memory-relative').map((el) => el.text())).toEqual(['AGENTS.md'])
  })

  it('shows every CLI that reads a file on its row', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)

    const readers = rowFor(wrapper, '.claude/CLAUDE.md')
      .findAll('.memory-readers .rchip')
      .map((el) => el.text())
    expect(readers).toEqual(['claude', 'kilo', 'opencode'])
  })

  it('marks a file that does not exist yet and offers to create it', async () => {
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)

    const row = rowFor(wrapper, '.grok/AGENTS.md')
    expect(row.classes()).toContain('missing')
    expect(row.find('.memory-tag.missing').text()).toBe('Not created')

    await row.find('.memory-create').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('memory.get', {
      path: '/Users/x/.grok/AGENTS.md',
      workspace_path: WORKSPACE,
    })
    expect(wrapper.find('.memory-editor').exists()).toBe(true)
    expect(wrapper.find('.memory-editor-hint').text()).toContain('does not exist yet')
  })

  it('creates a file with expected_modified 0 so two windows cannot both create it', async () => {
    const { backend, send } = mockBackend({
      get: { ok: true, payload: { path: '', text: '', exists: false } },
    })
    wrapper = await mountPane(backend)
    await rowFor(wrapper, '.grok/AGENTS.md').find('.memory-create').trigger('click')
    await flushPromises()
    await wrapper.find('.memory-editor-text').setValue('# new')
    await clickEditorButton(wrapper, 'Save')

    expect(send).toHaveBeenCalledWith('memory.save', {
      path: '/Users/x/.grok/AGENTS.md',
      text: '# new',
      expected_modified: 0,
      workspace_path: WORKSPACE,
    })
  })

  it('says the project scope needs an open folder instead of showing nothing', async () => {
    const { backend, send } = mockBackend({
      list: { ok: true, payload: { files: files.slice(0, 2), agents, workspace_path: '' } },
    })
    wrapper = await mountPane(backend, '')

    expect(send).toHaveBeenCalledWith('memory.list', { workspace_path: '' })
    const groups = wrapper.findAll('.memory-group')
    expect(groups[1].find('.memory-group-note').text()).toContain('No folder is open')
  })

  it('loads a file into the editor and saves the edited text back to its path', async () => {
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')

    const textarea = wrapper.find('.memory-editor-text')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('# hello')
    expect(wrapper.find('.memory-tag.unsaved').exists()).toBe(false)

    await textarea.setValue('# hello world')
    expect(wrapper.find('.memory-tag.unsaved').text()).toBe('Unsaved changes')

    await clickEditorButton(wrapper, 'Save')

    expect(send).toHaveBeenCalledWith('memory.save', {
      path: '/Users/x/proj/AGENTS.md',
      text: '# hello world',
      expected_modified: 1756339200,
      workspace_path: WORKSPACE,
    })
    // The list is re-read after a save, and the draft is clean again.
    expect(send.mock.calls.filter((call) => call[0] === 'memory.list')).toHaveLength(2)
    expect(wrapper.find('.memory-tag.unsaved').exists()).toBe(false)

    // A second save carries the mtime the first one returned, not the stale
    // one from the read — otherwise the user conflicts with their own write.
    await wrapper.find('.memory-editor-text').setValue('# again')
    await clickEditorButton(wrapper, 'Save')
    expect(send).toHaveBeenLastCalledWith('memory.list', { workspace_path: WORKSPACE })
    expect(send.mock.calls.filter((call) => call[0] === 'memory.save')[1][1]).toEqual({
      path: '/Users/x/proj/AGENTS.md',
      text: '# again',
      expected_modified: 1756339999,
      workspace_path: WORKSPACE,
    })
  })

  it('keeps the draft and explains the clash when the file changed underneath', async () => {
    const { backend } = mockBackend({
      save: {
        ok: false,
        error: { code: 'MEMORY_FILE_CONFLICT', message: 'the file changed on disk' },
      },
    })
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')
    await wrapper.find('.memory-editor-text').setValue('# mine')
    await clickEditorButton(wrapper, 'Save')

    const banner = wrapper.find('.memory-conflict')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('changed this file while you were editing it')
    // The draft survives: only the user may throw it away.
    expect((wrapper.find('.memory-editor-text').element as HTMLTextAreaElement).value).toBe('# mine')
    expect(wrapper.find('.memory-tag.unsaved').exists()).toBe(true)
  })

  it('re-reads the file only when the user asks, and says the draft goes', async () => {
    const { backend, send } = mockBackend({
      save: {
        ok: false,
        error: { code: 'MEMORY_FILE_CONFLICT', message: 'the file changed on disk' },
      },
    })
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')
    await wrapper.find('.memory-editor-text').setValue('# mine')
    await clickEditorButton(wrapper, 'Save')

    await clickEditorButton(wrapper, 'Reload from Disk (Discards Your Draft)')
    expect(send.mock.calls.filter((call) => call[0] === 'memory.get')).toHaveLength(2)
    expect((wrapper.find('.memory-editor-text').element as HTMLTextAreaElement).value).toBe('# hello')
    expect(wrapper.find('.memory-conflict').exists()).toBe(false)
  })

  it('leaves the editor with the draft in it when a save fails', async () => {
    const { backend } = mockBackend({
      save: { ok: false, error: { code: 'MEMORY_WRITE_FAILED', message: 'permission denied' } },
    })
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')
    await wrapper.find('.memory-editor-text').setValue('# nope')

    await clickEditorButton(wrapper, 'Save')

    expect(wrapper.find('.memory-error').text()).toBe('permission denied')
    expect((wrapper.find('.memory-editor-text').element as HTMLTextAreaElement).value).toBe('# nope')
  })

  it('cancelling closes the editor without saving', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')
    await wrapper.find('.memory-editor-text').setValue('# discarded')

    await clickEditorButton(wrapper, 'Cancel')

    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes to AGENTS.md?')
    expect(wrapper.find('.memory-editor').exists()).toBe(false)
    expect(send.mock.calls.some((call) => call[0] === 'memory.save')).toBe(false)
  })

  it('closes a clean editor without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')

    await clickEditorButton(wrapper, 'Cancel')

    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.find('.memory-editor').exists()).toBe(false)
  })

  it('keeps the draft when the user declines to discard it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')
    await wrapper.find('.memory-editor-text').setValue('# keep me')

    await clickEditorButton(wrapper, 'Cancel')
    await wrapper.find('.memory-editor-close').trigger('click')
    await openRow(wrapper, '.claude/CLAUDE.md')

    expect(confirm).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.filter((call) => call[0] === 'memory.get')).toHaveLength(1)
    expect((wrapper.find('.memory-editor-text').element as HTMLTextAreaElement).value).toBe('# keep me')
    // Settings asks the same question before it closes.
    expect((wrapper.vm as unknown as { confirmDiscard(): boolean }).confirmDiscard()).toBe(false)
  })

  it('offers the kept previous version and restores it in one click', async () => {
    const { backend, send } = mockBackend({
      get: {
        ok: true,
        payload: {
          path: '',
          text: '# hello',
          exists: true,
          modified: 1756339200,
          previous: { saved_at: 1756339100, size: 5 },
        },
      },
    })
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')

    const kept = wrapper.find('.memory-previous')
    expect(kept.exists()).toBe(true)
    expect(kept.text()).toContain("in Navide's own folder")
    await clickEditorButton(wrapper, 'Restore Previous Version')

    expect(send).toHaveBeenCalledWith('memory.restore', {
      path: '/Users/x/proj/AGENTS.md',
      expected_modified: 1756339200,
      workspace_path: WORKSPACE,
    })
    // The editor re-reads the restored file and the list is refreshed.
    expect(send.mock.calls.filter((call) => call[0] === 'memory.get')).toHaveLength(2)
    expect(send).toHaveBeenLastCalledWith('memory.list', { workspace_path: WORKSPACE })
  })

  it('shows no restore offer when nothing was kept', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')

    expect(wrapper.find('.memory-previous').exists()).toBe(false)
  })

  it('keeps the draft and explains the clash when a restore meets a changed file', async () => {
    const { backend } = mockBackend({
      get: {
        ok: true,
        payload: {
          path: '',
          text: '# hello',
          exists: true,
          modified: 1756339200,
          previous: { saved_at: 1756339100, size: 5 },
        },
      },
      restore: {
        ok: false,
        error: { code: 'MEMORY_FILE_CONFLICT', message: 'the file changed on disk' },
      },
    })
    wrapper = await mountPane(backend)
    await openRow(wrapper, 'AGENTS.md')

    await clickEditorButton(wrapper, 'Restore Previous Version')

    expect(wrapper.find('.memory-conflict').exists()).toBe(true)
  })

  it('keeps a mapped CLI apart from one whose files its own config names', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)

    const groups = wrapper.findAll('.memory-agent-group')
    expect(
      groups.map((group) => [
        group.attributes('data-state'),
        group.findAll('.rchip').map((el) => el.text()),
      ]),
    ).toEqual([
      ['mapped', ['Claude Code', 'Codex']],
      ['configured', ['Aider']],
    ])
    expect(groups[1].find('.memory-agent-state').text()).toContain('.aider.conf.yml')
  })

  it('lists and edits a file named only by a CLI config like .aider.conf.yml', async () => {
    const { backend, send } = mockBackend({
      list: {
        ok: true,
        payload: { files: [...files, aiderFile], agents, workspace_path: WORKSPACE },
      },
    })
    wrapper = await mountPane(backend)

    const row = rowFor(wrapper, 'docs/style.md')
    expect(row.findAll('.memory-readers .rchip').map((el) => el.text())).toEqual(['aider'])
    expect(row.classes()).not.toContain('missing')

    await openRow(wrapper, 'docs/style.md')
    await wrapper.find('.memory-editor-text').setValue('# style')
    await clickEditorButton(wrapper, 'Save')

    expect(send).toHaveBeenCalledWith('memory.save', {
      path: '/Users/x/proj/docs/style.md',
      text: '# style',
      expected_modified: 1756339200,
      workspace_path: WORKSPACE,
    })
  })

  it('surfaces a failed listing instead of showing an empty page', async () => {
    const { backend } = mockBackend({ list: { ok: false, error: { message: 'backend down' } } })
    wrapper = await mountPane(backend)

    expect(wrapper.find('.memory-error').text()).toBe('backend down')
  })
})
